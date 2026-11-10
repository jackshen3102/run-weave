import Foundation

enum TerminalQuickActionMode: String {
  case shortcuts, replies
}

/// Device-local preferences only. Server configuration belongs to the selected Backend.
/// Keep these identifiers unchanged so updates preserve connections and appearance.
enum DevicePreferences {
  static let store = UserDefaults.standard
  static let themeKey = "native.theme"
  static let screenAwakeKey = "native.keepScreenAwake"
  static let instantRepliesVisibleKey = "native.terminal.instantReplies.visible"
  static let terminalQuickActionModeKey = "native.terminal.quickActions.mode"
  static let terminalQuickActionsVisibleKey = "native.terminal.quickActions.visible"
  private static let connectionsKey = "native.connections.v1"
  private static let remoteHostsKey = "native.remoteHosts.v1"

  static func migrateTerminalQuickActions() {
    if store.string(forKey: terminalQuickActionModeKey) == nil {
      let mode: TerminalQuickActionMode = store.bool(forKey: instantRepliesVisibleKey) ? .replies : .shortcuts
      store.set(mode.rawValue, forKey: terminalQuickActionModeKey)
    }
    if store.object(forKey: terminalQuickActionsVisibleKey) == nil {
      store.set(true, forKey: terminalQuickActionsVisibleKey)
    }
  }

  static var connectionsV2: Data? {
    get { store.data(forKey: "native.connections.v2") }
    set {
      if let newValue { store.set(newValue, forKey: "native.connections.v2") }
      else { store.removeObject(forKey: "native.connections.v2") }
    }
  }

  static var theme: String { store.string(forKey: themeKey) ?? "dark" }
  static var connections: Data? {
    get { store.data(forKey: connectionsKey) }
    set {
      if let newValue { store.set(newValue, forKey: connectionsKey) }
      else { store.removeObject(forKey: connectionsKey) }
    }
  }

  // Non-secret Host metadata only; remote credentials have their own Keychain service.
  static var remoteHosts: Data? {
    get { store.data(forKey: remoteHostsKey) }
    set {
      if let newValue { store.set(newValue, forKey: remoteHostsKey) }
      else { store.removeObject(forKey: remoteHostsKey) }
    }
  }
}
