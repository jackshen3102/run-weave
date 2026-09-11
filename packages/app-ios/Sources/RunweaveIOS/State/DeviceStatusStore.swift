import Foundation

@MainActor
final class DeviceStatusStore: ObservableObject {
  @Published private(set) var snapshot: DeviceStatusSnapshot?
  @Published private(set) var failure: String?
  private var receivedAt = ProcessInfo.processInfo.systemUptime
  private var epoch = 0
  private var socketRevision = 0
  private var task: Task<Void, Never>?

  func reset() {
    suspend()
    snapshot = nil
    failure = nil
    socketRevision = 0
  }

  func suspend() {
    epoch += 1
    task?.cancel()
    task = nil
  }

  func disconnected() { failure = "电脑连接已断开" }
  func unavailable(_ message: String) { failure = message }

  func refresh(_ api: APIClient) {
    suspend()
    let request = epoch
    let socketAtStart = socketRevision
    task = Task { [weak self] in
      do {
        let value = try await api.deviceStatus()
        guard let self, self.epoch == request, !Task.isCancelled else { return }
        // A current socket is authoritative, including a Backend restart during this GET.
        if self.socketRevision != socketAtStart { return }
        self.accept(value)
      } catch {
        guard let self, self.epoch == request, !Task.isCancelled else { return }
        if case APIError.http(404) = error {
          self.failure = "暂不支持电量监控"
        } else {
          self.failure = "电量暂不可用"
        }
      }
    }
  }

  func receive(_ value: DeviceStatusSnapshot) {
    socketRevision += 1
    accept(value)
  }

  private func accept(_ value: DeviceStatusSnapshot) {
    guard value.protocolVersion == 1, value.revision >= 0,
      value.battery.percent.map({ (0...100).contains($0) }) ?? true
    else { return }
    if let old = snapshot, old.streamId == value.streamId, old.revision > value.revision { return }
    snapshot = value
    receivedAt = ProcessInfo.processInfo.systemUptime
    failure = nil
  }

  var stale: Bool {
    guard let snapshot else { return false }
    let age =
      (snapshot.sampleAgeMs ?? .infinity) / 1000
      + max(0, ProcessInfo.processInfo.systemUptime - receivedAt)
    return failure != nil || snapshot.sampleStatus == "error" || age > 180
  }
}

@MainActor
final class ConnectionBatteryStore: ObservableObject {
  @Published private(set) var notificationAvailability: [String: DeviceNotificationStatus] = [:]
  @Published private(set) var devices: [String: DeviceStatusStore] = [:]

  func refresh(_ connections: [BackendConnection]) async {
    // Each small batch has at most three authenticated requests and no background sockets.
    for start in stride(from: 0, to: connections.count, by: 3) {
      guard !Task.isCancelled else { return }
      await withTaskGroup(of: Void.self) { group in
        for connection in connections[start..<min(start + 3, connections.count)] {
          let device = devices[connection.scope] ?? DeviceStatusStore()
          devices[connection.scope] = device
          group.addTask { @MainActor in
            guard let api = try? APIClient(base: connection.url, connectionID: connection.id) else {
              return
            }
            defer { Task { await api.close() } }
            guard await api.hasCredentials(), !Task.isCancelled else {
              device.unavailable("登录后查看电量")
              return
            }
            do {
              let value = try await api.deviceStatus()
              guard !Task.isCancelled else { return }
              device.receive(value)
              NotificationCoordinator.shared.note(value, connection: connection)
            } catch {
              if !Task.isCancelled {
                if case APIError.http(404) = error {
                  device.unavailable("暂不支持电量监控")
                } else {
                  device.unavailable("电量暂不可用")
                }
              }
            }
            do {
              let status = try await api.notificationStatus()
              guard !Task.isCancelled else { return }
              self.notificationAvailability[connection.scope] = status
            } catch {}

          }
        }
      }
    }
  }
}
