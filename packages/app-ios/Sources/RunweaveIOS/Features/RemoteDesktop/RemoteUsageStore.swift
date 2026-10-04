import Foundation
import Combine
import RunweaveRemoteDesktop

enum RemoteUsagePurpose: String, Codable, CaseIterable {
  case unknown, inspect, manualTask, agentBlocked, authorization, troubleshoot, other
  var label: String {
    switch self {
    case .unknown: return "未填写"
    case .inspect: return "查看 Mac 状态"
    case .manualTask: return "完成桌面操作"
    case .agentBlocked: return "处理 Agent 卡点"
    case .authorization: return "授权或登录"
    case .troubleshoot: return "排查连接或显示"
    case .other: return "其他"
    }
  }
}

enum RemoteUsageOutcome: String, Codable, CaseIterable {
  case unknown, resolved, unresolved, abandoned
  var label: String {
    switch self {
    case .unknown: return "未填写"
    case .resolved: return "已办成"
    case .unresolved: return "仍未解决"
    case .abandoned: return "放弃了"
    }
  }
}

struct RemoteUsageRecord: Codable, Identifiable {
  let id: UUID
  let startedAt: Date
  var lastObservedAt: Date
  var endedAt: Date?
  var endReason: String?
  let build: [String: String]
  let environment: String
  var attemptCount = 0
  var visibleAttemptCount = 0
  var readOnlyAttemptCount = 0
  var controlPermissionLossCount = 0
  var firstVisibleFrameMilliseconds: Double?
  var inputObserved = false
  var sentInputMessages: UInt64 = 0
  var receivedFrames: UInt64 = 0
  var droppedFrames: UInt64 = 0
  var completedAttemptMilliseconds: Double = 0
  var recentAttempts: [RemoteAttemptObservation] = []
  var purpose: RemoteUsagePurpose = .unknown
  var outcome: RemoteUsageOutcome = .unknown
}

/// Independent of Backend identity and connectivity. Writes are ordered off the main thread.
/// Bounds: last 100 presentations and last 20 completed attempts per presentation.
@MainActor
final class RemoteUsageStore: ObservableObject {
  @Published private(set) var records: [RemoteUsageRecord] = []
  @Published private(set) var storageWarning: String?
  private let queue = DispatchQueue(label: "runweave.remote-usage", qos: .utility)
  private let file: URL
  private var unreadable = false

  private struct Archive: Codable {
    var schemaVersion = 1
    let records: [RemoteUsageRecord]
  }

  init() {
    file = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("RemoteDesktopUsage/records.json")
    guard FileManager.default.fileExists(atPath: file.path) else { return }
    do {
      let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      guard size <= 2_000_000 else { throw APIError.invalidResponse }
      let archive = try JSONDecoder().decode(Archive.self, from: Data(contentsOf: file))
      guard archive.schemaVersion == 1 else { throw APIError.invalidResponse }
      records = Array(archive.records.suffix(100))
      for index in records.indices where records[index].endReason == nil {
        // Do not invent a crash time, normal close or task outcome after process death.
        records[index].endReason = "interrupted_unknown"
      }
      persist()
    } catch {
      unreadable = true
      storageWarning = "旧使用记录无法读取，已保留原文件；新记录仅在本次运行中可用。导出只包含本次运行的记录；清空将删除旧记录。"
    }
  }

  func start(_ id: UUID) {
    guard !records.contains(where: { $0.id == id }) else { return }
    #if targetEnvironment(simulator)
      let environment = "simulator"
    #else
      let environment = "device"
    #endif
    let now = Date()
    records.append(.init(id: id, startedAt: now, lastObservedAt: now,
      build: AppBuildMetadata.fields, environment: environment))
    records = Array(records.suffix(100))
    MobileAnalytics.remoteEvent(.opened)
    persist()
  }

  func observe(_ observation: RemoteDesktopObservation, id: UUID) {
    guard let index = records.firstIndex(where: { $0.id == id }), records[index].endReason == nil else { return }
    records[index].lastObservedAt = Date()
    switch observation {
    case .attemptStarted: records[index].attemptCount += 1
    case .firstVisibleFrame(let milliseconds, let readOnly):
      records[index].visibleAttemptCount += 1
      if readOnly { records[index].readOnlyAttemptCount += 1 }
      if records[index].firstVisibleFrameMilliseconds == nil {
        records[index].firstVisibleFrameMilliseconds = milliseconds
        MobileAnalytics.remoteEvent(.visible)
      }
    case .firstInputSent:
      if !records[index].inputObserved { MobileAnalytics.remoteEvent(.inputSent) }
      records[index].inputObserved = true
    case .controlBecameReadOnly:
      records[index].controlPermissionLossCount += 1
    case .attemptEnded(let summary):
      records[index].sentInputMessages &+= summary.sentInputMessages
      records[index].receivedFrames &+= summary.receivedFrames
      records[index].droppedFrames &+= summary.droppedFrames
      records[index].completedAttemptMilliseconds += summary.durationMilliseconds
      records[index].recentAttempts.append(summary)
      records[index].recentAttempts = Array(records[index].recentAttempts.suffix(20))
    }
    persist()
  }

  func end(_ id: UUID, reason: String) {
    guard let index = records.firstIndex(where: { $0.id == id }), records[index].endReason == nil else { return }
    let allowed = ["user_closed", "target_changed", "pairing_removed", "backend_session_changed",
      "backend_logged_out", "computer_changed", "hidden"]
    records[index].endReason = allowed.contains(reason) ? reason : "closed_unknown"
    records[index].endedAt = Date()
    records[index].lastObservedAt = Date()
    MobileAnalytics.remoteEvent(.closed)
    persist()
  }

  func feedback(_ id: UUID, purpose: RemoteUsagePurpose, outcome: RemoteUsageOutcome) {
    guard let index = records.firstIndex(where: { $0.id == id }) else { return }
    records[index].purpose = purpose; records[index].outcome = outcome
    persist()
  }

  func export() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("remote-usage-\(UUID()).json")
    let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    encoder.dateEncodingStrategy = .iso8601
    try encoder.encode(Archive(records: records)).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    return url
  }

  func clear() {
    records.removeAll(); unreadable = false
    persist()
  }

  private func persist() {
    guard !unreadable else { return }
    let archive = Archive(records: records), file = file
    queue.async { [weak self] in
      do {
        var directory = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        try JSONEncoder().encode(archive).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        Task { @MainActor [weak self] in self?.storageWarning = nil }
      } catch {
        Task { @MainActor [weak self] in self?.storageWarning = "使用记录保存失败；当前内存记录仍可导出。" }
      }
    }
  }
}
