import Darwin
import Foundation
import Network
import WebKit

/// A computer-local source. This value grants no network access by itself.
public struct BrowserLocalTarget {
  public let url: URL
  public let host: String
  public let port: Int
  public var secure: Bool { url.scheme?.lowercased() == "https" }

  public init?(_ raw: String) {
    guard case .web(let url) = BrowserURLPolicy.classify(raw, allowLocal: true),
      let rawHost = url.host, BrowserURLPolicy.isLocalHost(rawHost) else { return nil }
    let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
      .trimmingCharacters(in: CharacterSet(charactersIn: "."))
    var ipv4 = in_addr()
    if inet_aton(host, &ipv4) == 1 {
      let value = UInt32(bigEndian: ipv4.s_addr)
      self.host = value == 0 ? "0.0.0.0" : "\(value >> 24).\((value >> 16) & 255).\((value >> 8) & 255).\(value & 255)"
    } else if host == "::" || host == "::1" || host == "localhost" || host.hasSuffix(".localhost") {
      self.host = host
    } else {
      var address = in6_addr()
      guard inet_pton(AF_INET6, host, &address) == 1 else { return nil }
      let bytes = withUnsafeBytes(of: &address) { Array($0) }
      guard bytes.prefix(10).allSatisfy({ $0 == 0 }), bytes[10] == 255, bytes[11] == 255,
        bytes[12] == 127 || bytes.suffix(4).allSatisfy({ $0 == 0 }) else { return nil }
      self.host = bytes.suffix(4).map(String.init).joined(separator: ".")
    }
    self.url = url
    self.port = url.port ?? (url.scheme?.lowercased() == "https" ? 443 : 80)
  }

  public func previewURL(identity: UUID) -> URL {
    var value = URLComponents(url: url, resolvingAgainstBaseURL: false)!
    // Preserve workspace-service virtual hosts; literals must become a proxyable hostname.
    value.host = host.hasSuffix(".localhost") ? host : "preview-\(identity.uuidString.lowercased()).localhost"
    value.scheme = "http"
    value.port = port
    return value.url!
  }
}

/// Opaque host-owned transport lease. App credentials never enter WebKit or this package.
@MainActor
public final class BrowserLocalPreview {
  public let url: URL
  public let originalURL: URL
  let explanation = "电脑本地预览 · 临时网站数据。相对资源通过电脑加载；写死 localhost 的接口需改用相对地址。"
  private let port: UInt16
  private let password: String
  private var shutdown: (() -> Void)?
  public var onFailure: ((String) -> Void)?
  let store = WKWebsiteDataStore.nonPersistent()
  private(set) var rules: WKContentRuleList?

  public init(url: URL, originalURL: URL, port: UInt16, password: String, close: @escaping () -> Void) {
    self.url = url
    self.originalURL = originalURL
    self.port = port
    self.password = password
    self.shutdown = close
  }

  func configure() async throws {
    guard #available(iOS 17.0, *) else {
      throw NSError(domain: "LocalPreview", code: 1, userInfo: [NSLocalizedDescriptionKey: "本地预览需要 iOS 17 或更新版本。"])
    }
    var proxy = ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!))
    proxy.matchDomains = [url.host!]
    proxy.excludedDomains = []
    proxy.allowFailover = false
    proxy.applyCredential(username: "preview", password: password)
    store.proxyConfigurations = [proxy]
    // Absolute localhost resources must not silently connect to services on the phone.
    // WebKit's regex subset does not support alternation; use one rule per host form.
    let blockedHosts = ["localhost", "[^/]*\\.localhost", "127\\.[0-9.]+", "0\\.0\\.0\\.0", "\\[::1?\\]", "\\[::ffff:[0-9a-f:.]+\\]"]
    let portPattern = url.port == 80 ? "(:80)?" : ":\(url.port!)"
    let allowed = "^[a-z]+://" + NSRegularExpression.escapedPattern(for: url.host!) + portPattern + "/"
    var json: [[String: Any]] = blockedHosts.map { host in
      ["trigger": ["url-filter": "^[a-z]+://([^/@]*@)?" + host + "\\.?(:[0-9]+)?/", "url-filter-is-case-sensitive": false], "action": ["type": "block"]]
    }
    json.append(["trigger": ["url-filter": allowed], "action": ["type": "ignore-previous-rules"]])
    let encoded = String(data: try JSONSerialization.data(withJSONObject: json), encoding: .utf8)!
    rules = try await WKContentRuleListStore.default().compileContentRuleList(
      forIdentifier: "runweave-local-\(UUID().uuidString)", encodedContentRuleList: encoded)
    // The compiled object is retained by this page; don't leave per-session files behind.
    if let rules { try? await WKContentRuleListStore.default().removeContentRuleList(forIdentifier: rules.identifier) }
  }

  func allows(_ candidate: URL) -> Bool {
    candidate.scheme == url.scheme && candidate.host == url.host && (candidate.port ?? 80) == url.port
  }

  public func close() {
    onFailure = nil
    let action = shutdown
    shutdown = nil
    action?()
  }
}
