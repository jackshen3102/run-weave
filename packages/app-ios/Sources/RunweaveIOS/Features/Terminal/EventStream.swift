import Foundation

@MainActor
final class EventStream {
  var onEvents: (([TerminalEvent], Bool) -> Void)?
  var onResync: (() -> Void)?
  var onConnected: (() -> Void)?
  var onFailure: ((Error) async -> Bool)?
  private let api: APIClient
  private let network = URLSession(configuration: .ephemeral)
  private var task: Task<Void, Never>?
  private var socket: URLSessionWebSocketTask?
  private var generation = 0
  private var streamID: String?
  private var cursor: String?
  private var seen = Set<String>()
  private var seenOrder: [String] = []

  init(api: APIClient) { self.api = api }

  func start() {
    guard task == nil else { return }
    generation += 1
    let epoch = generation
    task = Task { [weak self] in
      guard let self else { return }
      while !Task.isCancelled, self.generation == epoch {
        do {
          let ticket = try await self.api.eventTicket()
          guard self.generation == epoch, !Task.isCancelled else { return }
          if let previous = self.streamID, previous != ticket.streamId { self.resetCursor() }
          self.streamID = ticket.streamId
          let ws = self.network.webSocketTask(
            with: try self.api.eventSocketURL(
              ticket: ticket.ticket, after: self.cursor ?? ticket.baselineEventId))
          ws.maximumMessageSize = 2 * 1024 * 1024
          self.socket = ws
          ws.resume()
          while self.socket === ws, !Task.isCancelled {
            let raw = try await ws.receive()
            guard self.generation == epoch, self.socket === ws else { return }
            let data: Data
            switch raw {
            case .string(let value): data = Data(value.utf8)
            case .data(let value): data = value
            @unknown default: throw APIError.invalidResponse
            }
            let message: TerminalEventMessage
            do { message = try JSONDecoder().decode(TerminalEventMessage.self, from: data) } catch {
              throw APIError.invalidResponse
            }
            switch message.type {
            case "connected":
              guard let id = message.streamId else { throw APIError.invalidResponse }
              if id != self.streamID {
                self.streamID = id
                self.resetCursor()
                throw URLError(.networkConnectionLost)
              }
              if message.gap != nil { self.resetCursor() }
              self.onConnected?()
              // Close the overview-read/ticket-baseline race with a fresh authoritative read.
              self.onResync?()
            case "terminal-events":
              guard let events = message.events else { throw APIError.invalidResponse }
              self.deliver(events, live: false)
            case "terminal-event":
              guard let event = message.event else { throw APIError.invalidResponse }
              self.deliver([event], live: true)
            case "error":
              throw message.message == "Unauthorized"
                ? APIError.credentialsUnavailable : APIError.invalidResponse
            default: break
            }
          }
        } catch {
          guard self.generation == epoch, !Task.isCancelled else { return }
          self.socket?.cancel(with: .goingAway, reason: nil)
          self.socket = nil
          let retry = await self.onFailure?(error) ?? false
          guard self.generation == epoch, !Task.isCancelled else { return }
          if !retry {
            self.task = nil
            return
          }
          try? await Task.sleep(nanoseconds: 1_200_000_000)
        }
      }
    }
  }

  private func deliver(_ values: [TerminalEvent], live: Bool) {
    var fresh: [TerminalEvent] = []
    for value in values where !seen.contains(value.id) {
      seen.insert(value.id)
      seenOrder.append(value.id)
      fresh.append(value)
      // The Backend delivers an ordered log; do not convert its cursor to Double/Int.
      cursor = value.id
    }
    // Covers the Backend's retained log while bounding client memory.
    if seenOrder.count > 10000 {
      let count = seenOrder.count - 10000
      for id in seenOrder.prefix(count) { seen.remove(id) }
      seenOrder.removeFirst(count)
    }
    if !fresh.isEmpty { onEvents?(fresh, live) }
  }

  private func resetCursor() {
    cursor = nil
    seen.removeAll()
    seenOrder.removeAll()
    onResync?()
  }

  func stop() {
    generation += 1
    task?.cancel()
    task = nil
    socket?.cancel(with: .normalClosure, reason: nil)
    socket = nil
  }

  func dispose() {
    stop()
    onEvents = nil
    onResync = nil
    onConnected = nil
    onFailure = nil
    network.invalidateAndCancel()
  }
}
