import Darwin
import Foundation

public struct BrowserOpenIntent {
  public enum Origin { case terminalLink, selection, page }
  public enum Action { case internalOpen, externalOpen, link }
  public let target: String
  public let origin: Origin
  public let action: Action
  public let sessionIdentity: UUID?

  public init(target: String, origin: Origin, action: Action, sessionIdentity: UUID? = nil) {
    self.target = target
    self.origin = origin
    self.action = action
    self.sessionIdentity = sessionIdentity
  }
}

struct BrowserSourceScope: Equatable {
  let connectionScope: String
  let generation: Int
  let terminalID: String
}

/// A navigation policy, not a DNS resolver or a private-network firewall.
enum BrowserURLPolicy {
  struct ApplicationLink {
    let url: URL
    let name: String
    var universalLink: Bool { url.scheme?.lowercased() == "https" }

    var schemeFallback: URL? {
      guard universalLink,
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
      else { return nil }
      // Feishu's Conditional Access page uses this same route with either scheme.
      components.scheme = "lark"
      return components.url
    }
  }

  /// Page-only handoff. These URLs never become browser entry URLs or website history.
  static func applicationLink(_ url: URL) -> ApplicationLink? {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      components.user == nil, components.password == nil, components.port == nil,
      let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased()
    else { return nil }
    // Conditional Access uses larkoffice AppLinks, including inside a hidden iframe.
    let appLinkHost = ["applink.feishu.cn", "applink.larkoffice.com", "applink.larksuite.com"]
      .contains(host)
    switch scheme {
    case "lark", "x-feishu", "x-lark":
      guard appLinkHost || host == "client" else { return nil }
    case "https":
      guard appLinkHost, components.path.hasPrefix("/client/") else { return nil }
    default: return nil
    }
    let name = scheme == "x-lark" || host == "applink.larksuite.com" ? "Lark" : "飞书"
    return ApplicationLink(url: url, name: name)
  }

  enum Decision {
    case web(URL)
    case denied(String)
  }

  static func classify(_ raw: String) -> Decision {
    guard !raw.isEmpty, !raw.contains(where: { $0.isWhitespace || $0.isNewline }),
      !raw.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
      let components = URLComponents(string: raw), let url = components.url,
      let scheme = components.scheme?.lowercased(),
      components.user == nil, components.password == nil
    else { return .denied("链接无效或包含不支持的用户密码。") }
    if scheme == "mailto" || scheme == "tel" {
      return .denied("内置浏览器暂不支持电话或邮件链接。可从右上角“…”在默认浏览器继续。")
    }
    guard scheme == "http" || scheme == "https" else {
      return .denied("此链接无法在内置浏览器打开。可从右上角“…”在默认浏览器继续。")
    }
    guard let host = url.host?.lowercased(), !host.isEmpty,
      components.port.map({ (1...65535).contains($0) }) ?? true
    else { return .denied("链接缺少有效的网站地址。") }
    if isLocalHost(host) {
      return .denied("电脑本地服务暂不支持，请使用手机可访问的地址。")
    }
    return .web(url)
  }

  // These documents belong to an existing frame; they are not browser entry URLs.
  static func isEmbeddedDocument(_ url: URL) -> Bool {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      components.scheme?.lowercased() == "about", components.host == nil,
      components.user == nil, components.password == nil, components.query == nil
    else { return false }
    return components.path == "blank" || components.path == "srcdoc"
  }

  private static func isLocalHost(_ raw: String) -> Bool {
    let host = raw.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
      .trimmingCharacters(in: CharacterSet(charactersIn: "."))
    if host == "localhost" || host.hasSuffix(".localhost") { return true }
    // inet_aton also covers numeric IPv4 spellings WebKit canonicalizes (127.1, hex, integer).
    var ipv4 = in_addr()
    if inet_aton(host, &ipv4) == 1 {
      let value = UInt32(bigEndian: ipv4.s_addr)
      return value == 0 || value >> 24 == 127
    }
    var ipv6 = in6_addr()
    let address = host.components(separatedBy: "%").first ?? host
    if inet_pton(AF_INET6, address, &ipv6) == 1 {
      let bytes = withUnsafeBytes(of: &ipv6) { Array($0) }
      if bytes.prefix(15).allSatisfy({ $0 == 0 }) && bytes[15] <= 1 { return true }
      if bytes.prefix(10).allSatisfy({ $0 == 0 }), bytes[10] == 255, bytes[11] == 255 {
        return bytes[12] == 127 || bytes.suffix(4).allSatisfy({ $0 == 0 })
      }
    }
    return false
  }

  /// SwiftTerm joins soft wraps but preserves real linefeeds. Never repair a mixed selection.
  static func selectedURL(_ text: String) -> String? {
    guard !text.contains(where: { $0.isWhitespace || $0.isNewline }),
      let components = URLComponents(string: text), components.url != nil,
      ["http", "https"].contains(components.scheme?.lowercased() ?? ""),
      let host = components.host, !host.isEmpty,
      let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
    else { return nil }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    let matches = detector.matches(in: text, range: range)
    guard matches.count == 1, matches[0].range.location == 0 else { return nil }
    // A detector can exclude legal trailing punctuation. Never trim the selected target;
    // URL policy makes the final safety decision, including explanatory local-address errors.
    return text
  }
}
