import Foundation
import Security
struct SavedCredentials: Codable { let tokens: Tokens; let expiresAt: Date }
enum Credentials {
  static let service = "com.runweave.suiji.credentials"
  static func read(endpoint: String, environment: ConnectionEnvironment) throws -> SavedCredentials? {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: environment.scoped(endpoint), kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw MessageError(message: "无法读取安全凭据") }
    return try JSONDecoder().decode(SavedCredentials.self, from: data)
  }
  static func write(_ value: SavedCredentials, endpoint: String, environment: ConnectionEnvironment) throws {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: environment.scoped(endpoint)]
    let values: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(value), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
    if status == errSecItemNotFound {
      var added = query; values.forEach { added[$0.key] = $0.value }
      guard SecItemAdd(added as CFDictionary, nil) == errSecSuccess else { throw MessageError(message: "无法保存安全凭据") }; return
    }
    guard status == errSecSuccess else { throw MessageError(message: "无法保存安全凭据") }
  }
  static func remove(endpoint: String, environment: ConnectionEnvironment) throws {
    let status = SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: environment.scoped(endpoint)] as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw MessageError(message: "无法清除安全凭据") }
  }
}
