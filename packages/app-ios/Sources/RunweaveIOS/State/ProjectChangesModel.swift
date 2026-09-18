import Foundation
import Combine

/// One terminal's project summary, shared by its badge, Changes and Files views.
@MainActor
final class ProjectChangesModel: ObservableObject {
  @Published private(set) var changes: PreviewChanges?
  @Published private(set) var loading = false
  @Published private(set) var failure: String?
  @Published private(set) var mutating = false
  @Published private(set) var mutationRevision = 0
  private weak var session: AppSession?
  private let projectID: String
  private let terminalID: String
  private let generation: Int
  private var loadID = UUID()
  private var loadTask: Task<Void, Never>?

  init(session: AppSession, terminal: TerminalDetails) {
    self.session = session
    projectID = terminal.projectId
    terminalID = terminal.id
    generation = session.generation
  }

  var count: Int? { changes.map { $0.staged.count + $0.working.count } }

  private func isCurrent(_ session: AppSession) -> Bool {
    session.generation == generation && session.terminal?.id == terminalID
      && session.terminal?.projectId == projectID && session.authenticated
  }

  func mutate(_ mutation: PreviewMutation) async throws {
    guard !mutating, let session, isCurrent(session) else { throw CancellationError() }
    mutating = true
    defer { mutating = false }
    do {
      try await session.withConnection(reportFailure: false) {
        try await $0.mutatePreview(projectID: self.projectID, mutation: mutation)
      }
    } catch {
      // A failed response does not prove the disk was unchanged; do not retry writes.
      if isCurrent(session) {
        cancel()
        await refresh(force: true)
      }
      throw error
    }
    guard isCurrent(session) else { throw CancellationError() }
    cancel()
    mutationRevision += 1
    await refresh(force: true)
  }

  func refresh(force: Bool = false) async {
    guard !Task.isCancelled, let session, isCurrent(session),
      session.foreground, session.health.status == .online else { return }
    // A manual refresh can share a read already in flight instead of cancelling it.
    if let loadTask { await loadTask.value; return }
    let request = UUID()
    loadID = request
    loading = true
    failure = nil
    let task = Task { await load(session: session, request: request, force: force) }
    loadTask = task
    await task.value
  }

  func cancel() {
    loadID = UUID()
    loadTask?.cancel()
    loadTask = nil
    loading = false
  }

  private func load(session: AppSession, request: UUID, force: Bool) async {
    defer { if loadID == request { loading = false; loadTask = nil } }
    do {
      if changes == nil, let api = session.api {
        let saved: PreviewChanges? = await api.previewSnapshot(
          projectID: projectID, resource: "git-changes")
        guard !Task.isCancelled, loadID == request, isCurrent(session) else { return }
        changes = saved
      }
      let value = try await session.withConnection(reportFailure: false) {
        try await $0.changes(projectID: self.projectID, force: force)
      }
      guard !Task.isCancelled, loadID == request, isCurrent(session) else { return }
      changes = value
    } catch {
      guard !Task.isCancelled, loadID == request, isCurrent(session) else { return }
      failure = previewError(error)
    }
  }
}
