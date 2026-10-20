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
        let updated = try await session.withConnection(reportFailure: false) { api -> TaskWatch? in
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
        if let updated, updated.target.terminalSessionId != self.terminalID { throw APIError.invalidResponse }
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

  func history(watchID: String, cursor: String?) async throws -> SupervisionDecisionPage {
    guard canRead, let session, watch?.watchId == watchID else { throw APIError.invalidResponse }
    let result = try await session.withConnection(reportFailure: false) {
      try await TaskSupervisionService(api: $0).decisions(watchID: watchID, cursor: cursor)
    }
    guard current, !Task.isCancelled, watch?.watchId == watchID else { throw CancellationError() }
    return result
  }

  func detail(watchID: String, decisionID: String) async throws -> SupervisionDecision {
    guard canRead, let session, watch?.watchId == watchID else { throw APIError.invalidResponse }
    let result = try await session.withConnection(reportFailure: false) {
      try await TaskSupervisionService(api: $0).decision(watchID: watchID, decisionID: decisionID)
    }
    guard current, !Task.isCancelled, watch?.watchId == watchID else { throw CancellationError() }
    guard result.decisionId == decisionID, result.input != nil else { throw APIError.invalidResponse }
    return result
  }

  func suspend() {
    sequence += 1; operation?.cancel(); operation = nil
    loading = false; writing = false
    // Keep this terminal's last snapshot for offline display. Closing never sends pause.
  }

  func previewGoal(base: TaskWatch, content: SupervisionGoalContent?) async throws -> SupervisionGoalPreview {
    guard canRead, !writing, let session, watch?.watchId == base.watchId,
      watch?.target == base.target else { throw CancellationError() }
    let result = try await session.withConnection(reportFailure: false) {
      try await TaskSupervisionService(api: $0).previewGoal(watch: base, content: content)
    }
    guard canRead, !Task.isCancelled, watch?.watchId == base.watchId,
      watch?.target == base.target, result.target == base.target else { throw CancellationError() }
    return result
  }

  func applyGoal(watchID: String, preview: SupervisionGoalPreview) async throws {
    guard canRead, !writing, let session, watch?.watchId == watchID,
      watch?.target == preview.target, watch?.revision == preview.expectedRevision,
      preview.expiration > Date(), preview.requiresAdoption, !preview.needsClarification else {
      throw SupervisionFailure(message: "任务状态或预览已变化，请重新核对。")
    }
    sequence += 1; loading = false
    let request = sequence
    writing = true
    defer { if sequence == request { writing = false } }
    let updated = try await session.withConnection(reportFailure: false) {
      try await TaskSupervisionService(api: $0).applyGoal(watchID: watchID, previewID: preview.previewId)
    }
    guard current, sequence == request, !Task.isCancelled, updated.watchId == watchID,
      updated.target == preview.target else { throw CancellationError() }
    discovery?.watch = updated
  }

  func goals(watchID: String, cursor: String?) async throws -> SupervisionGoalPage {
    guard canRead, let session, watch?.watchId == watchID else { throw CancellationError() }
    let result = try await session.withConnection(reportFailure: false) {
      try await TaskSupervisionService(api: $0).goals(watchID: watchID, cursor: cursor)
    }
    guard canRead, !Task.isCancelled, watch?.watchId == watchID else { throw CancellationError() }
    return result
  }

  func goalDetail(watchID: String, revisionID: String) async throws -> SupervisionGoalDetail {
    guard canRead, let session, watch?.watchId == watchID else { throw CancellationError() }
    let result = try await session.withConnection(reportFailure: false) {
      try await TaskSupervisionService(api: $0).goal(watchID: watchID, revisionID: revisionID)
    }
    guard canRead, !Task.isCancelled, watch?.watchId == watchID,
      result.goal.revisionId == revisionID else { throw CancellationError() }
    return result
  }
}
