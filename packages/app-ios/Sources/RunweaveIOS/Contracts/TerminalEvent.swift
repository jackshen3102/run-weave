import Foundation

// Source: packages/shared/src/terminal/runtime/events.ts. IDs remain opaque strings.
struct TerminalEvent: Decodable {
  let id: String
  let kind: String
  let terminalSessionId: String?
  let payload: Payload
  struct Change: Decodable {
    let state: String?
    let agent: String?
    let cwd: String?
    let activeCommand: String?
  }
  struct Payload: Decodable {
    let next: Change?
    let previous: Change?
  }
}

struct TerminalEventMessage: Decodable {
  let type: String
  let streamId: String?
  let gap: Gap?
  let events: [TerminalEvent]?
  let event: TerminalEvent?
  let message: String?
  struct Gap: Decodable { let reason: String }
}
