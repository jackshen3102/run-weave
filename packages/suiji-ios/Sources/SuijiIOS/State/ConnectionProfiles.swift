import Foundation

enum ConnectionEnvironment: String, Codable, CaseIterable, Identifiable {
  case production, development
  var id: String { rawValue }
  var label: String { self == .production ? "正式" : "开发" }
  // Preserve the existing production credential and draft keys when upgrading.
  func scoped(_ value: String) -> String { self == .production ? value : "development\n" + value }
}

struct ConnectionProfile: Codable {
  var endpoint = ""
  var username = ""
}

struct ConnectionProfiles: Codable {
  var active: ConnectionEnvironment = .production
  var production = ConnectionProfile()
  var development = ConnectionProfile()
  private static let key = "suiji.connections.v1"

  subscript(environment: ConnectionEnvironment) -> ConnectionProfile {
    get { environment == .production ? production : development }
    set { if environment == .production { production = newValue } else { development = newValue } }
  }

  static func restore(endpoint: URL?) -> Self {
    var profiles = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(Self.self, from: $0) }
      ?? Self(production: ConnectionProfile(endpoint: UserDefaults.standard.string(forKey: "suiji.endpoint") ?? ""))
    if let endpoint { profiles[profiles.active].endpoint = endpoint.absoluteString }
    return profiles
  }

  func save() {
    guard let data = try? JSONEncoder().encode(self) else { return }
    UserDefaults.standard.set(data, forKey: Self.key)
  }
}
