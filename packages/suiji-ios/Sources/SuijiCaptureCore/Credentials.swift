import Foundation
import Security
struct SavedCredentials: Codable { let tokens: Tokens; let expiresAt: Date }
enum Credentials {
  static let service = "com.runweave.suiji.credentials"
  private static func query(endpoint: String, environment: ConnectionEnvironment, shared: Bool) throws -> [String: Any] {
    var value: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: environment.scoped(endpoint)]
    if shared {
      guard let group = Bundle.main.object(forInfoDictionaryKey: "SuijiKeychainGroup") as? String, !group.contains("$(") else {
        throw CaptureError("共享凭据权限不可用，请检查签名")
      }
      value[kSecAttrAccessGroup as String] = group
    }
    return value
  }
  private static func read(endpoint: String, environment: ConnectionEnvironment, shared: Bool) throws -> SavedCredentials? {
    var value = try query(endpoint: endpoint, environment: environment, shared: shared)
    value[kSecReturnData as String] = true; value[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(value as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw CaptureError("无法读取安全凭据") }
    return try JSONDecoder().decode(SavedCredentials.self, from: data)
  }
  static func read(endpoint: String, environment: ConnectionEnvironment) throws -> SavedCredentials? {
    try read(endpoint: endpoint, environment: environment, shared: true)
  }
  // Called only while holding the cross-process credential lock.
  static func migrate(endpoint: String, environment: ConnectionEnvironment) throws -> SavedCredentials? {
    if let value = try read(endpoint: endpoint, environment: environment, shared: true) { return value }
    // Only the host can migrate its old private item. Keep it until shared readback succeeds.
    guard Bundle.main.bundleURL.pathExtension != "appex",
      let old = try read(endpoint: endpoint, environment: environment, shared: false) else { return nil }
    var added = try query(endpoint: endpoint, environment: environment, shared: true)
    added[kSecValueData as String] = try JSONEncoder().encode(old)
    added[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(added as CFDictionary, nil)
    guard status == errSecSuccess || status == errSecDuplicateItem,
      let verified = try read(endpoint: endpoint, environment: environment, shared: true),
      verified.tokens.sessionId == old.tokens.sessionId else { throw CaptureError("迁移安全凭据失败，旧登录已保留") }
    return verified
  }
  static func write(_ value: SavedCredentials, endpoint: String, environment: ConnectionEnvironment) throws {
    let query = try query(endpoint: endpoint, environment: environment, shared: true)
    let values: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(value), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
    if status == errSecItemNotFound {
      var added = query; values.forEach { added[$0.key] = $0.value }
      guard SecItemAdd(added as CFDictionary, nil) == errSecSuccess else { throw CaptureError("无法保存安全凭据") }; return
    }
    guard status == errSecSuccess else { throw CaptureError("无法保存安全凭据") }
  }
  static func remove(endpoint: String, environment: ConnectionEnvironment) throws {
    for shared in [true, false] {
      let status = SecItemDelete(try query(endpoint: endpoint, environment: environment, shared: shared) as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else { throw CaptureError("无法清除安全凭据") }
    }
  }
}
