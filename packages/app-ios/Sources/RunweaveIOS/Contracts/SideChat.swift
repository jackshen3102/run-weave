import Foundation

struct SideChatSourceRef: Codable {
  let terminalSessionId: String
  let panelId: String
  let expectedPrimaryThreadId: String
  let lastCompletedTurnId: String
  var body: [String: Any] { ["terminalSessionId": terminalSessionId, "panelId": panelId,
    "expectedPrimaryThreadId": expectedPrimaryThreadId, "lastCompletedTurnId": lastCompletedTurnId] }
}
struct SideChatSourceSnapshot: Codable {
  struct Preview: Codable { let role: String; let text: String }
  let terminalSessionId: String
  let panelId: String
  let expectedPrimaryThreadId: String
  let lastCompletedTurnId: String
  let turnNumber: Int?
  let model: String
  let cwd: String
  let preview: [Preview]
  let permissions: String
}
struct SideChatRecord: Codable {
  let id: String
  let source: SideChatSourceSnapshot
  let status: String
  let version: Int
  let createdAt: String
  let endedAt: String?
}
struct SideChatTurn: Codable {
  let id: String
  let sideChatId: String
  let clientOperationId: String
  let state: String
  let acceptedAt: String
  let finishedAt: String?
  let errorCode: String?
  var busy: Bool { ["accepted", "running", "stopping", "unknown"].contains(state) }
}
struct SideChatMessage: Codable, Identifiable {
  let id: String
  let sideChatId: String
  let sequence: Int
  let turnId: String
  let turnState: String?
  let role: String
  let text: String
  let createdAt: String
}
struct SideChatSnapshot: Codable {
  let sideChat: SideChatRecord
  let currentTurn: SideChatTurn?
  var messages: [SideChatMessage]
  var beforeSequence: Int?
  let readAt: String
  let sourceStatus: String?
}
struct SideChatMessagePage: Codable { let messages: [SideChatMessage]; let beforeSequence: Int? }
struct SideChatCapabilities: Codable {
  let supported: Bool
  let reason: String?
  let source: SideChatSourceRef?
  let activeSideChatId: String?
}
struct SideChatOperation: Codable {
  let operationId: String
  let sideChatId: String
  let kind: String
  let state: String
  let turnId: String?
  let version: Int
}
struct SideChatWriteResponse: Decodable {
  let operation: SideChatOperation
  let version: Int
  let turnId: String?
  let sideChat: SideChatRecord?
}
struct SideChatFailure: Error, LocalizedError {
  let status: Int
  let code: String
  let message: String
  var errorDescription: String? { message }
}
