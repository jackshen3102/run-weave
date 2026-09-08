import Foundation

/// Mirrors packages/shared/src/terminal/runtime/websocket.ts. Unknown types are forward compatible.
enum TerminalMessage: Decodable {
  case connected(String, String?)
  case snapshot(String, Bool?)
  case output(String)
  case metadata(String, String?)
  case status(String, Int?)
  case exit(Int?)
  case error(String)
  case notice(String)
  case unknown

  private enum Keys: String, CodingKey {
    case type, terminalSessionId, runtimeKind, data, modes, cwd, activeCommand, status, exitCode,
      message
  }
  private struct Modes: Decodable { let bracketedPasteMode: Bool? }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    switch try c.decode(String.self, forKey: .type) {
    case "connected":
      let kind = try c.decodeIfPresent(String.self, forKey: .runtimeKind)
      guard kind == nil || kind == "tmux" || kind == "pty" else { throw APIError.invalidResponse }
      self = .connected(try c.decode(String.self, forKey: .terminalSessionId), kind)
    case "snapshot":
      self = .snapshot(
        try c.decode(String.self, forKey: .data),
        try c.decodeIfPresent(Modes.self, forKey: .modes)?.bracketedPasteMode)
    case "output": self = .output(try c.decode(String.self, forKey: .data))
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
