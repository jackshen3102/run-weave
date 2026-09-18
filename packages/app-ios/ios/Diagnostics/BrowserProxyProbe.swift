#if NATIVE_DIAGNOSTICS
import SwiftUI
import WebKit
import Network

/// Public-API feasibility probe only; never enabled in Release or normal startup.
struct BrowserProxyProbe: View {
  @StateObject private var model = BrowserProxyProbeModel()
  var body: some View {
    VStack {
      Text("本地浏览器代理验证").font(.headline)
      Text(model.status).font(.caption).accessibilityIdentifier("browser-proxy-probe-status")
      if let webView = model.webView { ProxyProbeView(webView: webView) }
    }.task { await model.start() }
  }
}

private struct ProxyProbeView: UIViewRepresentable {
  let webView: WKWebView
  func makeUIView(context: Context) -> WKWebView { webView }
  func updateUIView(_ view: WKWebView, context: Context) {}
}

@MainActor
private final class BrowserProxyProbeModel: NSObject, ObservableObject, WKNavigationDelegate {
  struct Configuration: Decodable {
    let host: String
    let proxyPort: UInt16
    let password: String
    let runId: String
    let targets: [String]
    let kind: String?
  }
  @Published var status = "准备"
  @Published var webView: WKWebView?
  private var config: Configuration?
  private var configURL: URL?
  private var listener: NWListener?
  private var connections: [NWConnection] = []
  private var index = 0
  private var currentTarget = ""
  private var navigationID = UUID()

  func start() async {
    guard configURL == nil, #available(iOS 17.0, *) else { return }
    let args = ProcessInfo.processInfo.arguments
    guard let option = args.firstIndex(of: "--browser-proxy-config"), args.indices.contains(option + 1),
      let url = URL(string: args[option + 1]) else { status = "缺少 fixture 配置"; return }
    configURL = url
    do {
      let (data, _) = try await URLSession.shared.data(from: url)
      let config = try JSONDecoder().decode(Configuration.self, from: data)
      self.config = config
      let parameters = NWParameters.tcp
      parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
      let listener = try NWListener(using: parameters)
      self.listener = listener
      listener.newConnectionHandler = { [weak self] incoming in
        Task { @MainActor in self?.bridge(incoming, config: config) }
      }
      listener.stateUpdateHandler = { [weak self] state in
        Task { @MainActor in
          guard let self else { return }
          if case .ready = state, let port = listener.port {
            let store = WKWebsiteDataStore.nonPersistent()
            let endpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: port)
            var proxy = config.kind == "socks"
              ? ProxyConfiguration(socksv5Proxy: endpoint)
              : ProxyConfiguration(httpCONNECTProxy: endpoint)
            proxy.allowFailover = false
            if ProcessInfo.processInfo.arguments.contains("--proxy-explicit-domains") {
              proxy.matchDomains = ["localhost", "127.0.0.1", "::1", "www.apple.com"]
              proxy.excludedDomains = []
            }
            proxy.applyCredential(username: "probe", password: config.password)
            store.proxyConfigurations = [proxy]
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = store
            let view = WKWebView(frame: .zero, configuration: configuration)
            view.navigationDelegate = self
            self.webView = view
            self.next()
          }
        }
      }
      listener.start(queue: .main)
    } catch { status = "准备失败：\(error.localizedDescription)" }
  }

  private func bridge(_ incoming: NWConnection, config: Configuration) {
    let upstream = NWConnection(host: NWEndpoint.Host(config.host), port: NWEndpoint.Port(rawValue: config.proxyPort)!, using: .tcp)
    connections += [incoming, upstream]
    incoming.start(queue: .main)
    upstream.stateUpdateHandler = { [weak self] state in
      Task { @MainActor in
        if case .ready = state {
          self?.copy(incoming, to: upstream)
          self?.copy(upstream, to: incoming)
        }
      }
    }
    upstream.start(queue: .main)
  }

  private func copy(_ source: NWConnection, to target: NWConnection) {
    source.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
      target.send(content: data, isComplete: complete, completion: .contentProcessed { sendError in
        Task { @MainActor in
          if complete || error != nil || sendError != nil { source.cancel(); target.cancel() }
          else { self?.copy(source, to: target) }
        }
      })
    }
  }

  private func next() {
    guard let config, index < config.targets.count else { status = "验证结束；查看 fixture 结果"; return }
    let target = config.targets[index]
    currentTarget = target
    index += 1
    status = "验证 \(index)/\(config.targets.count)：\(target)"
    navigationID = UUID()
    let id = navigationID
    webView?.load(URLRequest(url: URL(string: target)!))
    Task {
      try? await Task.sleep(nanoseconds: 15_000_000_000)
      guard id == navigationID else { return }
      await report(["target": target, "result": "timeout"])
      next()
    }
  }

  func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
    let id = navigationID
    Task {
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      guard navigationID == id else { return }
      let result = try? await view.evaluateJavaScript("JSON.stringify(window.probeResult || {title:document.title, href:location.href})")
      await report(["target": view.url?.absoluteString ?? "", "result": result as? String ?? "loaded"])
      navigationID = UUID()
      next()
    }
  }

  func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    Task {
      await report(["target": currentTarget, "error": (error as NSError).code])
      navigationID = UUID()
      next()
    }
  }

  private func report(_ result: [String: Any]) async {
    guard let configURL else { return }
    var request = URLRequest(url: configURL.deletingLastPathComponent().appendingPathComponent("result"))
    request.httpMethod = "POST"
    var payload = result
    payload["explicitDomains"] = ProcessInfo.processInfo.arguments.contains("--proxy-explicit-domains")
    payload["platform"] = UIDevice.current.model
    payload["os"] = UIDevice.current.systemVersion
    payload["kind"] = config?.kind ?? "http-connect"
    request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
    _ = try? await URLSession.shared.data(for: request)
  }
}
#endif
