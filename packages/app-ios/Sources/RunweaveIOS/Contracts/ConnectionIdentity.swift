import CryptoKit
import Foundation

/// Mirrors @runweave/shared/connection-identity; raw Ed25519 bytes, base64url without padding.
struct ConnectionIdentity: Codable, Equatable {
  let version: Int
  let identityId: String
  let publicKey: String
  func validate() throws {
    guard version == 1, let key = Data(base64URL: publicKey), key.count == 32,
      SHA256.hash(data: key).map({ String(format: "%02x", $0) }).joined() == identityId
    else { throw ConnectionIdentityFailure.invalidProof }
  }
}
struct ConnectionProof: Decodable {
  let version: Int
  let identityId: String
  let publicKey: String
  let nonce: String
  let signature: String
  func verify(trust: ConnectionIdentity, nonce expected: String) throws {
    try trust.validate()
    guard identityId == trust.identityId, publicKey == trust.publicKey else {
      throw ConnectionIdentityFailure.identityMismatch
    }
    guard version == 1, nonce == expected, let bytes = Data(base64URL: signature), bytes.count == 64,
      let raw = Data(base64URL: publicKey),
      let key = try? Curve25519.Signing.PublicKey(rawRepresentation: raw),
      key.isValidSignature(bytes, for: Data("runweave-connection-probe-v1\n\(identityId)\n\(nonce)".utf8))
    else { throw ConnectionIdentityFailure.invalidProof }
  }
}
enum ConnectionIdentityFailure: Error, LocalizedError {
  case unsupported, identityMismatch, invalidProof, redirectRejected, unavailable, selectRoute
  var errorDescription: String? {
    switch self {
    case .unsupported: return "电脑端需升级后才能使用多线路"
    case .identityMismatch: return "电脑身份不匹配，请检查线路地址或重新登录确认电脑"
    case .invalidProof: return "电脑身份验证失败"
    case .redirectRejected: return "连接地址发生重定向，请填写最终地址"
    case .unavailable: return "电脑身份服务暂不可用"
    case .selectRoute: return "请选择线路，或添加一个连接地址"
    }
  }
}
extension Data {
  init?(base64URL: String) {
    guard !base64URL.contains("="), base64URL.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
    let base64 = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    guard let value = Data(base64Encoded: base64 + String(repeating: "=", count: (4 - base64.count % 4) % 4)),
      value.base64URL == base64URL else { return nil }
    self = value
  }
  var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
}
