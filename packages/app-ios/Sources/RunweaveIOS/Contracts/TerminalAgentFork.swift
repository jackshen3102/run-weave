import Foundation

// Source: packages/shared/src/terminal/agent-fork.ts
struct TerminalAgentForkTarget: Decodable {
  let panelId: String
  let threadId: String
  let cwd: String
  let revision: String
}

struct ForkTerminalAgentResponse: Decodable {
  let terminalSessionId: String
  let panelId: String
  let threadId: String
  let sourceThreadId: String
  let status: String
}

struct TerminalAgentForkFailure: Decodable, LocalizedError {
  struct Details: Decodable { let terminalSessionId: String }
  let message: String
  let details: Details?
  var errorDescription: String? { message }
}
