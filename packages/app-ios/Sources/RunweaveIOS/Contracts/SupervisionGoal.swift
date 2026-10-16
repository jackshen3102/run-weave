import Foundation

/// Mirrors the goal contracts in packages/shared/src/task-supervision.ts.
struct SupervisionGoalContent: Codable, Equatable {
  var objective: String
  var completionCriteria: String
  var constraints: String

  var body: [String: Any] {
    ["objective": objective, "completionCriteria": completionCriteria, "constraints": constraints]
  }
  var valid: Bool {
    !objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !completionCriteria.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && objective.utf16.count <= 1500 && completionCriteria.utf16.count <= 2000 && constraints.utf16.count <= 2000
  }
}

struct SupervisionGoal: Codable {
  struct Plan: Codable {
    let path: String
    let sourceMessageId: String
    let authorizationMessageId: String
  }
  let objective: String
  let completionCriteria: String
  let constraints: String
  let threadId: String
  let revisionId: String
  let version: Int
  let origin: String
  let createdAt: String
  let sourceMessageIds: [String]
  let plans: [Plan]
  let manualInstruction: SupervisionMessage?

  var content: SupervisionGoalContent {
    .init(objective: objective, completionCriteria: completionCriteria, constraints: constraints)
  }
  var originLabel: String { origin == "manual" ? "手动修订" : "根据对话整理" }
}

struct SupervisionGoalDetail: Decodable {
  let goal: SupervisionGoal
  let messages: [SupervisionMessage]
  let plans: [SupervisionPlan]
  let reason: String
}

struct SupervisionGoalPreview: Decodable {
  let goal: SupervisionGoal
  let messages: [SupervisionMessage]
  let plans: [SupervisionPlan]
  let reason: String
  let previewId: String
  let expectedRevision: Int
  let target: SupervisionTarget
  let expiresAt: String
  let changed: Bool
  let needsClarification: Bool
  let requiresAdoption: Bool

  var detail: SupervisionGoalDetail { .init(goal: goal, messages: messages, plans: plans, reason: reason) }
  var expiration: Date {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: expiresAt) ?? ISO8601DateFormatter().date(from: expiresAt) ?? .distantPast
  }
}

struct SupervisionGoalPage: Decodable {
  struct Entry: Decodable, Identifiable {
    let goal: SupervisionGoal
    let reason: String
    var id: String { goal.revisionId }
  }
  let goals: [Entry]
  let nextCursor: String?
}

extension TaskWatch {
  var goalContent: SupervisionGoalContent {
    goalDefinition?.content ?? .init(objective: goalOverride ?? goal, completionCriteria: "", constraints: "")
  }
}
