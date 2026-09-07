import Foundation
import SwiftUI

struct BackendConnection: Codable, Identifiable, Equatable {
  let id: String
  var name: String
  var url: String
  let createdAt: Date
  var scope: String { id + "\u{0}" + url }
}

@MainActor
final class ConnectionStore: ObservableObject {
  @Published private(set) var connections: [BackendConnection] = []
  @Published private(set) var activeID: String?
  @Published private(set) var storageError: String?
  private let defaults = UserDefaults.standard
  private let key = "native.connections.v1"
  private struct Stored: Codable {
    let connections: [BackendConnection]
    let activeID: String?
  }
  var active: BackendConnection? { connections.first { $0.id == activeID } }

  init() {
    guard let data = defaults.data(forKey: key) else { return }
    do {
      let stored = try JSONDecoder().decode(Stored.self, from: data)
      guard Set(stored.connections.map(\.id)).count == stored.connections.count else {
        throw APIError.invalidResponse
      }
      connections = try stored.connections.map { connection in
        var value = connection
        value.url = try APIClient.normalize(connection.url).absoluteString
        return value
      }
      activeID =
        connections.contains { $0.id == stored.activeID } ? stored.activeID : connections.first?.id
    } catch { storageError = "本地连接配置无法读取，原数据已保留。" }
  }

  func save(id: String?, name: String, url: String) throws {
    guard storageError == nil else { throw APIError.invalidResponse }
    let normalized = try APIClient.normalize(url)
    var next = connections
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if let id, let index = next.firstIndex(where: { $0.id == id }) {
      next[index].name = name.isEmpty ? next[index].name : name
      next[index].url = normalized.absoluteString
      try persist(next, active: activeID)
    } else {
      let value = BackendConnection(
        id: UUID().uuidString, name: name.isEmpty ? (normalized.host ?? "Runweave backend") : name,
        url: normalized.absoluteString, createdAt: Date())
      next.append(value)
      try persist(next, active: value.id)
    }
  }

  func select(_ id: String) throws {
    guard connections.contains(where: { $0.id == id }) else { return }
    try persist(connections, active: id)
  }

  func remove(_ id: String) throws {
    let next = connections.filter { $0.id != id }
    try persist(next, active: activeID == id ? next.first?.id : activeID)
  }

  private func persist(_ next: [BackendConnection], active: String?) throws {
    guard storageError == nil else { throw APIError.invalidResponse }
    let data = try JSONEncoder().encode(Stored(connections: next, activeID: active))
    defaults.set(data, forKey: key)
    connections = next
    activeID = active
  }
}
