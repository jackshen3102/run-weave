import Foundation
import Security

/// A separate ephemeral transport: no cookies, existing Bearer, diagnostic body, or redirect forwarding.
final class MobileLoginClient: NSObject, URLSessionTaskDelegate {
  private let base: URL
  private var session: URLSession!

  init(base: URL) {
    self.base = base
    super.init()
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.urlCache = nil
    config.timeoutIntervalForRequest = 15
    config.timeoutIntervalForResource = 20
    session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }

  func close() { session.invalidateAndCancel() }

  static func claimantToken() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw MobileLoginFailure(message: "无法建立安全的扫码请求，请重试。")
    }
    return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  func claim(_ qr: MobileLoginQR, claimantToken: String, deviceName: String, connectionID: String) async throws {
    let (data, _) = try await post(qr.requestId, action: "claim", body: [
      "qrSecret": qr.qrSecret, "claimantToken": claimantToken, "deviceName": deviceName,
      "connectionId": connectionID,
    ])
    let value = try JSONDecoder().decode(MobileLoginStatus.self, from: data)
    guard let claim = value.claimId, UUID(uuidString: claim) != nil else { throw APIError.invalidResponse }
    try check(value.state)
  }

  func exchange(_ id: String, claimantToken: String) async throws -> MobileLoginResult? {
    let (data, status) = try await post(id, action: "exchange", body: ["claimantToken": claimantToken])
    if status == 202 {
      try check(JSONDecoder().decode(MobileLoginStatus.self, from: data).state)
      return nil
    }
    let result = try JSONDecoder().decode(MobileLoginResult.self, from: data)
    try result.validate()
    return result
  }

  func complete(_ id: String, claimantToken: String, accessToken: String) async throws {
    let (data, _) = try await post(id, action: "complete", body: ["claimantToken": claimantToken], bearer: accessToken)
    guard try JSONDecoder().decode(MobileLoginStatus.self, from: data).state == .completed else {
      throw APIError.invalidResponse
    }
  }

  func cancel(_ id: String, claimantToken: String) async {
    _ = try? await post(id, action: "cancel", body: ["claimantToken": claimantToken])
  }

  private func check(_ state: MobileLoginState) throws {
    switch state {
    case .waitingScan, .pendingApproval, .approved, .issuing, .issued: return
    default: throw MobileLoginFailure(message: "请求已结束，请重新扫码。")
    }
  }

  private func post(_ id: String, action: String, body: [String: String], bearer: String? = nil) async throws -> (Data, Int) {
    guard let url = URL(string: base.absoluteString + "/api/auth/mobile-login/" + APIClient.pathComponent(id) + "/" + action) else {
      throw APIError.invalidURL
    }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("app", forHTTPHeaderField: "X-Auth-Client")
    if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
    request.httpBody = try JSONEncoder().encode(body)
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, data.count <= 65536 else { throw APIError.invalidResponse }
    if !(200..<300).contains(http.statusCode) {
      let code = (try? JSONDecoder().decode(Failure.self, from: data))?.code
      let message: String
      switch http.statusCode {
      case 300..<400: message = "连接地址发生重定向，请在电脑端配置最终地址后重新扫码。"
      case 404: message = code == "not_found" ? "扫码凭据无效，请重新扫码。" : "电脑端暂不支持扫码登录，请使用手动登录。"
      case 410: message = "二维码已过期或电脑已重启，请重新扫码。"
      case 409: message = "请求已被拒绝、取消或由另一台手机使用，请重新扫码。"
      case 429: message = "请求较多，请在 \(http.value(forHTTPHeaderField: "Retry-After") ?? "60") 秒后重试。"
      default: message = "当前阶段连接失败，请重试或使用手动登录。"
      }
      throw MobileLoginFailure(message: message)
    }
    return (data, http.statusCode)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void) {
    // No login POST needs a redirect. Rejecting all also prevents cross-origin and TLS downgrade leaks.
    completionHandler(nil)
  }

  private struct Failure: Decodable { let code: String? }
}
