import Foundation

struct TerminalAgentSettingsResponse: Codable, Equatable {
  let settings: TerminalAgentSettings
  let models: [AgentModelOption]
}

struct TerminalAgentSettings: Codable, Equatable {
  let terminalSessionId: String
  let panelId: String?
  let threadId: String
  let provider: String
  let model: String
  let reasoningEffort: String?
  let revision: String
}

struct TerminalAgentSettingsFailure: Decodable, LocalizedError {
  enum CodingKeys: String, CodingKey { case code, message }
  let code: String
  let message: String
  var status: Int?
  var errorDescription: String? { message }

  static func decode(status: Int, data: Data) -> TerminalAgentSettingsFailure? {
    guard var failure = try? JSONDecoder().decode(TerminalAgentSettingsFailure.self, from: data) else { return nil }
    failure.status = status
    return failure
  }
}
