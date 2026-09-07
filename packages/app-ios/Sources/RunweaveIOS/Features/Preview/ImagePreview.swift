import SwiftUI
import UIKit
import WebKit

struct ImagePreview: UIViewRepresentable {
  let image: UIImage
  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeUIView(context: Context) -> UIScrollView {
    let scroll = UIScrollView()
    scroll.minimumZoomScale = 1
    scroll.maximumZoomScale = 5
    scroll.delegate = context.coordinator
    let view = context.coordinator.imageView
    view.contentMode = .scaleAspectFit
    view.image = image
    scroll.addSubview(view)
    view.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      view.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
      view.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
      view.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
      view.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
      view.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
      view.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
    ])
    let doubleTap = UITapGestureRecognizer(
      target: context.coordinator, action: #selector(Coordinator.toggleZoom(_:)))
    doubleTap.numberOfTapsRequired = 2
    scroll.addGestureRecognizer(doubleTap)
    return scroll
  }
  func updateUIView(_ view: UIScrollView, context: Context) {
    context.coordinator.imageView.image = image
  }
  final class Coordinator: NSObject, UIScrollViewDelegate {
    let imageView = UIImageView()
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
    @objc func toggleZoom(_ recognizer: UITapGestureRecognizer) {
      guard let view = recognizer.view as? UIScrollView else { return }
      view.setZoomScale(view.zoomScale > 1 ? 1 : 2, animated: true)
    }
  }
}

// SVG is untrusted document content: no credentials, JavaScript, network, or input bridge.
struct SVGPreview: UIViewRepresentable {
  let content: String
  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = false
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = context.coordinator
    return view
  }
  func updateUIView(_ view: WKWebView, context: Context) {
    guard context.coordinator.content != content else { return }
    context.coordinator.content = content
    view.loadHTMLString(
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><style>svg{max-width:100%;height:auto}body{margin:0}</style>"
        + content, baseURL: nil)
  }
  final class Coordinator: NSObject, WKNavigationDelegate {
    var content: String?
    func webView(
      _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
      decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
      decisionHandler(
        navigationAction.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
    }
  }
}
