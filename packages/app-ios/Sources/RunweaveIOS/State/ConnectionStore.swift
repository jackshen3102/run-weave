import Foundation
import SwiftUI

struct ConnectionRoute: Codable, Identifiable, Equatable {
  let id: String
  var name: String
  var url: String
}

struct BackendConnection: Codable, Identifiable, Equatable {
  let id: String
  var name: String
  var routes: [ConnectionRoute]
  var automatic: Bool
  var fixedRouteID: String?
  let createdAt: Date
  let credentialAccount: String
  /// Only this explicitly entered/login-approved URL may use the legacy, unpinned path.
  let bootstrapURL: String
  var scope: String { "computer:" + id }
  var url: String { routes.first?.url ?? bootstrapURL }

  init(id: String, name: String, url: String, createdAt: Date) {
    self.id = id; self.name = name; self.createdAt = createdAt
    routes = [ConnectionRoute(id: UUID().uuidString, name: "默认线路", url: url)]
    automatic = true; fixedRouteID = nil
    bootstrapURL = url
    credentialAccount = "computer:" + id
  }
  private enum CodingKeys: String, CodingKey {
    case id, name, url, routes, automatic, fixedRouteID, createdAt, credentialAccount, bootstrapURL
  }
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(String.self, forKey: .id)
    name = try values.decode(String.self, forKey: .name)
    createdAt = try values.decode(Date.self, forKey: .createdAt)
    if let savedRoutes = try values.decodeIfPresent([ConnectionRoute].self, forKey: .routes) {
      routes = savedRoutes
      automatic = try values.decode(Bool.self, forKey: .automatic)
      fixedRouteID = try values.decodeIfPresent(String.self, forKey: .fixedRouteID)
      credentialAccount = try values.decode(String.self, forKey: .credentialAccount)
      bootstrapURL = try values.decode(String.self, forKey: .bootstrapURL)
    } else {
      // Retained notification records may still embed a v1 connection. Reading them
      // does not import that connection or its credentials into the new connection list.
      let oldURL = try APIClient.normalize(values.decode(String.self, forKey: .url)).absoluteString
      routes = [ConnectionRoute(id: "legacy-" + id, name: "默认线路", url: oldURL)]
      automatic = true; fixedRouteID = nil
      bootstrapURL = oldURL
      credentialAccount = APIClient.diagnosticConnectionID(base: try APIClient.normalize(oldURL), id: id)
    }
    guard Set(routes.map(\.id)).count == routes.count,
      Set(routes.map(\.url)).count == routes.count,
      fixedRouteID == nil || routes.contains(where: { $0.id == fixedRouteID }) else { throw APIError.invalidResponse }
    for route in routes { _ = try APIClient.normalize(route.url) }
  }
  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(id, forKey: .id); try values.encode(name, forKey: .name)
    try values.encode(createdAt, forKey: .createdAt); try values.encode(routes, forKey: .routes)
    try values.encode(automatic, forKey: .automatic); try values.encodeIfPresent(fixedRouteID, forKey: .fixedRouteID)
    try values.encode(credentialAccount, forKey: .credentialAccount)
    try values.encode(bootstrapURL, forKey: .bootstrapURL)
  }
  @MainActor func client() async throws -> APIClient {
    try await ConnectionRouteResolver.forComputer(self).resolve()
  }
  func loginClient(url: String? = nil) throws -> APIClient {
    try APIClient(base: url ?? bootstrapURL, connectionID: id, credentialAccount: credentialAccount)
  }
}

@MainActor
final class ConnectionStore: ObservableObject {
  @Published private(set) var connections: [BackendConnection] = []
  @Published private(set) var activeID: String?
  @Published private(set) var storageError: String?
  private struct Stored: Codable {
    var schemaVersion: Int? = 2
    let connections: [BackendConnection]
    let activeID: String?
  }
  var active: BackendConnection? { connections.first { $0.id == activeID } }

  init() {
    guard let data = DevicePreferences.connectionsV2 else { return }
    do {
      let stored = try JSONDecoder().decode(Stored.self, from: data)
      guard stored.schemaVersion == 2,
        Set(stored.connections.map(\.id)).count == stored.connections.count else { throw APIError.invalidResponse }
      connections = stored.connections
      activeID = stored.activeID
      for connection in connections { ConnectionRouteResolver.register(connection) }
    } catch { storageError = "本地连接配置无法读取，原数据已保留。" }
  }

