import Foundation
import Combine

@MainActor
final class BranchUpdatesModel: ObservableObject {
  @Published private(set) var value: BranchUpdatesResponse?
  @Published private(set) var loading = false
  @Published private(set) var failure: String?
  private weak var session: AppSession?
  let terminalID: String
  let cwd: String
  let readingKey: String
  private let generation: Int
  private var task: Task<Void, Never>?
  private var request = UUID()
  private static var positions: [String: (oid: String, date: Date)] = [:]

  init(session: AppSession, terminalID: String, cwd: String) {
    self.session = session; self.terminalID = terminalID; self.cwd = cwd
    generation = session.generation
    readingKey = "\(session.connection?.scope ?? "unavailable")\u{0}\(terminalID)\u{0}\(cwd)"
  }
  private var current: Bool {
    guard let session, session.generation == generation, session.authenticated,
      let terminal = session.overview?.sessions.first(where: { $0.id == terminalID }) else { return false }
    return terminal.cwd == cwd && (session.terminal == nil || session.terminal?.id == terminalID)
  }
  var canRead: Bool { current && session?.foreground == true && session?.health.status == .online }
  var stale: Bool { value?.state == "stale" || (failure != nil && value?.snapshot != nil) }
  var items: [BranchUpdateCommit] { Array((value?.snapshot?.items ?? []).prefix(branchUpdatesLimit)) }
  var revision: String? { value?.snapshot.map { "\($0.headOid):\($0.baseOid)" } }
  var readingAnchor: String? { Self.positions[readingKey]?.oid }
  func remember(_ oid: String?) {
    guard let oid else { Self.positions.removeValue(forKey: readingKey); return }
    Self.positions[readingKey] = (oid, Date())
    if Self.positions.count > 100, let oldest = Self.positions.min(by: { $0.value.date < $1.value.date })?.key {
      Self.positions.removeValue(forKey: oldest)
    }
  }
  func refresh(force: Bool = false) {
    guard canRead, !loading, let session else { return }
    let id = UUID(); request = id; loading = true; failure = nil
    task = Task { [weak self] in
      guard let self else { return }
      defer { if request == id { loading = false; task = nil } }
      do {
        let response = try await session.withConnection(reportFailure: false) {
          try await $0.branchUpdates(terminalID: self.terminalID, refresh: force)
        }
        guard !Task.isCancelled, request == id, current else { return }
        guard response.target.kind == "terminal", response.target.terminalSessionId == terminalID,
          response.target.cwd == cwd else {
          value = nil; failure = "读取目标已变化，请重新打开"; return
        }
        value = response
      } catch {
        guard !Task.isCancelled, request == id, current else { return }
        switch error {
        case APIError.http(404): value = nil; failure = "当前后台暂时无法提供提交列表"
        case APIError.http(409): value = nil; failure = "读取目标已变化或不可用，请重新打开"
        default: failure = "主分支更新暂不可用，请稍后刷新"
        }
      }
    }
  }
  func cancel() { request = UUID(); task?.cancel(); task = nil; loading = false }
}
