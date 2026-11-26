import Foundation
import Combine

/// One terminal's project summary, shared by its badge, Changes and Files views.
@MainActor
final class ProjectChangesModel: ObservableObject {
  @Published private(set) var changes: PreviewChanges?
  @Published private(set) var branchChanges: PreviewBranchChanges?
  @Published private(set) var branchCommits: PreviewBranchCommits?
  @Published private(set) var scope = "working"
  @Published private(set) var selectedCommitOid: String?
  @Published private(set) var loading = false
  @Published private(set) var branchLoading = false
  @Published private(set) var commitsLoading = false
  @Published private(set) var failure: String?
  @Published private(set) var branchFailure: String?
  @Published private(set) var commitsFailure: String?
  @Published private(set) var mutating = false
  @Published private(set) var mutationRevision = 0
  private weak var session: AppSession?
  private var projectID: String
  private let terminalID: String
  private let generation: Int
  private var loadID = UUID()
  private var loadTask: Task<Void, Never>?
  private var branchLoadID = UUID()
  private var branchLoadTask: Task<Void, Never>?
  private var commitsLoadID = UUID()
  private var commitsLoadTask: Task<Void, Never>?
  private var scopeByProject: [String: String] = [:]
  private var commitByProject: [String: String] = [:]

  init(session: AppSession, terminal: TerminalDetails) {
    self.session = session
    projectID = terminal.projectId
    terminalID = terminal.id
    generation = session.generation
  }

  var count: Int? { changes.map { $0.staged.count + $0.working.count } }

  func selectProject(_ id: String) {
    guard id != projectID else { return }
    scopeByProject[projectID] = scope
    if let selectedCommitOid { commitByProject[projectID] = selectedCommitOid }
    cancel()
    projectID = id
    scope = scopeByProject[id] ?? "working"
    selectedCommitOid = commitByProject[id]
    changes = nil
    branchChanges = nil
    branchCommits = nil
    failure = nil
    branchFailure = nil
    commitsFailure = nil
  }

  func selectScope(_ nextScope: String) {
    guard nextScope != scope else { return }
    scope = nextScope
    scopeByProject[projectID] = nextScope
    Task { await refreshActiveScope(force: false) }
  }

  func selectCommit(_ oid: String) {
    guard oid != selectedCommitOid else { return }
    selectedCommitOid = oid
    commitByProject[projectID] = oid
    Task { await refreshBranchCommits(force: true) }
  }

  private func isCurrent(_ session: AppSession) -> Bool {
    session.generation == generation && session.terminal?.id == terminalID
      && session.terminal?.projectId == projectID && session.authenticated
  }

  func mutate(_ mutation: PreviewMutation) async throws {
    guard !mutating, let session, isCurrent(session) else { throw CancellationError() }
    let projectID = self.projectID
    mutating = true
    defer { mutating = false }
    do {
      try await session.withConnection(reportFailure: false) {
        try await $0.mutatePreview(projectID: projectID, mutation: mutation)
      }
    } catch {
      // A failed response does not prove the disk was unchanged; do not retry writes.
      if isCurrent(session), self.projectID == projectID {
        cancel()
        await refresh(force: true)
      }
      throw error
    }
    guard isCurrent(session), self.projectID == projectID else { throw CancellationError() }
    cancel()
    mutationRevision += 1
    await refresh(force: true)
  }

  func refreshActiveScope(force: Bool = false) async {
    switch scope {
    case "branch":
      await refreshBranchChanges(force: force)
    case "commits":
      await refreshBranchCommits(force: force)
    default:
      await refresh(force: force)
    }
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
    if scope == "branch" {
      await refreshBranchChanges(force: force)
    } else if scope == "commits" {
      await refreshBranchCommits(force: force)
    }
  }

  func refreshBranchChanges(force: Bool = false) async {
    guard !Task.isCancelled, let session, isCurrent(session),
      session.foreground, session.health.status == .online else { return }
    if let branchLoadTask { await branchLoadTask.value; return }
    let request = UUID()
    branchLoadID = request
    branchLoading = true
    branchFailure = nil
    let task = Task { await loadBranchChanges(session: session, request: request, force: force) }
    branchLoadTask = task
    await task.value
  }

  func refreshBranchCommits(force: Bool = false) async {
    guard !Task.isCancelled, let session, isCurrent(session),
      session.foreground, session.health.status == .online else { return }
    commitsLoadTask?.cancel()
    let request = UUID()
    commitsLoadID = request
    commitsLoading = true
    commitsFailure = nil
    let task = Task { await loadBranchCommits(session: session, request: request, force: force) }
    commitsLoadTask = task
    await task.value
  }

  func cancel() {
    loadID = UUID()
    loadTask?.cancel()
    loadTask = nil
    loading = false
    branchLoadID = UUID()
    branchLoadTask?.cancel()
    branchLoadTask = nil
    branchLoading = false
    commitsLoadID = UUID()
    commitsLoadTask?.cancel()
    commitsLoadTask = nil
    commitsLoading = false
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

  private func loadBranchChanges(session: AppSession, request: UUID, force: Bool) async {
    defer { if branchLoadID == request { branchLoading = false; branchLoadTask = nil } }
    do {
      if branchChanges == nil, let api = session.api {
        let saved: PreviewBranchChanges? = await api.previewSnapshot(
          projectID: projectID, resource: "git-branch-changes")
        guard !Task.isCancelled, branchLoadID == request, isCurrent(session) else { return }
        branchChanges = saved
      }
      let value = try await session.withConnection(reportFailure: false) {
        try await $0.branchChanges(projectID: self.projectID, force: force)
      }
      guard !Task.isCancelled, branchLoadID == request, isCurrent(session) else { return }
      branchChanges = value
    } catch {
      guard !Task.isCancelled, branchLoadID == request, isCurrent(session) else { return }
      if case APIError.http(404) = error {
        branchFailure = "当前电脑服务端版本暂不支持，请升级 Backend"
      } else {
        branchFailure = previewError(error)
      }
    }
  }

  private func loadBranchCommits(session: AppSession, request: UUID, force: Bool) async {
    defer { if commitsLoadID == request { commitsLoading = false; commitsLoadTask = nil } }
    let targetCommit = selectedCommitOid
    do {
      let value: PreviewBranchCommits
      do {
        value = try await session.withConnection(reportFailure: false) {
          try await $0.branchCommits(projectID: self.projectID, commitOid: targetCommit, force: force)
        }
      } catch APIError.http(409) where targetCommit != nil {
        selectedCommitOid = nil
        commitByProject.removeValue(forKey: projectID)
        value = try await session.withConnection(reportFailure: false) {
          try await $0.branchCommits(projectID: self.projectID, commitOid: nil, force: true)
        }
      }
      guard !Task.isCancelled, commitsLoadID == request, isCurrent(session) else { return }
      branchCommits = value
      selectedCommitOid = value.selectedCommitOid
      if let oid = value.selectedCommitOid {
        commitByProject[projectID] = oid
      }
    } catch {
      guard !Task.isCancelled, commitsLoadID == request, isCurrent(session) else { return }
      if case APIError.http(404) = error {
        commitsFailure = "当前电脑服务端版本暂不支持，请升级 Backend"
      } else {
        commitsFailure = previewError(error)
      }
    }
  }
}
