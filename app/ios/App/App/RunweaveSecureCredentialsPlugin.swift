import Capacitor
import Foundation
import Security

@objc(RunweaveSecureCredentials)
public class RunweaveSecureCredentialsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RunweaveSecureCredentialsPlugin"
    public let jsName = "RunweaveSecureCredentials"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private var serviceName: String {
        "\(Bundle.main.bundleIdentifier ?? "com.runweave.app").credentials"
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("Missing key")
            return
        }

        var query = baseQuery(for: key)
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecReturnData as String] = true

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
            return
        }
        guard status == errSecSuccess else {
            call.reject("Keychain read failed", "\(status)")
            return
        }
        guard
            let data = item as? Data,
            let value = String(data: data, encoding: .utf8)
        else {
            call.reject("Keychain value is invalid")
            return
        }

        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("Missing key")
            return
        }
        guard let value = call.getString("value") else {
            call.reject("Missing value")
            return
        }
        guard let data = value.data(using: .utf8) else {
            call.reject("Value is not UTF-8 encodable")
            return
        }

        let query = baseQuery(for: key)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            call.resolve()
            return
        }
        if updateStatus != errSecItemNotFound {
            call.reject("Keychain update failed", "\(updateStatus)")
            return
        }

        var addQuery = query
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            call.reject("Keychain write failed", "\(addStatus)")
            return
        }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("Missing key")
            return
        }

        let status = SecItemDelete(baseQuery(for: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Keychain delete failed", "\(status)")
            return
        }
        call.resolve()
    }

    private func baseQuery(for key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key
        ]
    }
}
