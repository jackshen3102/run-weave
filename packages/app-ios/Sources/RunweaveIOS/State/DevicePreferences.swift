import Foundation

/// Device-local preferences only. Server configuration belongs to the selected Backend.
/// Keep these identifiers unchanged so updates preserve connections and appearance.
enum DevicePreferences {
  static let store = UserDefaults.standard
  static let themeKey = "native.theme"
  static let screenAwakeKey = "native.keepScreenAwake"
  static let instantRepliesVisibleKey = "native.terminal.instantReplies.visible"
  private static let connectionsKey = "native.connections.v1"

  static var theme: String { store.string(forKey: themeKey) ?? "dark" }
  static var connections: Data? {
    get { store.data(forKey: connectionsKey) }
    set {
      if let newValue { store.set(newValue, forKey: connectionsKey) }
      else { store.removeObject(forKey: connectionsKey) }
    }
  }
}
