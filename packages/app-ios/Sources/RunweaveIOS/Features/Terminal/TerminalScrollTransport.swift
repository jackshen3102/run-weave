import Foundation

/// Acknowledged scroll batches are transient; reconnect never replays old movement.
@MainActor
final class TerminalScrollTransport {
  var enabled = false
  var positionKnown: Bool { !enabled || state?.owner == "history" }
  private(set) var state: TerminalScrollState?
  private var sequence = 0
  private var inFlight: (id: String, sequence: Int)?
  private var pending: [(id: String, steps: Int, phase: String)] = []
  private weak var surface: SwiftTermSurface?
  private let canSend: () -> Bool
  private let send: ([String: Any]) -> Void
  private let record: (String, [String: Any]) -> Void

  init(surface: SwiftTermSurface, canSend: @escaping () -> Bool,
    send: @escaping ([String: Any]) -> Void, record: @escaping (String, [String: Any]) -> Void) {
    self.surface = surface
    self.canSend = canSend
    self.send = send
    self.record = record
    surface.usesNormalizedScroll = { [weak self] in self?.enabled ?? false }
    surface.normalizedScrollUsesHistory = { [weak self] in self?.state?.owner == "history" }
    surface.normalizedScroll = { [weak self] id, steps, phase in self?.enqueue(id, steps, phase) ?? false }
    surface.stopNormalizedScroll = { [weak self] id in self?.cancel(id) }
  }

  func reset() {
    surface?.cancelScroll()
    pending.removeAll()
    inFlight = nil
    state = nil
    enabled = false
  }

  func cancel(_ id: String) {
    pending.removeAll { $0.id == id }
    if inFlight?.id == id { inFlight = nil }
    if enabled { send(["type": "scroll-stop", "gestureId": id]) }
  }

  private func enqueue(_ id: String, _ steps: Int, _ phase: String) -> Bool {
    guard enabled, canSend() else { return false }
    if pending.last?.id != id { pending.removeAll() }
    if let last = pending.last, last.phase == phase, last.steps.signum() == steps.signum() {
      pending[pending.count - 1].steps += steps
    } else { pending.append((id, steps, phase)) }
    guard pending.reduce(0, { $0 + abs($1.steps) }) <= 512 else {
      surface?.cancelScroll()
      return false
    }
    flush()
    return true
  }

  func receive(_ state: TerminalScrollState) {
    self.state = state
    surface?.applyScrollState(state)
    if state.status == "cancelled" { pending.removeAll { $0.id == state.gestureId } }
    if let flight = inFlight, flight.id == state.gestureId, flight.sequence == state.sequence { inFlight = nil }
    flush()
    record("scroll.state", ["owner": state.owner, "copyMode": state.copyMode, "status": state.status])
  }

  private func flush() {
    guard canSend(), inFlight == nil, !pending.isEmpty else { return }
    let item = pending[0]
    let steps = item.steps.signum() * min(128, abs(item.steps))
    pending[0].steps -= steps
    if pending[0].steps == 0 { pending.removeFirst() }
    sequence += 1
    inFlight = (item.id, sequence)
    send(["type": "scroll", "gestureId": item.id, "sequence": sequence, "deltaSteps": steps, "phase": item.phase])
    record("scroll.sent", ["steps": steps, "phase": item.phase])
  }
}
