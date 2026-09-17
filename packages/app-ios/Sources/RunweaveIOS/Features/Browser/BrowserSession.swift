import SwiftUI
import WebKit

@MainActor
final class BrowserSession: ObservableObject {
  enum State { case empty, presented, collapsed }
  struct Prompt: Identifiable {
    enum Kind {
      case replace(URL)
      case close, clear
      case address(String)
      case application(BrowserURLPolicy.ApplicationLink)
      case message
    }
    let id = UUID()
    let kind: Kind
    let message: String
    let source: BrowserSourceScope
    let identity: UUID?
    let navigationRevision: Int?
    let lifetime: UUID
  }

  @Published private(set) var state: State = .empty
  @Published private(set) var page: BrowserPage?
  @Published private(set) var clearing = false
  @Published var prompt: Prompt?
  @Published private(set) var dataStatus: String?
  var currentSource: (() -> BrowserSourceScope?)?
  private let store = WKWebsiteDataStore.default()
  private var lifetime = UUID()
  private struct TerminalPresentation {
    let id: UUID
    let source: BrowserSourceScope
    let controllerID: ObjectIdentifier
    let isAvailable: () -> Bool
  }
  private var terminalPresentation: TerminalPresentation?

  func registerTerminalPresentation(
    id: UUID, source: BrowserSourceScope, controllerID: ObjectIdentifier,
    isAvailable: @escaping () -> Bool
  ) {
    guard valid(source) else { return }
    terminalPresentation = TerminalPresentation(
      id: id, source: source, controllerID: controllerID, isAvailable: isAvailable)
  }

  func unregisterTerminalPresentation(id: UUID, controllerID: ObjectIdentifier) {
    guard terminalPresentation?.id == id, terminalPresentation?.controllerID == controllerID else {
      return
    }
    terminalPresentation = nil
  }

  func terminalPresentationAvailable(source: BrowserSourceScope, registrationID: UUID) -> Bool {
    guard valid(source), let registration = terminalPresentation,
      registration.id == registrationID, registration.source == source
    else { return false }
    return registration.isAvailable()
  }
  // Retain every closing page until its controlled blank document finishes. SwiftUI may
  // still retain its UIView; removal from the visible session is not an unload barrier.
  @Published private var retiringPages: [UUID: BrowserPage] = [:]

  func valid(_ source: BrowserSourceScope, identity: UUID? = nil) -> Bool {
    guard currentSource?() == source else { return false }
    return identity == nil || page?.id == identity
  }

  func isCurrent(_ candidate: BrowserPage) -> Bool {
    !clearing && page === candidate && valid(candidate.source, identity: candidate.id)
  }

  func open(_ intent: BrowserOpenIntent, source: BrowserSourceScope, presentationAvailable: Bool) {
    guard valid(source, identity: intent.sessionIdentity), !clearing else { return }
    guard retiringPages.isEmpty else {
      dataStatus = "旧网页尚未安全卸载，不能打开新网页。若卸载失败，请重启应用后重试。"
      return
    }
    if intent.origin == .page {
      // Native Menu owns its dismissal/presentation transition. Treating it as
      // a competing modal drops the user's action while the menu is still open.
      guard intent.sessionIdentity != nil, state == .presented
      else { return }
    }
    guard presentationAvailable else {
      dataStatus = "请先完成当前输入、媒体或系统操作，再打开网页。"
      return
    }
    dataStatus = nil
    // Disclose the original target before copying, even for a rejected OSC 8 link.
    // Only navigation must pass the web policy.
    switch intent.action {
    case .link:
      setPrompt(.address(intent.target), message: intent.target, source: source)
      return
    case .internalOpen, .externalOpen: break
    }
    guard case .web(let url) = BrowserURLPolicy.classify(intent.target) else {
      if case .denied(let reason) = BrowserURLPolicy.classify(intent.target) {
        message(reason, source: source)
      }
      return
    }
    switch intent.action {
    case .link: break
    case .externalOpen: openExternal(url, source: source, identity: intent.sessionIdentity)
    case .internalOpen:
      if let page {
        guard page.source == source else { return }
        if page.currentURL.absoluteString == url.absoluteString {
          resume()
          return
        }
        setPrompt(.replace(url), message: "替换当前网页？未提交内容可能丢失。", source: source)
      } else {
        create(url, source: source)
      }
    }
  }

  private func create(_ url: URL, source: BrowserSourceScope) {
    guard !clearing, valid(source), case .web = BrowserURLPolicy.classify(url.absoluteString) else {
      return
    }
    guard let presentation = terminalPresentation, presentation.source == source else {
      dataStatus = "终端当前不可呈现网页，请返回终端后主动重试。"
      return
    }
    let presentationID = presentation.id
    invalidate()
    let expectedLifetime = lifetime
    Task { [weak self] in
      guard let self, await self.waitForRetiredPages(), self.lifetime == expectedLifetime,
        self.valid(source), !self.clearing, self.page == nil
      else { return }
      // This is a live TerminalScreen query, not the Bool captured at the first open.
      // No suspension occurs from this check through construction and load.
      guard self.terminalPresentationAvailable(source: source, registrationID: presentationID)
      else {
        self.dataStatus = "请先完成当前输入、媒体或系统操作，再主动重新打开网页。"
        return  // Drop the intent; becoming available later must not replay it.
      }
      self.dataStatus = nil
      let next = BrowserPage(url: url, source: source, store: self.store, owner: self)
      self.page = next
      self.state = .presented
      next.load(url)
    }
  }

