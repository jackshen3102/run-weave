import Foundation

@MainActor
final class ConnectionCompletionStore: ObservableObject {
  struct RefreshKey: Equatable {
    let connections: [BackendConnection]
    let generation: Int
    let enabled: Bool
  }
  struct Observation {
    let connection: BackendConnection
    let snapshot: TerminalUnreadSnapshot
    var stale: Bool
  }
  @Published private var observations: [String: Observation] = [:]
  private var refreshing = false
  private var epoch = 0

  func clear() { epoch += 1; observations.removeAll() }

  private func current(_ connection: BackendConnection) -> Observation? {
    guard let value = observations[connection.id], value.connection == connection else { return nil }
    return value
  }
  private func hosts(in connections: [BackendConnection]) -> [String: Observation] {
    var hosts: [String: Observation] = [:]
    for connection in connections {
      guard let value = current(connection) else { continue }
      let previous = hosts[value.snapshot.hostId]
      if previous == nil || previous!.snapshot.revision < value.snapshot.revision
        || (previous!.snapshot.revision == value.snapshot.revision && previous!.stale && !value.stale) {
        hosts[value.snapshot.hostId] = value
      }
    }
    return hosts
  }
  func count(for connection: BackendConnection, in connections: [BackendConnection]) -> Int {
    guard let value = current(connection) else { return 0 }
    return hosts(in: connections)[value.snapshot.hostId]?.snapshot.count ?? 0
  }
  func status(_ connection: BackendConnection) -> String? {
    guard let value = current(connection) else { return nil }
    return value.stale ? "离线 · 上次同步" : "已连接"
  }
  func otherTotal(in connections: [BackendConnection], activeID: String?) -> Int {
    guard let active = connections.first(where: { $0.id == activeID }), let host = current(active)?.snapshot.hostId
    else { return 0 }
    return hosts(in: connections).filter { $0.key != host }.values.reduce(0) { $0 + $1.snapshot.count }
  }

  func refresh(_ connections: [BackendConnection]) async {
    guard !refreshing else { return }
    refreshing = true
    defer { refreshing = false }
    let epoch = self.epoch
    observations = observations.filter { _, value in connections.contains(value.connection) }
    // Resolve through each computer's shared route/credential owner, with bounded concurrency.
    for start in stride(from: 0, to: connections.count, by: 3) {
      guard !Task.isCancelled, epoch == self.epoch else { return }
      await withTaskGroup(of: Void.self) { group in
        for connection in connections[start..<min(start + 3, connections.count)] {
          group.addTask { @MainActor in await self.refresh(connection, epoch: epoch) }
        }
      }
    }
  }
  private func refresh(_ connection: BackendConnection, epoch: Int) async {
    do {
      let credentials = try ComputerCredentialSession.shared(account: connection.credentialAccount)
      guard await credentials.hasCredentials() else {
        if epoch == self.epoch { observations.removeValue(forKey: connection.id) }
        return
      }
      let api = try await connection.client()
      guard !Task.isCancelled, epoch == self.epoch else { return }
      let snapshot = try await api.terminalUnread()
      guard !Task.isCancelled, epoch == self.epoch else { return }
      guard await credentials.hasCredentials() else {
        observations.removeValue(forKey: connection.id)
        return
      }
      guard UUID(uuidString: snapshot.hostId) != nil, snapshot.revision >= 0, snapshot.count >= 0
      else { throw APIError.invalidResponse }
      if let old = current(connection), old.snapshot.hostId == snapshot.hostId,
        old.snapshot.revision > snapshot.revision { return }
      observations[connection.id] = Observation(connection: connection, snapshot: snapshot, stale: false)
    } catch {
      guard !Task.isCancelled, epoch == self.epoch else { return }
      switch error {
      case APIError.credentialsUnavailable, APIError.refreshResultUnknown, APIError.http(401),
        APIError.http(403), ConnectionIdentityFailure.loginRequired,
        ConnectionIdentityFailure.identityMismatch, ConnectionIdentityFailure.invalidProof:
        observations.removeValue(forKey: connection.id)
      default:
        observations[connection.id]?.stale = true
      }
    }
  }
}
