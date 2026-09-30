import Foundation

struct TerminalAgentSettingsResponse: Decodable, Equatable {
  let settings: TerminalAgentSettings
  let models: [TerminalAgentModelOption]
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

struct TerminalAgentModelOption: Decodable, Identifiable, Equatable {
  let id: String
  let label: String
  let description: String
  let defaultReasoningEffort: String?
  let reasoningEfforts: [String]
}

struct TerminalAgentSettingsFailure: Decodable, LocalizedError {
  let code: String
  let message: String
  var errorDescription: String? { message }
}