  func resume() {
    guard let page, isCurrent(page) else { return }
    state = .presented
  }

  func collapse() {
    guard let page, isCurrent(page) else { return }
    state = .collapsed
    cancelApplicationRequest()
    page.cancelJavaScriptDialog()
    page.webView.endEditing(true)
  }

  /// Invalidates callbacks synchronously, then retires the document without clearing identity.
  func invalidate() {
    lifetime = UUID()
    let previous = page
    page = nil
    state = .empty
    prompt = nil
    previous?.cancelJavaScriptDialog()
    if let previous {
      retiringPages[previous.id] = previous
      dataStatus = "正在安全卸载旧网页…"
      Task { [weak self] in
        let unloaded = await previous.unload()
        guard let self else { return }
        if unloaded {
          self.retiringPages.removeValue(forKey: previous.id)
          // A later retirement waiter must not erase the create task's retry-required notice.
          if !self.clearing && self.retiringPages.isEmpty && self.dataStatus == "正在安全卸载旧网页…" {
            self.dataStatus = nil
          }
        } else {
          self.dataStatus = "无法确认旧网页已安全卸载，未清除网站数据。请重启应用后重试。"
        }
      }
    }
  }

  private func waitForRetiredPages() async -> Bool {
    for retired in Array(retiringPages.values) {
      guard await retired.unload() else { return false }
      retiringPages.removeValue(forKey: retired.id)
    }
    return retiringPages.isEmpty
  }

  func changed(_ candidate: BrowserPage) {
    guard isCurrent(candidate) else { return }
    objectWillChange.send()
  }

  func message(_ text: String, source: BrowserSourceScope) {
    setPrompt(.message, message: text, source: source)
  }

  func request(_ kind: Prompt.Kind, message: String) {
    guard let page, isCurrent(page), state == .presented else { return }
    if case .application = kind { dataStatus = nil }
    setPrompt(kind, message: message, source: page.source)
  }

  func cancelApplicationRequest() {
    if case .application = prompt?.kind { prompt = nil }
  }

  private func setPrompt(_ kind: Prompt.Kind, message: String, source: BrowserSourceScope) {
    guard valid(source), !clearing else { return }
    prompt = Prompt(
      kind: kind, message: message, source: source, identity: page?.id,
      navigationRevision: page?.navigationRevision, lifetime: lifetime)
  }

  func confirm(_ value: Prompt) {
    // Do not deliver an old source's UI into a different connection/terminal.
    guard valid(value.source), !clearing else { return }
    guard value.lifetime == lifetime, page?.id == value.identity else {
      dataStatus = "网页会话已变化，请重新操作。"
      return
    }
    prompt = nil
    switch value.kind {
    case .close, .clear: break  // A page cannot defeat these actions by continuously changing URL.
    case .replace, .address, .message, .application:
      guard page?.navigationRevision == value.navigationRevision else {
        dataStatus = "网页地址已变化，请重新选择操作。"
        return
      }
    }
    switch value.kind {
    case .replace(let url): create(url, source: value.source)
    case .close: invalidate()
    case .clear: clearData()
    case .address(let target): UIPasteboard.general.string = target
    case .application(let link): page?.openApplication(link)
    case .message: break
    }
  }

  func openExternal(
    _ url: URL, source: BrowserSourceScope, identity: UUID?
  ) {
    guard valid(source, identity: identity), !clearing else { return }
    switch BrowserURLPolicy.classify(url.absoluteString) {
    case .web: break
    default:
      message("不能打开此链接。", source: source)
      return
    }
    let expectedLifetime = lifetime
    let expectedIdentity = page?.id
    let revision = page?.navigationRevision
    UIApplication.shared.open(url, options: [:]) { [weak self] success in
      Task { @MainActor in
        guard let self, self.lifetime == expectedLifetime, self.valid(source),
          self.page?.id == expectedIdentity,
          self.page?.navigationRevision == revision, !self.clearing
        else { return }
        if success {
          self.collapse()
        } else {
          self.message("系统无法打开此链接。请复制地址后手动继续。", source: source)
        }
      }
    }
  }

  private func clearData() {
    guard !clearing else { return }
    clearing = true
    invalidate()
    dataStatus = "正在卸载全部旧网页，尚未开始清除网站数据…"
    Task { [weak self] in
      guard let self else { return }
      guard await self.waitForRetiredPages() else {
        self.clearing = false
        self.dataStatus = "旧网页卸载失败，未开始清除网站数据。请重启应用后重试。"
        return
      }
      self.dataStatus = "正在清除本机全部内置网站数据…"
      // No retired document can execute when deletion starts. The retiring page's delegate
      // still rejects navigation even if SwiftUI retains its now-blank UIView after this point.
      // WebKit has no error-bearing deletion API, so verify records after its callback.
      let types = WKWebsiteDataStore.allWebsiteDataTypes()
      self.store.removeData(ofTypes: types, modifiedSince: .distantPast) { [weak self] in
        Task { @MainActor in
          guard let self else { return }
          self.store.fetchDataRecords(ofTypes: types) { [weak self] records in
            Task { @MainActor in
              guard let self else { return }
              self.clearing = false
              self.dataStatus = records.isEmpty ? "已清除本机内置网站数据。" : "未能完全清除网页数据，请重新打开网页后重试。"
            }
          }
        }
      }
    }
  }
}
