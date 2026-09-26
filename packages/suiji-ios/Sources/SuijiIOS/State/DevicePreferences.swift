import Foundation

/// Retains the existing device-local keys; login secrets stay in Credentials (Keychain).
enum DevicePreferences {
  private static let store = UserDefaults.standard
  static var legacyEndpoint: String { store.string(forKey: "suiji.endpoint") ?? "" }
  static var connections: Data? {
    get { store.data(forKey: "suiji.connections.v1") }
    set { store.set(newValue, forKey: "suiji.connections.v1") }
  }
}
