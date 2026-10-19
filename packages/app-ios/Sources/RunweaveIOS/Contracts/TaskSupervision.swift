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
  let availability: String?
}

struct SupervisionDeliverable: Codable {
  let id: String
  let kind: String
  let reference: String
  let sourceMessageId: String
  let readAt: String
  let availability: String
  let text: String?
  let digest: String?
  let version: String?
}

struct SupervisionDeliverables: Codable {
  let items: [SupervisionDeliverable]
  let omittedCount: Int
}

struct SupervisionInput: Codable {
  let task: SupervisionMessage
  let goal: String
  let plan: [SupervisionPlan]
  let userUpdates: [SupervisionMessage]
  let recentExchanges: [SupervisionMessage]
  let currentReply: SupervisionMessage
  let goalDefinition: SupervisionGoal?
  let previousContinuation: PreviousSupervisionContinuation?
  let deliverables: SupervisionDeliverables?

  var snapshot: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(self) else { return "输入快照无法显示" }
    return String(decoding: data, as: UTF8.self)
  }
}

struct PreviousSupervisionContinuation: Codable {
  let decisionId: String
  let reportMessageId: String
  let remainingWork: String
  let nextAction: String
  let authorizationMessageIds: [String]
  let noProgressCount: Int
}

struct SupervisionAssessment: Decodable {
  struct Criterion: Decodable {
    let text: String
    let state: String
    let sourceMessageIds: [String]
    let evidenceIds: [String]?
    let note: String
    var stateLabel: String {
      switch state {
      case "reported_done": return "据报告完成"
      case "pending": return "尚未完成"
      case "contradicted": return "存在矛盾"
      case "waived": return "用户已取消"
      default: return "资料不足"
      }
    }
  }
  struct Progress: Decodable {
    let state: String
    let note: String
    let previousDecisionId: String
    let sourceMessageIds: [String]
  }
  let version: Int
  let disposition: String
  let holdReason: String?
  let coverage: String
  let criteria: [Criterion]?
  let missingEvidence: [String]?
  let progress: Progress?
  let note: String?
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
  let goalVersion: Int?
  let model: String
  let codexVersion: String?
  let durationMs: Int
  let scores: Scores
  let assessment: SupervisionAssessment?
  let outcome: TaskOutcome
  let reason: String
  let sourceMessageIds: [String]
  let createdAt: String
  let input: SupervisionInput?
  let currentReplyId: String
  let goalPreview: String
  let delivery: String
  let deliveryDeadline: Double
  let deliveryBlock: String?
  var id: String { decisionId }
  var isHeld: Bool { assessment?.disposition == "hold" }
  var outcomeLabel: String {
    if isHeld { return "判断待核对 · 候选：\(outcome.label)（未采用）" }
    if assessment != nil && outcome == .completed { return "据报告完成" }
    return outcome.label
  }
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
  let goalOverride: String?
  let goalDefinition: SupervisionGoal?
  let goalState: String?
  let goalReason: String?
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
  let inputVersion: String?
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

struct SupervisionDecisionPage: Decodable {
  let decisions: [SupervisionDecision]
  let nextCursor: String?
}
