import SwiftUI
import WebKit

/// The only live browser view belongs to BrowserSession, never to a SwiftUI render pass.
@MainActor
final class BrowserPage: NSObject, Identifiable, WKNavigationDelegate, WKUIDelegate {
  let id = UUID()
  let localPreview: BrowserLocalPreview?
  let source: BrowserContext
  let webView: WKWebView
  private weak var owner: BrowserSession?
  private var observations: [NSKeyValueObservation] = []
  private var navigation: WKNavigation?
  private var requestedURL: URL
  private enum Retirement { case active, unloading, unloaded, failed }
  private var retirement: Retirement = .active
  private var retirementNavigation: WKNavigation?
  private var blankActionAvailable = false
  private var blankCommitted = false
  private var unloadWaiters: [CheckedContinuation<Bool, Never>] = []
  private var unloadTimeout: Task<Void, Never>?
  private static let blankURL = URL(string: "about:blank")!
  private static let localPreviewNoticeShownKey = "runweave.browser.localPreviewNoticeShown"
  private(set) var navigationRevision = 0
  private(set) var currentURL: URL
  private(set) var failure: String?
  private(set) var failureURL: URL?
  private(set) var notice: String?
  var exportURL: URL {
    let value = failureURL ?? currentURL
    guard let localPreview, localPreview.allows(value),
      var components = URLComponents(url: value, resolvingAgainstBaseURL: false),
      let original = URLComponents(url: localPreview.originalURL, resolvingAgainstBaseURL: false) else { return value }
    components.scheme = original.scheme; components.host = original.host; components.port = original.port
    return components.url ?? value
  }
  var title: String { webView.title.flatMap { $0.isEmpty ? nil : $0 } ?? currentURL.host ?? "网页" }
  private var javaScriptDialog: UIAlertController?
  private var javaScriptReply: ((String?) -> Void)?

  private var presentationController: UIViewController? {
    guard webView.window != nil else { return nil }
    var responder: UIResponder? = webView
    while let current = responder {
      if let controller = current as? UIViewController {
        var ancestor: UIViewController? = controller
        while let candidate = ancestor {
          if candidate.presentedViewController != nil || candidate.isBeingDismissed { return nil }
          ancestor = candidate.parent
        }
        return controller
      }
      responder = current.next
    }
    return nil
  }

  private enum JavaScriptDialogKind { case alert, confirm, prompt(String) }