  func save(id: String?, name: String, url: String) throws {
    guard storageError == nil else { throw APIError.invalidResponse }
    let normalized = try Self.normalizeRouteURL(url)
    var next = connections
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if let id, let index = next.firstIndex(where: { $0.id == id }) {
      next[index].name = name.isEmpty ? next[index].name : name
      // Existing computers edit their addresses in the dedicated route editor.
      try persist(next, active: activeID)
    } else {
      let value = BackendConnection(id: UUID().uuidString,
        name: name.isEmpty ? (URL(string: normalized)?.host ?? "Runweave") : name,
        url: normalized, createdAt: Date())
      next.append(value)
      try persist(next, active: value.id)
    }
  }
  static func normalizeRouteURL(_ raw: String) throws -> String {
    guard let value = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
      value.query == nil, value.fragment == nil else { throw APIError.invalidURL }
    return try APIClient.normalize(raw).absoluteString
  }
  func update(_ value: BackendConnection) throws {
    guard let index = connections.firstIndex(where: { $0.id == value.id }) else { throw APIError.invalidResponse }
    var next = connections; next[index] = value
    try persist(next, active: activeID)
  }
  func saveRoute(computerID: String, routeID: String?, name: String, url: String) throws {
    guard var computer = connections.first(where: { $0.id == computerID }) else { throw APIError.invalidResponse }
    let normalized = try Self.normalizeRouteURL(url)
    let label = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !label.isEmpty, label.count <= 128 else { throw MobileLoginFailure(message: "请填写线路名称（最多 128 字）") }
    guard !computer.routes.contains(where: { $0.id != routeID && $0.url == normalized }) else { throw MobileLoginFailure(message: "此地址已在当前电脑的线路中") }
    if let routeID, let index = computer.routes.firstIndex(where: { $0.id == routeID }) {
      computer.routes[index].name = label; computer.routes[index].url = normalized
    } else { computer.routes.append(ConnectionRoute(id: UUID().uuidString, name: label, url: normalized)) }
    try update(computer)
  }
  func select(_ id: String) throws {
    guard connections.contains(where: { $0.id == id }) else { return }
    try persist(connections, active: id)
  }
  struct PreparedMobileConnection {
    let connection: BackendConnection
    let existing: BackendConnection?
  }
  func prepareMobileLogin(base: String, name: String) throws -> PreparedMobileConnection {
    guard storageError == nil else { throw APIError.invalidResponse }
    let url = try MobileLoginQR.validatedBase(base).absoluteString
    if let existing = connections.first(where: { $0.routes.contains(where: { $0.url == url }) }) {
      return PreparedMobileConnection(connection: existing, existing: existing)
    }
    return PreparedMobileConnection(connection: BackendConnection(id: UUID().uuidString, name: name, url: url, createdAt: Date()), existing: nil)
  }
  func commitMobileLogin(_ prepared: PreparedMobileConnection) throws {
    let current = connections.first { $0.id == prepared.connection.id }
    guard current == prepared.existing else { throw MobileLoginFailure(message: "连接配置已改变，请重新扫码。") }
    var next = connections
    if current == nil {
      guard !connections.contains(where: { $0.routes.contains(where: { $0.url == prepared.connection.url }) }) else {
        throw MobileLoginFailure(message: "此地址已添加，请重新扫码以使用已有连接。")
      }
      next.append(prepared.connection)
    }
    try persist(next, active: activeID)
  }
  func remove(_ id: String) throws {
    let next = connections.filter { $0.id != id }
    try persist(next, active: activeID == id ? next.first?.id : activeID)
    ConnectionRouteResolver.remove(id)
  }
  private func persist(_ next: [BackendConnection], active: String?) throws {
    guard storageError == nil else { throw APIError.invalidResponse }
    let data = try JSONEncoder().encode(Stored(connections: next, activeID: active))
    let previous = DevicePreferences.connectionsV2
    DevicePreferences.connectionsV2 = data
    guard DevicePreferences.connectionsV2 == data else {
      DevicePreferences.connectionsV2 = previous
      throw MobileLoginFailure(message: "本地连接保存失败，请检查存储后重试。")
    }
    connections = next; activeID = active
    for connection in next { ConnectionRouteResolver.register(connection) }
  }
}
