import Foundation
import RunweaveRemoteDesktop
import SwiftUI

struct PairedRemoteHost: Codable, Identifiable {
  let target: RemoteTarget
  let backendConnectionID: String?
  var id: UUID { target.id }
}

struct RemoteDesktopPresentation: Identifiable {
  let id: UUID
  let host: PairedRemoteHost
  let session: RemoteDesktopSession
}

/// Root-owned presentation; never owns or changes the Backend session or terminal route.
@MainActor
final class RemoteDesktopCoordinator: ObservableObject {
  @Published private(set) var hosts: [PairedRemoteHost] = []
  @Published private(set) var storageError: String?
  @Published var managingHosts = false
  @Published private(set) var presentation: RemoteDesktopPresentation?
  private(set) var generation: UInt64 = 0
  private var pendingHostID: UUID?
  private var sceneActive = true
  let usage = RemoteUsageStore()

  init() {
    guard let data = DevicePreferences.remoteHosts else { return }
    do {
      let stored = try JSONDecoder().decode([PairedRemoteHost].self, from: data)
      guard Set(stored.map(\.id)).count == stored.count else { throw APIError.invalidResponse }
      hosts = stored
    } catch { storageError = "本地桌面配对配置无法读取，原数据已保留。" }
  }

  func save(_ host: PairedRemoteHost) throws {
    var next = hosts.filter { $0.id != host.id }
    next.append(host)
    try persist(next)
  }

  /// Shared by scanner and manual entry; publish success only after metadata commits.
  @discardableResult
  func savePairing(_ target: RemoteTarget, backendConnectionID: String? = nil) throws -> PairedRemoteHost {
    let previous = hosts.first { $0.id == target.id }
    let paired = PairedRemoteHost(target: target,
      backendConnectionID: backendConnectionID ?? previous?.backendConnectionID)
    do { try save(paired) }
    catch {
      try? RemoteCredentialStore().forget(target: target)
      throw error
    }
    if let previous, previous.target.credentialsReference != target.credentialsReference {
      try? RemoteCredentialStore().forget(target: previous.target)
    }
    MobileAnalytics.remoteEvent(.paired)
    return paired
  }

  func removeMetadata(_ id: UUID) throws {
    if presentation?.host.id == id { close(reason: "pairing_removed") }
    if pendingHostID == id { pendingHostID = nil }
    try persist(hosts.filter { $0.id != id })
  }

  func requestOpen(backendConnectionID: String?) {
    let matching = hosts.filter { backendConnectionID != nil && $0.backendConnectionID == backendConnectionID }
    if matching.count == 1, let host = matching.first { open(host) }
    else { managingHosts = true }
  }

  func open(_ host: PairedRemoteHost) {
    guard hosts.contains(where: { $0.id == host.id }), sceneActive else { return }
    if managingHosts {
      pendingHostID = host.id
      managingHosts = false
    } else {
      close(reason: "target_changed")
      let id = UUID()
      usage.start(id)
      let session = RemoteDesktopSession { [weak usage] event in usage?.observe(event, id: id) }
      presentation = RemoteDesktopPresentation(id: id, host: host, session: session)
    }
  }

  func managerDismissed() {
    let pending = pendingHostID
    pendingHostID = nil
    guard let id = pending, let host = hosts.first(where: { $0.id == id }) else { return }
    open(host)
  }

  func presentationAppeared(_ id: UUID) {
    guard sceneActive, let value = presentation, value.id == id else { return }
    connect(value)
  }

  func close(reason: String) {
    generation &+= 1
    presentation?.session.stop(reason: reason)
    if let id = presentation?.id { usage.end(id, reason: reason) }
    presentation = nil
  }

  func invalidate(reason: String) {
    pendingHostID = nil
    managingHosts = false
    close(reason: reason)
  }

  func setScenePhase(_ phase: ScenePhase) {
    let active = phase == .active
    guard active != sceneActive else { return }
    sceneActive = active
    generation &+= 1
    guard let value = presentation else { return }
    if active { connect(value) }
    else {
      value.session.stop(reason: "background")
    }
  }

  private func connect(_ value: RemoteDesktopPresentation) {
    generation &+= 1
    value.session.setPresentationActive(true)
    value.session.connect(target: value.host.target, context: RemoteSessionContext(
      targetID: value.host.id, generation: generation, presentationID: UUID()))
  }

  private func persist(_ next: [PairedRemoteHost]) throws {
    guard storageError == nil else { throw APIError.invalidResponse }
    let data = try JSONEncoder().encode(next)
    let previous = DevicePreferences.remoteHosts
    DevicePreferences.remoteHosts = data
    guard DevicePreferences.remoteHosts == data else {
      DevicePreferences.remoteHosts = previous
      throw MobileLoginFailure(message: "桌面配对配置保存失败，请检查存储后重试。")
    }
    hosts = next
  }
}