  private func presentJavaScriptDialog(
    _ kind: JavaScriptDialogKind, message: String, frame: WKFrameInfo,
    completion: @escaping (String?) -> Void
  ) {
    guard valid, owner?.state == .presented, owner?.prompt == nil,
      UIApplication.shared.applicationState == .active, javaScriptReply == nil,
      let presenter = presentationController
    else {
      if valid {
        notice = "网页对话框因当前界面忙或网页已收起而取消，请返回网页后重试。"
        changed()
      }
      completion(nil)
      return
    }
    // Attribute subframe dialogs to the requesting origin, never to page-supplied text.
    let origin = frame.securityOrigin
    let website = origin.host.isEmpty ? "不透明来源" : "\(origin.protocol)://\(origin.host)"
    let dialog = UIAlertController(title: "网页提示 · \(website)", message: message, preferredStyle: .alert)
    if case .prompt(let text) = kind {
      dialog.addTextField { field in field.text = text }
    }
    if case .alert = kind {} else {
      dialog.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in
        self?.finishJavaScriptDialog(nil, animated: true)
      })
    }
    dialog.addAction(UIAlertAction(title: "确定", style: .default) { [weak self, weak dialog] _ in
      let result: String
      if case .prompt = kind { result = dialog?.textFields?.first?.text ?? "" }
      else { result = "" }
      self?.finishJavaScriptDialog(result, animated: true)
    })
    let revision = navigationRevision
    javaScriptReply = { [weak self] result in
      guard let self, self.valid, self.owner?.state == .presented,
        self.navigationRevision == revision else { completion(nil); return }
      completion(result)
    }
    javaScriptDialog = dialog
    presenter.present(dialog, animated: true)
  }

  private func finishJavaScriptDialog(_ result: String?, animated: Bool = false) {
    let reply = javaScriptReply
    let dialog = javaScriptDialog
    javaScriptReply = nil
    javaScriptDialog = nil
    if animated, let dialog {
      // Resume JS after dismissal so a following dialog can use the same presenter.
      dialog.dismiss(animated: true) { reply?(result) }
    } else {
      dialog?.dismiss(animated: false)
      reply?(result)
    }
  }

  func cancelJavaScriptDialog() { finishJavaScriptDialog(nil) }

  private func classify(_ raw: String) -> BrowserURLPolicy.Decision {
    let allowed = URL(string: raw).map { localPreview?.allows($0) == true } ?? false
    return BrowserURLPolicy.classify(raw, allowLocal: allowed)
  }

  private func requestApplication(_ link: BrowserURLPolicy.ApplicationLink, frame: WKFrameInfo) {
    guard valid, owner?.state == .presented, owner?.prompt == nil, javaScriptReply == nil,
      UIApplication.shared.applicationState == .active, presentationController != nil
    else { return }
    let origin = frame.securityOrigin
    guard origin.protocol == "https", !origin.host.isEmpty else {
      notice = "请从 HTTPS 网页打开客户端。"
      changed()
      return
    }
    // Scripted links and subframes may request a handoff, but only native confirmation opens it.
    // Do not disclose the URL query: login links can carry an authorization token.
    owner?.request(.application(link),
      message: "网站 \(origin.host) 请求打开\(link.name)。如需登录，请在客户端完成授权后返回\(owner?.configuration.applicationName ?? "应用")，当前网页会保留。")
  }

  func openApplication(_ link: BrowserURLPolicy.ApplicationLink) {
    guard valid, owner?.state == .presented,
      UIApplication.shared.applicationState == .active,
      BrowserURLPolicy.applicationLink(link.url) != nil else { return }
    let revision = navigationRevision
    let options: [UIApplication.OpenExternalURLOptionsKey: Any] =
      link.universalLink ? [.universalLinksOnly: true] : [:]
    Task { @MainActor [weak self] in
      guard let self, self.valid, self.navigationRevision == revision,
        self.owner?.state == .presented,
        UIApplication.shared.applicationState == .active else { return }
      var success = await UIApplication.shared.open(link.url, options: options)
      guard self.valid, self.navigationRevision == revision else { return }
      if !success, let fallback = link.schemeFallback {
        // An installed client may not handle this host's Universal Link. Use the
        // equivalent client scheme only for the already-confirmed, allowlisted route.
        guard self.owner?.state == .presented,
          UIApplication.shared.applicationState == .active else { return }
        success = await UIApplication.shared.open(fallback, options: [:])
      }
      guard self.valid, self.navigationRevision == revision else { return }
      // Preserve the original document and its authorization polling, including on return.
      self.notice = success
        ? "已打开\(link.name)。完成授权后，请返回\(self.owner?.configuration.applicationName ?? "应用") 继续浏览。"
        : "无法打开\(link.name)。请确认已安装客户端，或从右上角“…”在默认浏览器继续。"
      self.changed()
    }
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    presentJavaScriptDialog(.alert, message: message, frame: frame) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    presentJavaScriptDialog(.confirm, message: message, frame: frame) { completionHandler($0 != nil) }
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
    defaultText: String?, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping (String?) -> Void) {
    presentJavaScriptDialog(.prompt(defaultText ?? ""), message: prompt, frame: frame,
      completion: completionHandler)
  }

  init(url: URL, source: BrowserContext, store: WKWebsiteDataStore, owner: BrowserSession, localPreview: BrowserLocalPreview? = nil) {
    self.localPreview = localPreview
    self.source = source
    self.owner = owner
    currentURL = url
    requestedURL = url
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = store
    if let rules = localPreview?.rules { configuration.userContentController.add(rules) }
    // Ordinary web JavaScript, with no user scripts, message handlers, cookies or auth bridge.
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    // navigationType is not a trusted user-gesture signal (scripted anchor clicks qualify).
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    webView = WKWebView(frame: .zero, configuration: configuration)
    super.init()
    if let localPreview {
      localPreview.onFailure = { [weak self] message in
        guard let self, self.valid else { return }
        self.notice = message
        self.changed()
      }
    }
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    webView.allowsLinkPreview = false
    webView.accessibilityIdentifier = "browser-web-content"
    observations = [
      webView.observe(\.url, options: [.new]) { [weak self] _, _ in
        Task { @MainActor in self?.updateURL() }
      },
      webView.observe(\.title, options: [.new]) { [weak self] _, _ in
        Task { @MainActor in self?.changed() }
      },
      webView.observe(\.isLoading, options: [.new]) { [weak self] _, _ in
        Task { @MainActor in self?.changed() }
      },
      webView.observe(\.estimatedProgress, options: [.new]) { [weak self] _, _ in
        Task { @MainActor in self?.changed() }
      },
      webView.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in
        Task { @MainActor in self?.changed() }
      },
      webView.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in
        Task { @MainActor in self?.changed() }
      },
    ]
  }

  private var valid: Bool { owner?.isCurrent(self) == true }
  private func changed() { if valid { owner?.changed(self) } }
  private func updateURL() {
    guard valid else { return }
    if let url = webView.url, case .web = classify(url.absoluteString) {
      if currentURL != url { navigationRevision += 1 }
      currentURL = url
    }
    changed()
  }

  func load(_ url: URL) {
    guard valid, case .web = classify(url.absoluteString) else { return }
    cancelJavaScriptDialog()
    failure = nil
    failureURL = nil
    notice = nil
    requestedURL = url
    navigation = webView.load(URLRequest(url: url))
    changed()
  }

  func dismissNotice() {
    guard valid else { return }
    notice = nil
    changed()
  }

  func showLocalPreviewNoticeIfNeeded() {
    guard valid, owner?.state == .presented, notice == nil,
      let localPreview, localPreview.allows(currentURL),
      !UserDefaults.standard.bool(forKey: Self.localPreviewNoticeShownKey) else { return }
    // Record actual presentation, not page construction. This is App-wide education,
    // independent of the current computer, browser session, and temporary website data.
    UserDefaults.standard.set(true, forKey: Self.localPreviewNoticeShownKey)
    notice = localPreview.explanation
    changed()
  }

  func retry() { load(failureURL ?? currentURL) }
  func back() { if valid && webView.canGoBack { navigation = webView.goBack() } }
  func forward() { if valid && webView.canGoForward { navigation = webView.goForward() } }
  func reload() {
    guard valid else { return }
    if failure != nil { retry() } else { navigation = webView.reload() }
  }

  /// A detached WKWebView can still execute its old document while SwiftUI retains it.
  /// Every retired page uses this barrier, not just the page visible at clear-data time.
  func unload() async -> Bool {
    await withCheckedContinuation { continuation in
      switch retirement {
      case .unloaded: continuation.resume(returning: true)
      case .failed: continuation.resume(returning: false)
      case .unloading: unloadWaiters.append(continuation)
      case .active:
        unloadWaiters.append(continuation)
        retirement = .unloading
        cancelJavaScriptDialog()
        owner = nil
        observations.removeAll()
        webView.endEditing(true)
        webView.isUserInteractionEnabled = false
        webView.removeFromSuperview()
        webView.stopLoading()
        navigation = nil
        // Keep both delegates installed: no old-page navigation or popup may escape during
        // or after retirement. Only one host-issued, JavaScript-disabled blank load is allowed.
        blankActionAvailable = true
        retirementNavigation = webView.loadHTMLString(
          "<!doctype html><html><body></body></html>", baseURL: nil)
        guard retirementNavigation != nil else {
          finishUnload(false)
          return
        }
        unloadTimeout = Task { [weak self] in
          try? await Task.sleep(nanoseconds: 30_000_000_000)
          guard !Task.isCancelled else { return }
          // Timeout is failure, never evidence that the old document was destroyed.
          self?.finishUnload(false)
        }
      }
    }
  }

  private func finishUnload(_ succeeded: Bool) {
    guard retirement == .unloading else { return }
    retirement = succeeded ? .unloaded : .failed
    blankActionAvailable = false
    retirementNavigation = nil
    unloadTimeout?.cancel()
    unloadTimeout = nil
    if !succeeded { webView.stopLoading() }
    let waiters = unloadWaiters
    unloadWaiters.removeAll()
    for waiter in waiters { waiter.resume(returning: succeeded) }
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    preferences: WKWebpagePreferences,
    decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
  ) {
    let decide: (WKNavigationActionPolicy) -> Void = { decisionHandler($0, preferences) }
    if retirement != .active {
      preferences.allowsContentJavaScript = false
      let allowBlank =
        retirement == .unloading && blankActionAvailable
        && action.targetFrame?.isMainFrame == true && action.request.url == Self.blankURL
        && action.navigationType == .other && !action.shouldPerformDownload
      if allowBlank { blankActionAvailable = false }
      decide(allowBlank ? .allow : .cancel)
      return
    }
    guard valid, let url = action.request.url else {
      decide(.cancel)
      return
    }
    if !action.shouldPerformDownload, let link = BrowserURLPolicy.applicationLink(url) {
      decide(.cancel)
      requestApplication(link, frame: action.sourceFrame)
      return
    }
    let isSubframe = action.targetFrame?.isMainFrame == false
    if isSubframe, !action.shouldPerformDownload, BrowserURLPolicy.isEmbeddedDocument(url) {
      decide(.allow)
      return
    }
    switch classify(url.absoluteString) {
    case .denied(let reason):
      if !isSubframe {
        notice = reason
        changed()
      }
      decide(.cancel)
    case .web:
      if action.shouldPerformDownload {
        decide(.cancel)
        if !isSubframe { unsupportedDownload(url) }
        return
      }
      if action.targetFrame?.isMainFrame == true {
        navigationRevision += 1
        cancelJavaScriptDialog()
        owner?.cancelApplicationRequest()
        requestedURL = url
        failure = nil
        failureURL = nil
        // Navigation may keep the first explanation visible, but must never recreate it.
        if localPreview?.allows(url) != true || notice != localPreview?.explanation {
          notice = nil
        }
        changed()
      }
      decide(.allow)
    }
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
    decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
  ) {
    if retirement != .active {
      let allowBlank =
        retirement == .unloading && response.isForMainFrame
        && response.response.url == Self.blankURL && response.canShowMIMEType
      decisionHandler(allowBlank ? .allow : .cancel)
      return
    }
    guard valid, let url = response.response.url else {
      decisionHandler(.cancel)
      return
    }
    if !response.isForMainFrame, BrowserURLPolicy.isEmbeddedDocument(url) {
      decisionHandler(response.canShowMIMEType ? .allow : .cancel)
      return
    }
    guard case .web = classify(url.absoluteString) else {
      decisionHandler(.cancel)
      if response.isForMainFrame {
        notice = "此页面地址无法在内置浏览器打开。"
        changed()
      }
      return
    }
    let disposition =
      (response.response as? HTTPURLResponse)?
      .value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
    if !response.canShowMIMEType
      || disposition.trimmingCharacters(in: .whitespaces).hasPrefix("attachment")
    {
      decisionHandler(.cancel)
      if response.isForMainFrame { unsupportedDownload(url) }
    } else {
      decisionHandler(.allow)
    }
  }

  private func unsupportedDownload(_ url: URL) {
    failure = "暂不支持内置下载。请从右上角“更多”复制链接或在默认浏览器打开。"
    failureURL = url
    changed()
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    guard retirement == .active, valid else { return }
    self.navigation = navigation
    changed()
  }
  func webView(
    _ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!
  ) {
    if retirement != .active {
      if retirementNavigation === navigation { finishUnload(false) }
      return
    }
    guard valid, self.navigation === navigation else { return }
    if let url = webView.url {
      guard case .web = classify(url.absoluteString) else {
        webView.stopLoading()
        notice = "已阻止不支持的重定向地址。"
        changed()
        return
      }
      requestedURL = url
    }
    updateURL()
  }
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    if retirement != .active {
      if retirementNavigation === navigation {
        blankCommitted = webView.url == Self.blankURL
        if !blankCommitted { finishUnload(false) }
      }
      return
    }
    guard valid, self.navigation === navigation else { return }
    updateURL()
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if retirement != .active {
      if retirementNavigation === navigation {
        finishUnload(blankCommitted && webView.url == Self.blankURL)
      }
      return
    }
    guard valid, self.navigation === navigation else { return }
    updateURL()
  }
  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    failed(navigation, error: error)
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    failed(navigation, error: error)
  }
  private func failed(_ navigation: WKNavigation?, error: Error) {
    if retirement != .active {
      if retirementNavigation === navigation { finishUnload(false) }
      return
    }
    guard valid, self.navigation === navigation else { return }
    let code = (error as NSError).code
    guard !((error as NSError).domain == NSURLErrorDomain && code == NSURLErrorCancelled) else {
      return
    }
    // Do not expose NSError.userInfo / localized descriptions containing full secret-bearing URLs.
    failure = "网页加载失败（\(code)）。请检查网络或证书后重试；无法忽略证书错误。"
    failureURL = requestedURL
    changed()
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    cancelJavaScriptDialog()
    owner?.cancelApplicationRequest()
    if retirement != .active {
      finishUnload(false)
      return
    }
    guard valid else { return }
    navigation = nil
    navigationRevision += 1
    failure = "页面已被系统回收，重新加载后未提交内容可能丢失。"
    failureURL = currentURL
    changed()
  }

  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    guard retirement == .active, valid, navigationAction.targetFrame == nil,
      !navigationAction.shouldPerformDownload, let url = navigationAction.request.url
    else { return nil }
    if let link = BrowserURLPolicy.applicationLink(url) {
      requestApplication(link, frame: navigationAction.sourceFrame)
      return nil
    }
    guard case .web = classify(url.absoluteString) else { return nil }
    // Keep new-window links in this browser, preserving the original request (including POST).
    // The load passes through the same main-frame navigation policy and lifecycle guards.
    navigation = webView.load(navigationAction.request)
    return nil
  }
}

struct BrowserWebView: UIViewRepresentable {
  let page: BrowserPage
  func makeUIView(context: Context) -> WKWebView { page.webView }
  func updateUIView(_ view: WKWebView, context: Context) {}
}
