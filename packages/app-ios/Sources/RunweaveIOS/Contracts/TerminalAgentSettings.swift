import Foundation

struct TerminalAgentSettingsResponse: Decodable, Equatable {
  let settings: TerminalAgentSettings
  let models: [AgentModelOption]
}

struct TerminalAgentSettings: Decodable, Equatable {
  let terminalSessionId: String
  let panelId: String?
  let threadId: String
  let provider: String
  let model: String
  let reasoningEffort: String?
  let revision: String
}

struct TerminalAgentSettingsFailure: Decodable, LocalizedError {
  let code: String
  let message: String
  var errorDescription: String? { message }
}
