import Foundation

@MainActor
final class ScheduledTasksModel: ObservableObject {
  @Published var query = ""
  @Published var project = ""
  @Published var archived = false
  @Published private(set) var capabilities: ScheduledCapabilities?
  @Published private(set) var items: [ScheduledTaskRecord] = []
  @Published private(set) var nextCursor: String?
  @Published private(set) var detail: ScheduledTaskRecord?
  @Published private(set) var runs: [ScheduledRun] = []
  @Published private(set) var runsCursor: String?
  @Published private(set) var loading = false
  @Published private(set) var writing = false
  @Published var failure: String?
  @Published var actionFailure: String?
  @Published var targetID: String?
  @Published var highlightedRun: String?
  private var listPages = 1
  private var runPages = 1
  private var filter = ""
  private var request = 0
  private var runKeys: [String: String] = [:]
  let session: AppSession
  let generation: Int
  init(session: AppSession) { self.session = session; generation = session.generation }
  var current: Bool { generation == session.generation && session.authenticated }
  var canWrite: Bool { current && session.canWrite && capabilities?.enabled == true && !writing }
  var filterID: String { "\(query)\u{0}\(project)\u{0}\(archived)" }

  func call<T>(_ operation: (ScheduledTasksService) async throws -> T) async throws -> T {
    guard current else { throw CancellationError() }
    return try await session.withConnection(reportFailure: false) { api in
      try await operation(ScheduledTasksService(api: api))
    }
  }
  func select(_ id: String?, run: String? = nil) {
    request += 1
    targetID = id; highlightedRun = run
    detail = nil; runs = []; runsCursor = nil; runPages = 1
    failure = nil; actionFailure = nil; loading = false
  }
  func refresh(more: Bool = false) async {
    guard current, session.foreground, session.health.status == .online else { return }
    request += 1
    let ticket = request, selected = targetID, selectedFilter = filterID
    if filter != selectedFilter {
      filter = selectedFilter; items = []; nextCursor = nil; listPages = 1
    }
    loading = true
    defer { if request == ticket { loading = false } }
    do {
      let caps = try await call { try await $0.capabilities() }
      guard current, request == ticket, !Task.isCancelled else { return }
      capabilities = caps
      if let selected {
        let task = try await call { try await $0.task(selected) }
        var page = try await call { try await $0.runs(selected, cursor: more ? runsCursor : nil) }
        var records = page.items
        if !more, runPages > 1 {
          for _ in 1..<runPages {
            guard let cursor = page.nextCursor else { break }
            page = try await call { try await $0.runs(selected, cursor: cursor) }
            records += page.items
          }
        }
        if let id = highlightedRun {
          let target = try await call { try await $0.run(id) }
          guard target.taskId == selected else { throw ScheduledFailure(code: "wrong_task", message: "此运行不属于当前任务。") }
          records.removeAll { $0.id == id }; records.insert(target, at: 0)
        }
        guard current, request == ticket, targetID == selected, !Task.isCancelled else { return }
        detail = task
        runs = unique((more ? runs : []) + records)
        runsCursor = page.nextCursor
        if more { runPages += 1 }
      } else {
        var page = try await call { try await $0.list(q: query, project: project, archived: archived, cursor: more ? nextCursor : nil) }
        var records = page.items
        if !more, listPages > 1 {
          for _ in 1..<listPages {
            guard let cursor = page.nextCursor else { break }
            page = try await call { try await $0.list(q: query, project: project, archived: archived, cursor: cursor) }
            records += page.items
          }
        }
        guard current, request == ticket, filterID == selectedFilter, !Task.isCancelled else { return }
        items = unique((more ? items : []) + records); nextCursor = page.nextCursor
        if more { listPages += 1 }
      }
      failure = nil
    } catch {
      guard current, request == ticket, !Task.isCancelled, !(error is CancellationError) else { return }
      if case APIError.http(404) = error, capabilities == nil { failure = "此电脑的 Backend 尚不支持定时任务，请更新后重试。" }
      else { failure = displayError(error) }
    }
  }
  private func unique<T: Identifiable>(_ values: [T]) -> [T] where T.ID == String {
    var seen = Set<String>(); return values.filter { seen.insert($0.id).inserted }
  }
  func action(_ action: String, task: ScheduledTaskRecord) async {
    guard canWrite else { return }
    writing = true; actionFailure = nil
    let selected = targetID
    defer { writing = false }
    do {
      if action == "run" {
        let key = runKeys[task.id] ?? UUID().uuidString
        runKeys[task.id] = key
        let run = try await call { try await $0.start(task.id, key: key) }
        runKeys[task.id] = nil
        guard current, session.foreground, session.showingScheduledTasks, targetID == selected else { return }
        select(task.id, run: run.id)
      } else if action == "delete" {
        let _ = try await call { try await $0.remove(task) }
      } else {
        let _ = try await call { try await $0.save(["expectedRevision": task.revision, "enabled": !task.enabled], id: task.id, key: "") }
      }
      await refresh()
    } catch {
      if current, !(error is CancellationError) { actionFailure = displayError(error) }
    }
  }
}
