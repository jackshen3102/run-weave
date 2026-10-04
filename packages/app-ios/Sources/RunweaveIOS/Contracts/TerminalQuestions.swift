import Foundation

// Mirrors @runweave/shared/terminal/questions; these are live requests, not previews.
struct TerminalQuestionsResponse: Decodable {
  let capability: String
  let reason: String?
  let generation: String
  let target: Target?
  let requests: [TerminalQuestionRequest]
  struct Target: Decodable { let terminalId: String; let panelId: String; let threadId: String }
}

struct TerminalQuestionRequest: Decodable, Identifiable {
  var id: String { requestId }
  let requestId: String
  let generation: String
  let threadId: String
  let turnId: String
  let itemId: String
  let isBlocking: Bool
  let questions: [TerminalQuestion]
  let state: String
}

struct TerminalQuestion: Decodable, Identifiable {
  let id: String
  let header: String
  let question: String
  let isOther: Bool
  let isSecret: Bool
  let options: [Option]?
  struct Option: Decodable { let label: String; let description: String }
}
