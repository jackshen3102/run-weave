import SwiftUI
import WebKit

struct HtmlPreview: UIViewRepresentable {
  let url: URL

  func makeCoordinator() -> Coordinator { Coordinator(url: url) }

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = context.coordinator
    view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    return view
  }

  func updateUIView(_ view: WKWebView, context: Context) {
    guard context.coordinator.url != url else { return }
    context.coordinator.url = url
    view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
  }

  static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
    view.stopLoading()
    view.navigationDelegate = nil
  }

  final class Coordinator: NSObject, WKNavigationDelegate {
    var url: URL
    init(url: URL) { self.url = url }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
      let target = navigationAction.request.url
      decisionHandler(target == url ? .allow : .cancel)
    }
  }
}
