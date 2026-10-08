import Foundation

@MainActor
final class TaskSupervisionModel: ObservableObject {
  @Published private(set) var discovery: SupervisionDiscovery?
  @Published private(set) var loading = false
  @Published private(set) var writing = false
  @Published private(set) var failure: String?
  @Published private(set) var actionFailure: String?
  private weak var session: AppSession?
  private weak var controller: SessionController?
  private let terminalID: String
  private let generation: Int
  private var sequence = 0
  private var operation: Task<Void, Never>?

  init(session: AppSession, controller: SessionController, terminalID: String) {
    self.session = session; self.controller = controller
    self.terminalID = terminalID; generation = session.generation
  }

  var watch: TaskWatch? { discovery?.watch }
  private var current: Bool {
    guard let session, let controller else { return false }
    return session.generation == generation && session.terminal?.id == terminalID
      && session.terminalController === controller
  }
  var canRead: Bool {
    current && session?.authenticated == true && session?.foreground == true
      && session?.health.status == .online
  }
  var canToggle: Bool {
    canRead && !writing && (watch?.enabled == true
      || (failure == nil && discovery?.capability.supported == true && discovery?.target != nil))
  }

  func poll() async {
    while canRead && !Task.isCancelled {
      await refresh()
      do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
    }
  }

  func refresh() async {
    guard canRead, !loading, !writing, let session else { return }
    sequence += 1
    let request = sequence
    loading = true
    defer { if sequence == request { loading = false } }
    do {
      let value = try await session.withConnection(reportFailure: false) {
        try await TaskSupervisionService(api: $0).discover(terminalID: self.terminalID)
      }
      guard current, sequence == request, !Task.isCancelled else { return }
      if let target = value.target, target.terminalSessionId != terminalID { throw APIError.invalidResponse }
      if let watch = value.watch, watch.target.terminalSessionId != terminalID { throw APIError.invalidResponse }
      discovery = value; failure = nil
    } catch {
      guard current, sequence == request, !Task.isCancelled, !(error is CancellationError) else { return }
      if case APIError.http(404) = error { failure = "当前服务版本不支持长任务监控" }
      else { failure = displayError(error) }
    }
  }

  func setEnabled(_ enabled: Bool) { change(enabled: enabled, retry: false) }
  func retryContinuation() { change(enabled: true, retry: true) }

  private func change(enabled: Bool, retry: Bool) {
    guard canToggle, retry || watch?.enabled != enabled, let session, let discovery else { return }
    // Supersede an in-flight read so its snapshot cannot overwrite the write result.
    sequence += 1; loading = false
    let request = sequence
    writing = true; actionFailure = nil
    let requestID = UUID().uuidString
    operation = Task { [weak self] in
      guard let self else { return }
      defer { if self.sequence == request { self.writing = false; self.operation = nil } }
      do {
        let updated = try await session.withConnection(reportFailure: false) { api in
          let service = TaskSupervisionService(api: api)
          if retry {
            guard let watch = discovery.watch, let decision = watch.currentDecisions.last,
              let inputVersion = discovery.inputVersion else { throw APIError.invalidResponse }
            return try await service.retry(watch: watch, decisionID: decision.decisionId, inputVersion: inputVersion)
          }
          if let watch = discovery.watch { return try await service.change(watch: watch, enabled: enabled) }
          guard enabled, let target = discovery.target else { throw APIError.invalidResponse }
          return try await service.start(target: target, requestID: requestID)
        }
        guard self.current, self.sequence == request, !Task.isCancelled else { return }
        guard updated.target.terminalSessionId == self.terminalID else { throw APIError.invalidResponse }
        self.discovery?.watch = updated
      } catch {
        guard self.current, self.sequence == request, !Task.isCancelled, !(error is CancellationError) else { return }
        if case APIError.http(409) = error {
          self.actionFailure = "监控状态已变化，已重新读取。请核对后重试。"
        } else {
          self.actionFailure = "操作未确认，请核对最新监控状态后再决定是否重试。\n" + displayError(error)
        }
      }
      guard self.current, self.sequence == request, !Task.isCancelled else { return }
      self.writing = false; self.operation = nil
      await self.refresh()
    }
  }

  func suspend() {
    sequence += 1; operation?.cancel(); operation = nil
    loading = false; writing = false
    // Keep this terminal's last snapshot for offline display. Closing never sends pause.
  }
}
