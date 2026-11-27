import Foundation

struct TerminalOutputCursor: Decodable {
  let streamId: String
  let offset: Int
}

struct TerminalOutputRange: Decodable {
  let streamId: String
  let fromOffset: Int
  let toOffset: Int
}

struct TerminalOutputRecovery: Decodable {
  enum Mode: String, Decodable { case snapshot, resume }
  let mode: Mode
  let reason: String
}

struct TerminalScrollState: Decodable {
  let owner: String
  let copyMode: Bool
  let offsetRows: Int?
  let paneId: String?
  let gestureId: String?
  let sequence: Int?
  let status: String
}

struct TerminalAnsiScrollbackResponse: Decodable {
  let terminalSessionId: String
  let paneId: String
  let sourceCols: Int
  let lineCount: Int
  let data: String
}

/// Mirrors packages/shared/src/terminal/runtime/websocket.ts. Unknown types are forward compatible.
enum TerminalMessage: Decodable {
  case connected(String, String?, TerminalOutputRecovery?, Bool)
  case scrollState(TerminalScrollState)
  case snapshot(String, Bool?, TerminalOutputCursor?, Int?, Int?)
  case output(String, TerminalOutputRange?)
  case metadata(String, String?)
  case status(String, Int?)
  case exit(Int?)
  case error(String)
  case notice(String)
  case unknown

  private enum Keys: String, CodingKey {
    case type, terminalSessionId, runtimeKind, data, modes, cwd, activeCommand, status, exitCode,
      message, recovery, cursor, range, cols, rows, scrollInput
  }
  private struct Modes: Decodable { let bracketedPasteMode: Bool? }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    switch try c.decode(String.self, forKey: .type) {
    case "connected":
      let kind = try c.decodeIfPresent(String.self, forKey: .runtimeKind)
      guard kind == nil || kind == "tmux" || kind == "pty" else { throw APIError.invalidResponse }
      self = .connected(
        try c.decode(String.self, forKey: .terminalSessionId), kind,
        try c.decodeIfPresent(TerminalOutputRecovery.self, forKey: .recovery),
        try c.decodeIfPresent(String.self, forKey: .scrollInput) == "normalized-v1")
    case "scroll-state": self = .scrollState(try TerminalScrollState(from: decoder))
    case "snapshot":
      self = .snapshot(
        try c.decode(String.self, forKey: .data),
        try c.decodeIfPresent(Modes.self, forKey: .modes)?.bracketedPasteMode,
        try c.decodeIfPresent(TerminalOutputCursor.self, forKey: .cursor),
        try c.decodeIfPresent(Int.self, forKey: .cols),
        try c.decodeIfPresent(Int.self, forKey: .rows))
    case "output":
      self = .output(
        try c.decode(String.self, forKey: .data),
        try c.decodeIfPresent(TerminalOutputRange.self, forKey: .range))
    case "metadata":
      self = .metadata(
        try c.decode(String.self, forKey: .cwd), try c.decode(String?.self, forKey: .activeCommand))
    case "status":
      let value = try c.decode(String.self, forKey: .status)
      guard value == "running" || value == "exited" else { throw APIError.invalidResponse }
      self = .status(value, try c.decodeIfPresent(Int.self, forKey: .exitCode))
    case "exit": self = .exit(try c.decode(Int?.self, forKey: .exitCode))
    case "error": self = .error(try c.decode(String.self, forKey: .message))
    case "notice": self = .notice(try c.decode(String.self, forKey: .message))
    default: self = .unknown
    }
  }
}
