import Combine
import Foundation

/// Owns Home data independently of the connection/navigation notification channel.
@MainActor
final class HomeState {
  struct TerminalSnapshot: Equatable {
    let terminal: HomeTerminal?
    let project: TerminalProject?
    let metadataWriting: Bool
    let acknowledging: Bool
    let bell: Bool
    let canMove: Bool
  }

  final class TerminalRecord: ObservableObject {
    let id: String
    @Published private(set) var snapshot: TerminalSnapshot
    init(id: String, snapshot: TerminalSnapshot) { self.id = id; self.snapshot = snapshot }
    fileprivate func replace(_ next: TerminalSnapshot) {
      if snapshot != next { snapshot = next }
    }
  }

  final class Projects: ObservableObject {
    @Published private(set) var values: [TerminalProject] = []
    fileprivate func replace(_ next: [TerminalProject]) {
      if values != next { values = next }
    }
  }

  final class CompletionQueue: ObservableObject {
    @Published private(set) var ids: [String] = []
    fileprivate func replace(_ next: [String]) {
      if ids != next { ids = next }
    }
  }

  // This is an internal data notification, never forwarded to AppSession.
  let changes = PassthroughSubject<Void, Never>()
  let attentionRetention = AttentionRetentionStore()
  let projects = Projects()
  let completionQueue = CompletionQueue()
  private(set) var overview: HomeOverview?
  private(set) var attentionSnapshot: AttentionSnapshot?
  private var terminals: [String: HomeTerminal] = [:]
  private var projectsByID: [String: TerminalProject] = [:]
  private var records: [String: TerminalRecord] = [:]
  private var order: [String] = []
  private var orderSubscription: AnyCancellable?

  init() { bindOrder(attentionRetention) }

  var loading = false { didSet { if loading != oldValue { changes.send() } } }
  var metadataWrites = Set<String>() {
    didSet { flagsChanged(oldValue.symmetricDifference(metadataWrites)) }
  }
  var acknowledgementWrites = Set<String>() {
    didSet { flagsChanged(oldValue.symmetricDifference(acknowledgementWrites)) }
  }
  var bellMarkers = Set<String>() {
    didSet { flagsChanged(oldValue.symmetricDifference(bellMarkers)) }
  }

  func bindOrder(_ retention: AttentionRetentionStore) {
    orderSubscription = retention.$orderedIDs.sink { [weak self] ids in
      guard let self, self.order != ids else { return }
      self.order = ids
      self.refreshCompletionQueue()
    }
  }

  func terminal(_ id: String) -> HomeTerminal? { terminals[id] }
  func project(_ id: String) -> TerminalProject? { projectsByID[HomeOverview.parentProjectID(id)] }

  func resetScope() {
    overview = nil; attentionSnapshot = nil; terminals = [:]; projectsByID = [:]
    metadataWrites.removeAll(); acknowledgementWrites.removeAll(); bellMarkers.removeAll()
    for (id, record) in records { record.replace(snapshot(id)) }
    records.removeAll()
    order = []
    projects.replace([]); completionQueue.replace([])
    changes.send()
  }

  func record(_ id: String) -> TerminalRecord {
    if let record = records[id] { return record }
    let record = TerminalRecord(id: id, snapshot: snapshot(id))
    records[id] = record
    return record
  }

  func replace(_ next: HomeOverview?) {
    guard overview != next else { return }
    let previous = overview
    overview = next
    terminals = Dictionary(uniqueKeysWithValues: (next?.sessions ?? []).map { ($0.id, $0) })
    projectsByID = Dictionary(uniqueKeysWithValues: (next?.projects ?? []).map { ($0.id, $0) })
    attentionRetention.observe(from: previous, to: next)
    projects.replace(next?.projects ?? [])
    for (id, record) in records { record.replace(snapshot(id)) }
    // A removed view can retain its invalidated record until dismissal. A later
    // connection reusing the same ID must receive a new record object.
    records = records.filter { terminals[$0.key] != nil }
    refreshCompletionQueue()
    changes.send()
  }

  func replaceAttention(_ next: AttentionSnapshot?) {
    guard attentionSnapshot != next else { return }
    attentionSnapshot = next
    changes.send()
  }

  private func snapshot(_ id: String) -> TerminalSnapshot {
    TerminalSnapshot(terminal: terminals[id], project: terminals[id].flatMap { project($0.projectId) },
      metadataWriting: metadataWrites.contains(id), acknowledging: acknowledgementWrites.contains(id),
      bell: bellMarkers.contains(id), canMove: terminals[id].map { terminal in
        projects.values.contains { $0.id != terminal.projectId }
      } ?? false)
  }

  private func flagsChanged(_ ids: Set<String>) {
    guard !ids.isEmpty else { return }
    for id in ids { records[id]?.replace(snapshot(id)) }
    changes.send()
  }

  private func refreshCompletionQueue() {
    completionQueue.replace(order.filter {
      guard let terminal = terminals[$0] else { return false }
      return terminal.hasUnreadCompletion && !terminal.isAgentActive
    })
  }
}
