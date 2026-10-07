import Foundation

@MainActor
final class DevelopmentResourcesModel: ObservableObject {
  struct Confirmation: Identifiable {
    let id = UUID()
    let resource: DevelopmentResource
    let hostID: String
    let hostName: String
    let backendGeneration: String
  }
  struct Notice {
    let text: String
    let warning: Bool
  }
  @Published private(set) var data: DevelopmentResourcesSnapshot?
  @Published private(set) var loading = false
  @Published private(set) var writing = false
  @Published private(set) var releasingID: String?
  @Published private(set) var failure: String?
  @Published private(set) var notice: Notice?
  @Published var confirmation: Confirmation?
  private let session: AppSession
  private let generation: Int
  private let client: APIClient?
  private var snapshotInstanceID: String?
  private var visible = false
  private var readTask: Task<DevelopmentResourcesSnapshot, Error>?

  init(session: AppSession) {
    self.session = session
    generation = session.generation
    client = session.api
  }
  var current: Bool {
    session.generation == generation && session.api === client && session.authenticated
  }
  var canOperate: Bool {
    visible && current && session.canWrite && !writing && !loading && failure == nil
      && data != nil && snapshotInstanceID == session.health.serviceInstanceID
  }
  var statusMessage: String? {
    if !current { return "登录或连接已变化，请重新进入" }
    if session.health.status != .online {
      return data == nil ? "电脑暂时不可用，恢复连接后请手动刷新。"
        : "电脑暂时不可用，显示上次读取的数据。恢复后请手动刷新。"
    }
    if let failure { return failure }
    if data != nil && snapshotInstanceID != session.health.serviceInstanceID {
      return "电脑服务已重启，请手动刷新后操作。"
    }
    return nil
  }
  func enter() async {
    visible = true
    // Each navigation creates a new model. Re-appearing after a sheet does not fetch again.
    if data == nil && failure == nil { await refresh() }
  }
  func leave() {
    visible = false
    confirmation = nil
    readTask?.cancel()
  }
  func invalidateConfirmation() { confirmation = nil }
  func refresh() async {
    guard !writing else { return }
    notice = nil
    await readSnapshot()
  }
  private func readSnapshot() async {
    guard visible, current, session.foreground, session.health.status == .online,
      !loading, let client else { return }
    let instanceID = session.health.serviceInstanceID
    loading = true
    let task = Task { try await client.developmentResources() }
    readTask = task
    defer { readTask = nil; loading = false }
    do {
      let next = try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
      guard visible, current, !Task.isCancelled, instanceID == session.health.serviceInstanceID else { return }
      guard next.protocolVersion == 1, !next.hostId.isEmpty, !next.backendGeneration.isEmpty,
        Set(next.resources.map(\.id)).count == next.resources.count
      else { throw APIError.invalidResponse }
      if data?.hostId != next.hostId || data?.backendGeneration != next.backendGeneration { confirmation = nil }
      data = next
      snapshotInstanceID = instanceID
      failure = nil
      if let pending = confirmation, !valid(pending) { confirmation = nil }
    } catch {
      guard visible, current, !Task.isCancelled, !(error is CancellationError) else { return }
      if case APIError.http(404) = error { failure = "电脑端暂不支持开发资源，请更新电脑端后重试。" }
      else { failure = displayError(error) }
      confirmation = nil
      await session.handle(error, epoch: generation, reportFailure: false)
    }
  }
  func select(_ resource: DevelopmentResource) {
    guard canOperate, resource.canRelease, let data else { return }
    confirmation = Confirmation(resource: resource, hostID: data.hostId, hostName: data.hostName,
      backendGeneration: data.backendGeneration)
  }
  private func valid(_ pending: Confirmation) -> Bool {
    guard canOperate, let data, data.hostId == pending.hostID,
      data.backendGeneration == pending.backendGeneration,
      let resource = data.resources.first(where: { $0.id == pending.resource.id }) else { return false }
    return resource.canRelease && resource.ownershipVersion == pending.resource.ownershipVersion
      && resource.release.action == pending.resource.release.action
  }
  func confirm(_ pending: Confirmation) async {
    guard confirmation?.id == pending.id, valid(pending), let client else {
      confirmation = nil
      return
    }
    confirmation = nil
    writing = true
    releasingID = pending.resource.id
    notice = nil
    defer { writing = false; releasingID = nil }
    let requestID = UUID().uuidString
    do {
      // The Backend checks generation-bound ownership under its lifecycle lock.
      // Never re-send a business write after a 401, timeout or connection failure.
      let result = try await client.releaseDevelopmentResource(pending.resource, requestID: requestID)
      guard visible, current else { return }
      guard UUID(uuidString: result.operationId) != nil,
        ["released", "blocked", "running", "unknown"].contains(result.state) else { throw APIError.invalidResponse }
      notice = Notice(text: result.state == "running"
        ? "释放仍在进行，请稍后手动刷新查看结果。" : result.message, warning: result.state != "released")
    } catch {
      guard visible, current else { return }
      notice = Notice(text: "操作未完成或结果尚未确认，不会自动重试。\n" + displayError(error), warning: true)
      await session.handle(error, epoch: generation, reportFailure: false)
    }
    // One read after an explicit operation, never a timer or a polling loop.
    await readSnapshot()
  }
}
