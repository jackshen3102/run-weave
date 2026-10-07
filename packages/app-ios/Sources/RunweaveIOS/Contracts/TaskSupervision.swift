import Foundation

/// Mirrors packages/shared/src/task-supervision.ts; all decisions and quotas belong to Backend.
struct SupervisionTarget: Codable, Equatable {
  let terminalSessionId: String
  let panelId: String
  let threadId: String
  let executorGeneration: String

  var body: [String: Any] {
    ["terminalSessionId": terminalSessionId, "panelId": panelId,
      "threadId": threadId, "executorGeneration": executorGeneration]
  }
}

struct SupervisionMessage: Codable, Identifiable {
  let id: String
  let role: String
  let text: String
  let createdAt: String?
  let rawTurnId: String?
  let phase: String?
}

struct SupervisionPlan: Codable {
  let path: String
  let digest: String
  let text: String
}

struct SupervisionInput: Codable {
  let task: SupervisionMessage
  let goal: String
  let plan: [SupervisionPlan]
  let userUpdates: [SupervisionMessage]
  let recentExchanges: [SupervisionMessage]
  let currentReply: SupervisionMessage

  var snapshot: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(self) else { return "输入快照无法显示" }
    return String(decoding: data, as: UTF8.self)
  }
}

enum TaskOutcome: String, Codable, CaseIterable {
  case completed, blocked, `continue`
  var label: String {
    switch self {
    case .completed: return "任务已完成"
    case .blocked: return "需要你处理"
    case .continue: return "任务可以继续"
    }
  }
}

struct SupervisionDecision: Decodable, Identifiable {
  struct Scores: Decodable {
    let completed: Double
    let blocked: Double
    let `continue`: Double
    func value(_ outcome: TaskOutcome) -> Double {
      switch outcome {
      case .completed: return completed
      case .blocked: return blocked
      case .continue: return `continue`
      }
    }
  }
  let decisionId: String
  let threadId: String?
  let rawTurnId: String
  let replyDigest: String
  let contextRevision: Int
  let model: String
  let codexVersion: String?
  let durationMs: Int
  let scores: Scores
  let outcome: TaskOutcome
  let reason: String
  let sourceMessageIds: [String]
  let createdAt: String
  let input: SupervisionInput
  let delivery: String
  let deliveryDeadline: Double
  var id: String { decisionId }
  var deliveryLabel: String {
    switch delivery {
    case "not_requested": return "本次未续接"
    case "offered": return "已投递 · 等待原会话确认"
    case "observed": return "原会话已接收"
    case "unknown": return "接收待确认"
    default: return delivery
    }
  }
}

struct TaskWatch: Decodable {
  let watchId: String
  let enabled: Bool
  let enabledAt: String
  let target: SupervisionTarget
  let taskStartMessageId: String
  let task: SupervisionMessage
  let goal: String
  let plans: [SupervisionPlan]
  let revision: Int
  let contextRevision: Int
  let status: String
  let outcome: TaskOutcome?
  let continuationLimit: Int
  let continuationCount: Int
  let pauseReason: String?
  let error: String?
  let waitingFor: String?
  let lastFinalMessageId: String?
  let createdAt: String
  let updatedAt: String
  let decisions: [SupervisionDecision]
}

struct SupervisionDiscovery: Decodable {
  struct Capability: Decodable {
    let supported: Bool
    let reason: String?
    let codexVersion: String?
    let hookVersion: Int?
  }
  let target: SupervisionTarget?
  var watch: TaskWatch?
  let capability: Capability
  let taskCandidates: [SupervisionMessage]
}

struct SupervisionFailure: Decodable, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}
