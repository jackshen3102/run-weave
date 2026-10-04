import Foundation

struct TerminalConversation: Decodable {
  struct Target: Decodable, Equatable {
    let terminalSessionId: String
    let panelId: String?
    let threadId: String
    let provider: String
  }
  struct Message: Decodable, Identifiable, Equatable {
    let id: String
    let role: String
    let text: String
    let createdAt: String?
  }
  struct Turn: Decodable, Identifiable, Equatable {
    let id: String
    let messages: [Message]
  }
  let target: Target?
  let availability: String
  let readAt: String
  let partial: Bool
  let turns: [Turn]
}

struct TerminalConversationFailure: Decodable, LocalizedError {
  let code: String
  let message: String
  var errorDescription: String? { message }
}
