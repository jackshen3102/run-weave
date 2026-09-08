import Darwin
import Foundation

struct MobileLoginFailure: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

/// Mirrors @runweave/shared/mobile-login. The QR is a short-lived credential, never a log field.
struct MobileLoginQR: Decodable {
  let kind: String
  let version: Int
  let baseUrl: String
  let connectionName: String
  let requestId: String
  let qrSecret: String
  let expiresAt: String

  var expiry: Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: expiresAt) ?? ISO8601DateFormatter().date(from: expiresAt)
  }

  static func parse(_ text: String) throws -> Self {
    guard text.utf8.count <= 4096, let data = text.data(using: .utf8),
      let qr = try? JSONDecoder().decode(Self.self, from: data),
      qr.kind == "runweave.mobile-login"
    else { throw MobileLoginFailure(message: "这不是 Runweave 登录二维码，请重新扫码。") }
    guard qr.version == 1 else { throw MobileLoginFailure(message: "二维码版本不支持，请更新 App。") }
    guard UUID(uuidString: qr.requestId) != nil, validSecret(qr.qrSecret),
      !qr.connectionName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      qr.connectionName.utf16.count <= 128, qr.expiresAt.utf8.count <= 64, qr.expiry != nil
    else { throw MobileLoginFailure(message: "二维码内容无效，请重新扫码。") }
    _ = try validatedBase(qr.baseUrl)
    // A phone clock cannot veto the server's authoritative expiry.
    return qr
  }

  static func validSecret(_ value: String) -> Bool {
    value.utf8.count == 43 && value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
  }

  static func validatedBase(_ value: String) throws -> URL {
    guard value.utf8.count <= 2048, !value.contains("\\"),
      value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
      let parts = URLComponents(string: value), parts.query == nil, parts.fragment == nil,
      parts.user == nil, parts.password == nil, let rawHost = parts.host
    else { throw MobileLoginFailure(message: "二维码中的连接地址无效。") }
    let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]."))
    guard host != "localhost", !host.hasSuffix(".localhost"), !host.contains("%") else {
      throw MobileLoginFailure(message: "请使用手机可访问的电脑地址，不能使用本机回环地址。")
    }
    var ipv4 = in_addr()
    if inet_aton(host, &ipv4) == 1 {
      let address = UInt32(bigEndian: ipv4.s_addr)
      guard address != 0, address >> 24 != 127 else { throw APIError.invalidURL }
    }
    var ipv6 = in6_addr()
    if inet_pton(AF_INET6, host, &ipv6) == 1 {
      let bytes = withUnsafeBytes(of: &ipv6) { Array($0) }
      let zeroPrefix = bytes.prefix(15).allSatisfy { $0 == 0 }
      let mapped = bytes.prefix(10).allSatisfy { $0 == 0 } && bytes[10] == 255 && bytes[11] == 255
      guard !(zeroPrefix && bytes[15] <= 1),
        !(mapped && (bytes[12] == 127 || bytes.suffix(4).allSatisfy { $0 == 0 }))
      else { throw APIError.invalidURL }
    }
    return try APIClient.normalize(value)
  }
}

enum MobileLoginState: String, Decodable {
  case waitingScan = "waiting_scan", pendingApproval = "pending_approval"
  case approved, issuing, issued, completed, cancelled, rejected, expired, unconfirmed, failed
}
struct MobileLoginStatus: Decodable {
  let state: MobileLoginState
  let expiresAt: String
  let claimId: String?
}
struct MobileLoginResult: Decodable {
  let accessToken: String
  let refreshToken: String
  let sessionId: String
  let expiresIn: Double

  func validate() throws {
    guard !accessToken.isEmpty, !refreshToken.isEmpty, accessToken.utf8.count <= 16384,
      refreshToken.utf8.count <= 16384, UUID(uuidString: sessionId) != nil,
      expiresIn.isFinite, expiresIn > 0
    else { throw APIError.invalidResponse }
  }
}
