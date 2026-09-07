import Foundation
import Security

struct CredentialStore {
  private let service = "com.runweave.app.native.credentials"

  func read(_ account: String) throws -> Data? {
    var query = base(account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var value: CFTypeRef?
    let result = SecItemCopyMatching(query as CFDictionary, &value)
    if result == errSecItemNotFound { return nil }
    guard result == errSecSuccess else { throw APIError.keychain(result) }
    return value as? Data
  }

  func write(_ data: Data, account: String) throws {
    let query = base(account)
    let result = SecItemUpdate(
      query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if result == errSecItemNotFound {
      var item = query
      item[kSecValueData as String] = data
      item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      let added = SecItemAdd(item as CFDictionary, nil)
      guard added == errSecSuccess else { throw APIError.keychain(added) }
    } else if result != errSecSuccess {
      throw APIError.keychain(result)
    }
  }

  func delete(_ account: String) throws {
    let result = SecItemDelete(base(account) as CFDictionary)
    guard result == errSecSuccess || result == errSecItemNotFound else {
      throw APIError.keychain(result)
    }
  }

  private func base(_ account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }
}
