import SuijiCaptureCore
import Foundation

typealias ConnectionEnvironment = SuijiCaptureCore.ConnectionEnvironment

struct ConnectionProfile: Codable {
  var endpoint = ""
  var username = ""
}

struct ConnectionProfiles: Codable {
  var active: ConnectionEnvironment = .production
  var production = ConnectionProfile()
  var development = ConnectionProfile()

  subscript(environment: ConnectionEnvironment) -> ConnectionProfile {
    get { environment == .production ? production : development }
    set { if environment == .production { production = newValue } else { development = newValue } }
  }

  static func restore(endpoint: URL?) -> Self {
    var profiles = DevicePreferences.connections.flatMap { try? JSONDecoder().decode(Self.self, from: $0) }
      ?? Self(production: ConnectionProfile(endpoint: DevicePreferences.legacyEndpoint))
    if let endpoint { profiles[profiles.active].endpoint = endpoint.absoluteString }
    return profiles
  }

  func save() {
    guard let data = try? JSONEncoder().encode(self) else { return }
    DevicePreferences.connections = data
  }
}
