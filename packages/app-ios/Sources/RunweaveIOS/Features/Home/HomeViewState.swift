import Combine
import Foundation

/// List membership and aggregate facts are distinct from each row's changing text.
@MainActor
final class HomeViewState: ObservableObject {
  private struct Member: Equatable {
    let id: String
    let projectID: String
    let cwd: String
    let conversationKey: String?
    let state: TerminalState
    let status: String
    let displayStatus: String
    let unread: Bool
    let pinnedAt: String?
  }
  private struct Group: Equatable {
    let project: TerminalProject
    let ids: [String]
    let total: Int
  }
  private struct Snapshot: Equatable {
    let groups: [Group]
    let members: [Member]
    let order: [String]
    let retainedIDs: [String]
    let bells: [String]
    let hasOverview: Bool
    let loading: Bool
  }

  @Published private(set) var revision = 0
  private weak var session: AppSession?
  private var query = ""
  private var active = true
  private var pending = false
  private var snapshot: Snapshot
  private var subscription: AnyCancellable?

  init(session: AppSession) {
    self.session = session
    snapshot = Self.read(session, query: "")
    subscription = Publishers.Merge(session.home.changes,
      session.attentionRetention.objectWillChange).sink { [weak self] in self?.invalidate() }
  }

  func setQuery(_ next: String) {
    guard query != next else { return }
    query = next; refresh()
  }
  func setActive(_ next: Bool) {
    guard active != next else { return }
    active = next
    if next { refresh() }
  }
  private func invalidate() {
    guard active, !pending else { return }
    pending = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.pending = false; self.refresh()
    }
  }
  private func refresh() {
    guard active, let session else { return }
    let next = Self.read(session, query: query)
    if snapshot != next { snapshot = next; revision += 1 }
  }
  private static func read(_ session: AppSession, query: String) -> Snapshot {
    let overview = session.overview
    return Snapshot(
      groups: (overview?.groups(matching: query) ?? []).map {
        Group(project: $0.project, ids: $0.sessions.map(\.id), total: $0.terminalCount)
      },
      members: (overview?.sessions ?? []).map {
        Member(id: $0.id, projectID: $0.projectId, cwd: $0.cwd, conversationKey: $0.conversationKey,
          state: $0.terminalState, status: $0.status, displayStatus: $0.displayStatus,
          unread: $0.hasUnreadCompletion, pinnedAt: $0.pinnedAt)
      },
      order: session.attentionRetention.orderedIDs,
      retainedIDs: session.attentionRetention.retainedUntil.keys.sorted(),
      bells: session.bellMarkers.sorted(), hasOverview: overview != nil, loading: session.loading)
  }
}
