import Foundation

@MainActor
final class ResourceMonitorModel: ObservableObject {
  struct Confirmation: Identifiable {
    let id = UUID()
    let process: ResourceProcess
    let force: Bool
    let hostID: String
    let streamID: String
    let permissionRevision: Int?
  }
  @Published private(set) var data: ResourceMonitorResponse?
  @Published private(set) var loading = false
  @Published private(set) var writing = false
  @Published private(set) var failure: String?
  @Published private(set) var message: String?
  @Published private(set) var results: [String: ResourceProcessResult] = [:]
  @Published var confirmation: Confirmation?
  let session: AppSession
  let generation: Int
  private var forceUntil: [String: Double] = [:]
  private var receivedAt = ProcessInfo.processInfo.systemUptime
  init(session: AppSession) { self.session = session; generation = session.generation }
  var current: Bool { session.generation == generation && session.authenticated }
  var stale: Bool {
    guard let data else { return true }
    return (data.sampleAgeMs ?? .infinity) / 1000 + max(0, ProcessInfo.processInfo.systemUptime - receivedAt) > 180
  }
  var canOperate: Bool {
    current && session.canWrite && failure == nil && !writing && !stale && data?.status == "ok" && data?.canTerminate == true
  }
  var apps: [ResourceApp] { data?.snapshot?.apps ?? [] }
  var energyAlerts: [ResourceAlert] { data?.alerts.filter { $0.ruleId == "energy" } ?? [] }
  var statusMessage: String? {
    if !current { return "登录或连接已变化，请重新进入" }
    if session.health.status != .online { return "电脑已离线 · 显示上次记录，当前不能结束进程" }
    if let failure { return failure }
    if stale, data?.status == "ok" { return "采样数据已过期 · 等待后台更新" }
    switch data?.status {
    case "disabled": return "后台监控已关闭"
    case "warming-up": return "正在准备采样"
    case "error": return "采样失败 · 后台将重试"
    case "stale": return "采样数据已过期 · 等待后台更新"
    case "unsupported": return "这台电脑不支持资源监控"
    default: return nil
    }
  }
  func processes(_ appKey: String) -> [ResourceProcess] {
    (data?.snapshot?.processes.filter { $0.appKey == appKey } ?? []).sorted {
      ($0.cpuPercent ?? -1) > ($1.cpuPercent ?? -1)
    }
  }
  func refresh() async {
    guard current, session.foreground, session.health.status == .online, !loading else { return }
    loading = true
    defer { loading = false }
    do {
      let next = try await session.withConnection(reportFailure: false) { try await $0.resources() }
      guard current, !Task.isCancelled else { return }
      guard next.protocolVersion == 1 else { failure = "资源协议暂不兼容，请更新电脑端"; confirmation = nil; return }
      if data?.hostId != next.hostId || data?.streamId != next.streamId { results = [:]; forceUntil = [:] }
      data = next; failure = nil; receivedAt = ProcessInfo.processInfo.systemUptime
      if let pending = confirmation, !valid(pending) { confirmation = nil; message = "权限或进程状态已变化，请重新选择" }
    } catch {
      guard current, !Task.isCancelled else { return }
      if case APIError.http(404) = error { failure = "电脑端暂不支持耗电监控，请更新后重试" }
      else { failure = displayError(error) }
      confirmation = nil
    }
  }
  func forceAllowed(_ id: String) -> Bool {
    results[id]?.forceAllowed == true && ProcessInfo.processInfo.systemUptime < (forceUntil[id] ?? 0)
  }
  func select(_ process: ResourceProcess) {
    guard canOperate, let data, process.processInstanceId != nil,
      process.actionKind == "terminate" || process.actionKind == "stop_service" else { return }
    message = nil
    confirmation = Confirmation(process: process, force: forceAllowed(process.id),
      hostID: data.hostId, streamID: data.streamId, permissionRevision: data.remoteControl?.revision)
  }
  func valid(_ pending: Confirmation) -> Bool {
    guard canOperate, let data, pending.hostID == data.hostId, pending.streamID == data.streamId,
      pending.permissionRevision == data.remoteControl?.revision,
      let process = data.snapshot?.processes.first(where: { $0.id == pending.process.id }) else { return false }
    return process.actionKind == "terminate" || process.actionKind == "stop_service"
  }
  func confirm(_ pending: Confirmation) async {
    // Re-read the real Backend permission before sending a signal; never retry a write.
    confirmation = nil
    await refresh()
    guard valid(pending), let id = pending.process.processInstanceId else { message = "权限或进程状态已变化，请重新选择"; return }
    writing = true
    defer { writing = false }
    let requestID = UUID().uuidString
    do {
      let result = try await session.withConnection(reportFailure: false) {
        try await $0.terminateResourceProcess(id, force: pending.force, requestID: requestID)
      }
      guard current else { return }
      guard result.requestId.lowercased() == requestID.lowercased(), result.processInstanceId == id else { throw APIError.invalidResponse }
      results[id] = result; message = result.message
      forceUntil[id] = result.forceAllowed ? ProcessInfo.processInfo.systemUptime + 175 : nil
    } catch {
      guard current else { return }
      if let failure = error as? ResourceMonitorFailure, failure.code == "force_not_allowed" { forceUntil[id] = nil }
      message = "操作未完成或结果未确认，请刷新查看；不会自动强制结束。\n" + displayError(error)
      await refresh()
    }
  }
  func settings(monitor: Bool, alerts: Bool) async {
    guard current, session.canWrite, !writing, let settings = data?.settings else { return }
    writing = true
    defer { writing = false }
    do {
      _ = try await session.withConnection(reportFailure: false) { try await $0.resourceSettings(settings, monitor: monitor, alerts: alerts) }
      guard current else { return }
      message = "设置已同步到这台电脑"
      await refresh()
    } catch { if current { message = displayError(error); await refresh() } }
  }
  func snooze(_ alert: ResourceAlert) async {
    guard current, session.canWrite, !writing else { return }
    writing = true
    defer { writing = false }
    do {
      try await session.withConnection(reportFailure: false) { try await $0.snoozeResourceAlert(alert.id) }
      guard current else { return }
      message = "已忽略 \(alert.appName) 的资源提醒 1 小时"
      await refresh()
    } catch { if current { message = displayError(error) } }
  }
}
