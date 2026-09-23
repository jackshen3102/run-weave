import Foundation

// Mirrors packages/shared/src/scheduled-tasks/{types,api}.ts. Backend owns scheduling.
struct ScheduledTaskSchedule: Codable, Hashable {
  var kind = "daily"
  var timezone = TimeZone.current.identifier
  var localTime: String? = "09:00"
  var weekdays: [Int]?
  var runAt: String?
  var body: [String: Any] {
    var value: [String: Any] = ["kind": kind, "timezone": timezone]
    if kind == "once" { value["runAt"] = runAt ?? "" }
    else {
      value["localTime"] = localTime ?? "09:00"
      if kind == "weekly" { value["weekdays"] = weekdays ?? [] }
    }
    return value
  }
  var label: String {
    let days = ["日", "一", "二", "三", "四", "五", "六"]
    let frequency: String
    switch kind {
    case "daily": frequency = "每天"
    case "weekdays": frequency = "工作日"
    case "weekly": frequency = "每周" + (weekdays ?? []).compactMap { days.indices.contains($0) ? days[$0] : nil }.joined(separator: "、")
    case "once": return "仅一次 · " + scheduledDate(runAt, timezone: timezone) + " · " + timezone
    default: frequency = kind
    }
    return "\(frequency) \(localTime ?? "") · \(timezone)"
  }
}
struct ScheduledMisfirePolicy: Codable, Equatable {
  var mode = "catch-up-latest"
  var maxDelaySeconds: Int? = 86400
  var body: [String: Any] {
    mode == "skip" ? ["mode": mode] : ["mode": mode, "maxDelaySeconds": maxDelaySeconds ?? 86400]
  }
  var label: String { mode == "skip" ? "错过就跳过" : "恢复后补最近一次（\((maxDelaySeconds ?? 86400) / 3600) 小时内）" }
}
struct ScheduledTaskConfig: Codable, Equatable {
  var name = ""
  var projectId = ""
  var provider = "codex"
  var prompt = ""
  var model: String?
  var effort: String?
  var executionPolicy: String?
  var schedule = ScheduledTaskSchedule()
  var misfirePolicy = ScheduledMisfirePolicy()
  func body(editing: Bool) -> [String: Any] {
    var value: [String: Any] = ["name": name.trimmingCharacters(in: .whitespacesAndNewlines),
      "projectId": projectId, "provider": provider, "prompt": prompt.trimmingCharacters(in: .whitespacesAndNewlines),
      "schedule": schedule.body, "misfirePolicy": misfirePolicy.body]
    if let executionPolicy { value["executionPolicy"] = executionPolicy }
    for (key, field) in [("model", model), ("effort", effort)] {
      if let field, !field.isEmpty { value[key] = field }
      else if editing { value[key] = NSNull() }
    }
    return value
  }
}
struct ScheduledTaskRecord: Decodable, Identifiable {
  let id: String
  let revision: Int
  let enabled: Bool
  let nextRunAt: String?
  let deletedAt: String?
  let config: ScheduledTaskConfig
  enum CodingKeys: String, CodingKey { case id, revision, enabled, nextRunAt, deletedAt }
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    revision = try c.decode(Int.self, forKey: .revision)
    enabled = try c.decode(Bool.self, forKey: .enabled)
    nextRunAt = try c.decodeIfPresent(String.self, forKey: .nextRunAt)
    deletedAt = try c.decodeIfPresent(String.self, forKey: .deletedAt)
    config = try ScheduledTaskConfig(from: decoder)
  }
}
struct ScheduledTaskSource: Codable, Equatable {
  let type: String
  let taskId: String
  let runId: String
}
struct ScheduledTerminalBinding: Decodable {
  let terminalSessionId: String
  let panelId: String
  let attachmentState: String
  let error: String?
}
struct ScheduledOpenResponse: Decodable {
  let terminalSessionId: String
  let panelId: String
  let attachmentState: String
  let projectId: String
  let error: String?
}
struct ScheduledRun: Decodable, Identifiable {
  struct Dispatch: Decodable { let evaluatedAt: String; let latenessMs: Double; let catchUp: Bool; let coalescedFrom: String? }
  struct Failure: Decodable { let code: String; let message: String }
  struct Artifact: Decodable { let label: String; let kind: String; let url: String?; let text: String?; let fileRef: String? }
  struct Thread: Decodable { let provider: String; let threadId: String }
  let id: String
  let taskId: String
  let taskRevision: Int
  let snapshot: ScheduledTaskConfig
  let trigger: String
  let scheduledFor: String
  let dispatch: Dispatch?
  let status: String
  let startedAt: String?
  let finishedAt: String?
  let summary: String?
  let outcome: String?
  let error: Failure?
  let artifacts: [Artifact]
  let executionProjectId: String
  let cwd: String
  let threadRef: Thread?
  let recoverable: Bool
  let terminalBinding: ScheduledTerminalBinding?
  var active: Bool { ["queued", "running", "stopping"].contains(status) }
  var canOpen: Bool { !active && recoverable && threadRef != nil }
  var statusLabel: String {
    if outcome == "blocked" { return "执行受阻" }
    if outcome == "failed" { return "执行失败" }
    if status == "completed" { return outcome == "succeeded" ? "已完成" : "运行已结束" }
    return ["queued": "排队中", "running": "运行中", "stopping": "停止中", "waiting": "等待处理",
      "failed": "失败", "cancelled": "已停止", "skipped": "已跳过"][status] ?? status
  }
}
struct ScheduledPage<T: Decodable>: Decodable { let items: [T]; let nextCursor: String? }
struct ScheduledCapabilities: Decodable {
  struct Provider: Decodable, Identifiable {
    let provider: String; let available: Bool; let reason: String?; let executionPolicies: [String]?
    var id: String { provider }
  }
  let enabled: Bool
  let reason: String?
  let providers: [Provider]
}
struct ScheduledPreview: Decodable { let now: String; let occurrences: [String] }
struct ScheduledOutput: Decodable { let text: String; let nextCursor: String; let hasMore: Bool }
struct ScheduledProjectContext: Decodable, Identifiable {
  let projectId: String; let parentProjectId: String; let name: String; let isPrimary: Bool; let availability: String
  var id: String { projectId }
}
struct ScheduledModelSettings: Decodable {
  struct Model: Decodable, Identifiable { let id: String; let label: String; let reasoningEfforts: [String]; let defaultReasoningEffort: String? }
  struct Catalog: Decodable { let availability: String; let models: [Model] }
  let catalogs: [String: Catalog]
}
struct ScheduledFailure: Error, Decodable, LocalizedError {
  let code: String
  let message: String
  var errorDescription: String? {
    switch code {
    case "revision_conflict": return "任务已在其他端修改，请加载最新配置后重新编辑。当前草稿已保留。"
    case "terminal_repurposed": return "原终端已用于另一个对话。"
    case "busy", "task_busy": return "此任务已有未结束的运行。"
    default: return message
    }
  }
}
func scheduledDate(_ value: String?, timezone: String? = nil) -> String {
  guard let value, let date = scheduledParseDate(value) else { return "—" }
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "zh_CN")
  formatter.timeZone = timezone.flatMap(TimeZone.init(identifier:)) ?? .current
  formatter.dateFormat = "MM-dd HH:mm:ss"
  return formatter.string(from: date)
}
func scheduledParseDate(_ value: String) -> Date? {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let date = formatter.date(from: value) { return date }
  formatter.formatOptions = [.withInternetDateTime]
  return formatter.date(from: value)
}
