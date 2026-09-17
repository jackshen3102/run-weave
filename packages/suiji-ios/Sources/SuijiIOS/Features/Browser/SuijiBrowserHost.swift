import RunweaveBrowser
import SwiftUI
import UIKit

private struct SuijiOpenLinkKey: EnvironmentKey {
  static let defaultValue: ((URL) -> Void)? = nil
}

extension EnvironmentValues {
  var suijiOpenLink: ((URL) -> Void)? {
    get { self[SuijiOpenLinkKey.self] }
    set { self[SuijiOpenLinkKey.self] = newValue }
  }
}

/// Root-owned presentation survives list/detail navigation and owns no business requests.
struct SuijiBrowserHost: ViewModifier {
  @ObservedObject var session: SuijiSession
  @ObservedObject private var browser: BrowserSession
  @Binding var settingsPresented: Bool
  @StateObject private var presentation = SuijiBrowserPresentation()

  init(session: SuijiSession, settingsPresented: Binding<Bool>) {
    self.session = session
    self.browser = session.browser
    self._settingsPresented = settingsPresented
  }

  func body(content: Content) -> some View {
    content
      .environment(\.suijiOpenLink, open)
      .background(SuijiBrowserAnchor(presentation: presentation, browser: browser))
      .safeAreaInset(edge: .bottom) {
        if browser.state == .collapsed || browser.dataStatus != nil {
          VStack(spacing: 4) {
            if browser.state == .collapsed, let title = browser.pageTitle {
              Button {
                guard let source = session.browserSource else { return }
                register(source)
                if browser.hostPresentationAvailable(source: source, registrationID: presentation.id) {
                  browser.resume()
                }
              } label: {
                Label("继续浏览：\(title)", systemImage: "globe").lineLimit(1)
              }
              .accessibilityIdentifier("suiji-browser-resume")
              .disabled(browser.clearing)
            }
            if let status = browser.dataStatus {
              Text(status).font(.footnote).foregroundStyle(.secondary)
                .accessibilityIdentifier("suiji-browser-status")
            }
          }
          .frame(maxWidth: .infinity).padding(10).background(.regularMaterial)
        }
      }
      .fullScreenCover(isPresented: Binding(
        get: { browser.state == .presented },
        set: { if !$0 { browser.collapse() } }
      )) { BrowserScreen(browser: browser) }
      .modifier(BrowserPromptPresenter(browser: browser, active: browser.state != .presented))
  }

  private func register(_ source: BrowserContext) {
    let settings = $settingsPresented
    browser.registerHostPresentation(
      id: presentation.id, source: source, hostID: ObjectIdentifier(presentation)
    ) { [weak session, weak browser, weak presentation] in
      guard let session, let browser, let presentation,
        session.browserSource == source, session.editor == nil, !settings.wrappedValue,
        browser.state != .presented, !browser.hasPrompt,
        UIApplication.shared.applicationState == .active
      else { return false }
      return presentation.available
    }
  }

  private func open(_ url: URL) {
    guard let source = session.browserSource else { return }
    register(source)
    browser.open(BrowserOpenIntent(target: url.absoluteString, origin: .host, action: .internalOpen),
      source: source,
      presentationAvailable: browser.hostPresentationAvailable(source: source, registrationID: presentation.id))
  }
}

@MainActor
private final class SuijiBrowserPresentation: ObservableObject {
  let id = UUID()
  weak var anchor: UIView?
  var available: Bool {
    guard let anchor, let root = anchor.window?.rootViewController else { return false }
    // Covers sheets presented by a NavigationStack child as well as by its window root.
    func busy(_ controller: UIViewController) -> Bool {
      controller.presentedViewController != nil || controller.isBeingDismissed
        || controller.children.contains(where: busy)
    }
    return !busy(root)
  }
}

private struct SuijiBrowserAnchor: UIViewRepresentable {
  let presentation: SuijiBrowserPresentation
  let browser: BrowserSession

  func makeCoordinator() -> Coordinator { Coordinator(presentation: presentation, browser: browser) }
  func makeUIView(context: Context) -> UIView {
    let view = UIView()
    view.isUserInteractionEnabled = false
    presentation.anchor = view
    return view
  }
  func updateUIView(_ uiView: UIView, context: Context) {}
  static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
    // Dismantling means the account root is destroyed, unlike onDisappear for a cover.
    if coordinator.browser.unregisterHostPresentation(
      id: coordinator.presentation.id, hostID: ObjectIdentifier(coordinator.presentation)) {
      coordinator.browser.invalidate()
    }
  }
  final class Coordinator {
    let presentation: SuijiBrowserPresentation
    let browser: BrowserSession
    init(presentation: SuijiBrowserPresentation, browser: BrowserSession) {
      self.presentation = presentation
      self.browser = browser
    }
  }
}
