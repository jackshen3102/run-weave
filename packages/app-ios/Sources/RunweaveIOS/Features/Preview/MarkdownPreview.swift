import Clarity
import RunweaveBrowser
import SwiftUI

struct MarkdownPreview: View {
  @ObservedObject var session: AppSession
  let projectID: String
  let path: String
  let content: String
  // A file can be presented above the terminal or conversation reader. Its browser
  // must return to that file without also presenting the terminal's browser cover.
  @StateObject private var browser = BrowserSession(configuration: BrowserPresentationConfiguration(
    applicationName: "Runweave", returnLabel: "返回文档",
    clearDataMessage: "清除此 App 全部内置网站的登录与存储数据？网页将关闭，不影响电脑连接或终端草稿。网站登录独立于电脑连接。"))
  @State private var presentationID = UUID()
  @State private var visible = false
  @State private var configured = false

  // Keep YAML front matter visible as source rather than interpreting it as headings.
  private var renderedContent: String {
    let lines = content.components(separatedBy: "\n")
    guard lines.first?.trimmingCharacters(in: .whitespaces) == "---",
      let end = lines.indices.dropFirst().first(where: {
        lines[$0].trimmingCharacters(in: .whitespaces) == "---"
      }) else { return content }
    let frontmatter = lines[...end].map { "    " + $0 }.joined(separator: "\n")
    return frontmatter + "\n\n" + lines.dropFirst(end + 1).joined(separator: "\n")
  }

  var body: some View {
    MarkdownPreviewDocument(content: renderedContent) { url in
      guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), let source = browser.currentSource?()
      else { return url.scheme?.lowercased() == "mailto" ? .systemAction : .discarded }
      browser.open(BrowserOpenIntent(target: url.absoluteString, origin: .host, action: .internalOpen),
        source: source, presentationAvailable:
          browser.hostPresentationAvailable(source: source, registrationID: presentationID))
      return .handled
    }
    .safeAreaInset(edge: .bottom) {
      if browser.state == .collapsed {
        Button { browser.resume() } label: {
          Label("继续浏览网页", systemImage: "globe").frame(maxWidth: .infinity).padding(12)
        }
        .background(.regularMaterial)
        .accessibilityIdentifier("preview-browser-resume")
      }
    }
    .fullScreenCover(isPresented: Binding(
      get: { browser.state == .presented },
      set: { if !$0 { browser.collapse() } }
    )) {
      BrowserScreen(browser: browser).clarityMask().mobileAnalyticsScreen(.browser)
    }
    .modifier(BrowserPromptPresenter(browser: browser, active: browser.state != .presented))
    .overlay(alignment: .top) {
      if let status = browser.dataStatus {
        Text(status).font(.caption).padding(8).background(.regularMaterial)
          .allowsHitTesting(false).accessibilityIdentifier("browser-data-status")
      }
    }
    .onAppear { visible = true; connectBrowser() }
    .onDisappear {
      visible = false
      if browser.state != .presented {
        browser.unregisterHostPresentation(id: presentationID, hostID: ObjectIdentifier(browser))
        browser.invalidate()
      }
    }
    .onChange(of: session.browserSource) { _ in browser.invalidate() }
  }

  private func connectBrowser() {
    if !configured {
      let projectID = projectID
      let path = path
      browser.currentSource = { [weak session] in
        guard let source = session?.browserSource else { return nil }
        return BrowserContext(scope: source.scope + ["file-preview", projectID, path], generation: source.generation)
      }
      MobileAnalytics.observeBrowser(browser)
      configured = true
    }
    guard let source = browser.currentSource?() else { return }
    let visible = $visible
    browser.registerHostPresentation(id: presentationID, source: source, hostID: ObjectIdentifier(browser)) { [weak browser] in
      guard let browser else { return false }
      return visible.wrappedValue && browser.state != .presented && !browser.hasPrompt
    }
  }
}

/// Keep the document's layout graph independent of session and browser chrome
/// updates. Reassigning a hosting root for an unchanged long document also
/// invalidates its tables and text while its browser is covering it.
private struct MarkdownPreviewDocument: UIViewControllerRepresentable {
  let content: String
  let openURL: (URL) -> OpenURLAction.Result

  func makeCoordinator() -> Coordinator { Coordinator(content: content, openURL: openURL) }

  func makeUIViewController(context: Context) -> UIHostingController<Document> {
    let controller = UIHostingController(rootView: document(context.coordinator))
    controller.view.backgroundColor = .clear
    return controller
  }

  func updateUIViewController(_ controller: UIHostingController<Document>, context: Context) {
    // Refresh the action without replacing the document or capturing an obsolete
    // source identity. The retained document consults this action on every tap.
    context.coordinator.openURL = openURL
    guard context.coordinator.content != content else { return }
    context.coordinator.content = content
    controller.rootView = document(context.coordinator)
  }

  private func document(_ coordinator: Coordinator) -> Document {
    Document(content: content, openURL: { coordinator.openURL($0) })
  }

  final class Coordinator {
    var content: String
    var openURL: (URL) -> OpenURLAction.Result
    init(content: String, openURL: @escaping (URL) -> OpenURLAction.Result) {
      self.content = content
      self.openURL = openURL
    }
  }

  struct Document: View {
    let content: String
    let openURL: (URL) -> OpenURLAction.Result

    var body: some View {
      ScrollView {
        MarkdownContent(content: content)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding()
      }
      .environment(\.openURL, OpenURLAction(handler: openURL))
    }
  }
}
