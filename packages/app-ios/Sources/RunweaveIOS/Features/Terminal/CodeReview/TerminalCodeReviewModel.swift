import Foundation

@MainActor
final class TerminalCodeReviewModel: ObservableObject {
  @Published var showingReport = false
  @Published private(set) var page: TerminalCodeReviewPage?
  @Published private(set) var writing = false
  @Published private(set) var failure: String?
  @Published private(set) var actionFailure: String?
  @Published private(set) var closing = false
  private weak var session: AppSession?
  private weak var controller: SessionController?
  private let terminalID: String
  private let generation: Int
  private var sequence = 0
  private var loading = false
  private var requestID: String?
  private var operation: Task<Void, Never>?
  init(session: AppSession, controller: SessionController, terminalID: String) {
    self.session = session; self.controller = controller; self.terminalID = terminalID; generation = session.generation
  }
  private var current: Bool {
    guard let session, let controller else { return false }
    return session.generation == generation && session.terminal?.id == terminalID && session.terminalController === controller
  }
  var canRead: Bool { current && session?.foreground == true && session?.authenticated == true && session?.health.status == .online }
  var canStart: Bool { canRead && !writing && !closing && latest?.active != true && !["pending", "writing"].contains(latest?.delivery ?? "") }
  var latest: TerminalCodeReviewRun? { page?.runs.first }
  var canDismissStatus: Bool {
    guard canRead, !writing, !closing, let latest else { return false }
    return !latest.caseEnded && !latest.active && !["pending", "writing"].contains(latest.delivery)
  }
  var statusVisible: Bool {
    writing || actionFailure != nil || (latest != nil && latest?.caseEnded != true)
  }
  func dismissStatus() {
    guard canDismissStatus, let latest, let session else { return }
    sequence += 1; loading = false; closing = true; actionFailure = nil
    let revision = sequence
    operation = Task { [weak self] in
      guard let self else { return }
      defer { if self.sequence == revision { self.closing = false; self.operation = nil } }
      do {
        _ = try await session.withConnection(reportFailure: false) { try await TerminalCodeReviewService(api: $0).close(latest.reviewId) }
      } catch {
        guard self.current, self.sequence == revision, !Task.isCancelled else { return }
        self.actionFailure = self.message(error)
      }
      guard self.current, self.sequence == revision, !Task.isCancelled else { return }
      self.closing = false
      await self.refresh()
      if self.latest?.caseEnded == true { self.actionFailure = nil }
    }
  }
  func poll() async {
    while canRead && !Task.isCancelled {
      await refresh()
      if failure == "此电脑尚不支持代码 Review" { return }
      do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
    }
  }
  private func message(_ error: Error) -> String {
    if case APIError.http(let status) = error, [404, 501].contains(status) { return "此电脑尚不支持代码 Review" }
    return displayError(error)
  }
  func refresh() async {
    guard canRead, !writing, !closing, !loading, let session else { return }
    let revision = sequence; loading = true
    defer { if revision == sequence { loading = false } }
    do {
      let value = try await session.withConnection(reportFailure: false) { try await TerminalCodeReviewService(api: $0).list(terminalID: self.terminalID) }
      guard current, revision == sequence, !Task.isCancelled else { return }
      page = value; failure = nil
      if value.runs.contains(where: { $0.requestId == requestID }) { requestID = nil }
    } catch {
      guard current, revision == sequence, !Task.isCancelled, !(error is CancellationError) else { return }
      failure = message(error)
    }
  }
  func start() {
    guard canStart, let session else { return }
    sequence += 1; loading = false; writing = true; actionFailure = nil
    let revision = sequence
    if requestID == nil { requestID = UUID().uuidString }
    let requestID = self.requestID!
    operation = Task { [weak self] in
      guard let self else { return }
      defer { if self.sequence == revision { self.writing = false; self.operation = nil } }
      do {
        _ = try await session.withConnection(reportFailure: false) {
          try await TerminalCodeReviewService(api: $0).start(terminalID: self.terminalID, requestID: requestID)
        }
        guard self.current, self.sequence == revision, !Task.isCancelled else { return }
        self.requestID = nil
      } catch {
        guard self.current, self.sequence == revision, !Task.isCancelled, !(error is CancellationError) else { return }
        self.actionFailure = self.message(error)
      }
      guard self.current, self.sequence == revision, !Task.isCancelled else { return }
      self.writing = false
      await self.refresh()
    }
  }
  func detail(_ id: String) async throws -> TerminalCodeReviewDetail {
    guard canRead, let session else { throw CancellationError() }
    let value = try await session.withConnection(reportFailure: false) { try await TerminalCodeReviewService(api: $0).detail(id) }
    guard current, !Task.isCancelled, value.run.reviewId == id else { throw CancellationError() }
    return value
  }
  func artifact(reviewID: String, artifact: TerminalCodeReviewReport.Artifact) async throws -> URL {
    guard canRead, let session else { throw CancellationError() }
    let url = try await session.withConnection(reportFailure: false) { try await TerminalCodeReviewService(api: $0).artifact(reviewID: reviewID, artifact: artifact) }
    guard current, !Task.isCancelled else {
      try? FileManager.default.removeItem(at: url.deletingLastPathComponent()); throw CancellationError()
    }
    return url
  }
  func suspend() {
    sequence += 1; operation?.cancel(); operation = nil; loading = false; writing = false; closing = false
    // Cancelling UI work never cancels the Backend run. Retain the request key after uncertain writes.
  }
}
