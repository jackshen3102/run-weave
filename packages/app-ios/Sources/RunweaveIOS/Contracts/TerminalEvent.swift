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
    let completionRevision: Int?
  }
}

struct TerminalEventMessage: Decodable {
  let type: String
  let streamId: String?
  let snapshot: DeviceStatusSnapshot?
  let gap: Gap?
  let events: [TerminalEvent]?
  let event: TerminalEvent?
  let message: String?
  struct Gap: Decodable { let reason: String }
  private enum CodingKeys: String, CodingKey { case type, streamId, snapshot, gap, events, event, message }
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    type = try values.decode(String.self, forKey: .type)
    streamId = try values.decodeIfPresent(String.self, forKey: .streamId)
    // Optional monitoring must never disable the terminal event stream on an incompatible frame.
    snapshot = try? values.decode(DeviceStatusSnapshot.self, forKey: .snapshot)
    gap = try values.decodeIfPresent(Gap.self, forKey: .gap)
    events = try values.decodeIfPresent([TerminalEvent].self, forKey: .events)
    event = try values.decodeIfPresent(TerminalEvent.self, forKey: .event)
    message = try values.decodeIfPresent(String.self, forKey: .message)
  }
}
