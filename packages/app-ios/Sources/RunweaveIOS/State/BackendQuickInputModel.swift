import Foundation
import SwiftUI

@MainActor
final class BackendQuickInputModel: ObservableObject {
  @Published private(set) var items: [BackendQuickInput] = []
  @Published private(set) var searchItems: [BackendQuickInput] = []
  @Published private(set) var searchQuery = ""
  @Published private(set) var runs: [String: ScheduledRun] = [:]
  @Published private(set) var loading = false
  @Published private(set) var saving = false
  @Published private(set) var starting = Set<String>()
  @Published var failure: String?
  @Published var runFailure: String?
  private var orderVersion: String?
  private var scope: String?
  private var generation = -1
  private var loaded = false
  private var request = 0
  private var runKeys: [String: String] = [:]
  private var runProjectId: String?
  private var runRequest = 0

  func reset() {
    request += 1
    items = []; searchItems = []; searchQuery = ""; runs = [:]
    orderVersion = nil; scope = nil; generation = -1; loaded = false
    loading = false; saving = false; starting = []; failure = nil; runFailure = nil; runKeys = [:]
    runProjectId = nil; runRequest += 1
  }

  func canEdit(_ session: AppSession) -> Bool {
    current(session) && session.canWrite && loaded && !saving && !loading && failure == nil
  }

  func loadIfNeeded(_ session: AppSession) async {
    if !current(session) || !loaded { await refresh(session) }
  }

  func refresh(_ session: AppSession, query: String = "") async {
    guard let connection = session.connection else { reset(); failure = "请先选择电脑。"; return }
    if scope != connection.scope || generation != session.generation { reset() }
    scope = connection.scope; generation = session.generation
    guard session.authenticated else { failure = "请先登录当前电脑。"; return }
    guard session.foreground, session.health.status == .online else {
      failure = "电脑暂时不可用，请连接后重试。"; return
    }
    request += 1
    let ticket = request, expectedScope = connection.scope, expectedGeneration = session.generation
    loading = true; failure = nil
    defer { if request == ticket { loading = false } }
    do {
      var result: [BackendQuickInput] = []
      var version: String?
      var retries = 0
      while true {
        do {
          result = []
          version = nil
          var cursor: String?
          repeat {
            let next = cursor
            let page = try await session.withConnection(reportFailure: false) {
              try await QuickInputService(api: $0).list(query: query, cursor: next)
            }
            guard current(session, scope: expectedScope, generation: expectedGeneration), request == ticket else { return }
            if let version, version != page.orderVersion {
              throw BackendQuickInputFailure(code: "list_changed", message: "列表已变化")
            }
            version = page.orderVersion
            result += page.items
            cursor = page.nextCursor
          } while cursor != nil && !Task.isCancelled
          break
        } catch let error as BackendQuickInputFailure where error.code == "list_changed" && retries < 2 {
          retries += 1
        }
      }
      guard !Task.isCancelled else { return }
      let unique = result.reduce(into: [BackendQuickInput]()) { values, item in
        if !values.contains(where: { $0.id == item.id }) { values.append(item) }
      }
      if query.isEmpty {
        items = unique; orderVersion = version; loaded = true
      } else {
        searchItems = unique; searchQuery = query
      }
      failure = nil
    } catch {
      guard current(session, scope: expectedScope, generation: expectedGeneration), request == ticket,
        !(error is CancellationError) else { return }
      if case APIError.http(400) = error { failure = "此电脑尚不支持全局快捷回复，请先更新电脑端。" }
      else if case APIError.http(404) = error { failure = "此电脑尚不支持全局快捷回复，请先更新电脑端。" }
      else { failure = displayError(error) }
      if query.isEmpty { items = []; orderVersion = nil; loaded = false }
      else { searchItems = []; searchQuery = query }
    }
  }

  func visible(query: String) -> [BackendQuickInput] {
    query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? items
      : (query == searchQuery ? searchItems : [])
  }

  func save(_ session: AppSession, item: BackendQuickInput?, title: String, body: String) async throws {
    guard canEdit(session) else { throw APIError.offline }
    let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard cleanTitle.count <= 80, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      body.utf8.count <= 64 * 1024 else {
      throw BackendQuickInputFailure(code: "invalid_input", message: "标题最多 80 字，正文不能为空且最多 64 KiB。")
    }
    let resolvedTitle = cleanTitle.isEmpty
      ? String((body.components(separatedBy: .newlines).first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? body).prefix(40))
      : cleanTitle
    let expected = generation
    saving = true
    defer { if generation == expected { saving = false } }
    let result = try await session.withConnection(reportFailure: false) { api in
      let service = QuickInputService(api: api)
      if let item { return try await service.update(item, title: resolvedTitle, data: body) }
      return try await service.create(title: resolvedTitle, data: body)
    }
    guard current(session), generation == expected else { throw CancellationError() }
    if item == nil { items.append(result) }
    else if let index = items.firstIndex(where: { $0.id == result.id }) { items[index] = result }
    await refresh(session)
  }

  func delete(_ session: AppSession, id: String) async throws {
    guard canEdit(session), items.contains(where: { $0.id == id }) else { throw APIError.offline }
    let expected = generation
    saving = true
    defer { if generation == expected { saving = false } }
    try await session.withConnection(reportFailure: false) { try await QuickInputService(api: $0).delete(id) }
    guard current(session), generation == expected else { throw CancellationError() }
    items.removeAll { $0.id == id }; searchItems.removeAll { $0.id == id }
    await refresh(session)
  }

  func move(_ session: AppSession, from offsets: IndexSet, to destination: Int) async throws {
    guard canEdit(session), let orderVersion, let source = offsets.first,
      items.indices.contains(source) else { throw APIError.offline }
    var reordered = items
    let id = items[source].id
    reordered.move(fromOffsets: offsets, toOffset: destination)
    guard let index = reordered.firstIndex(where: { $0.id == id }) else { return }
    let beforeId = index + 1 < reordered.count ? reordered[index + 1].id : nil
    let expected = generation
    saving = true
    defer { if generation == expected { saving = false } }
    let response = try await session.withConnection(reportFailure: false) {
      try await QuickInputService(api: $0).move(id, beforeId: beforeId, orderVersion: orderVersion)
    }
    guard current(session), generation == expected else { throw CancellationError() }
    items = reordered; self.orderVersion = response.orderVersion
    await refresh(session)
  }

  func markUsed(_ session: AppSession, id: String) async {
    guard current(session) else { return }
    if let result = try? await session.withConnection(reportFailure: false, {
      try await QuickInputService(api: $0).markUsed(id)
    }), current(session) {
      if let index = items.firstIndex(where: { $0.id == id }) { items[index] = result }
    }
  }

  func refreshRuns(_ session: AppSession, projectId: String) async {
    guard current(session), session.authenticated, session.health.status == .online else { return }
    runRequest += 1
    let ticket = runRequest
    if runProjectId != projectId { runs = [:] }
    runProjectId = projectId
    let expectedScope = scope, expectedGeneration = generation
    do {
      var cursor: String?
      var latest: [String: ScheduledRun] = [:]
      repeat {
        let next = cursor
        let page = try await session.withConnection(reportFailure: false) {
          try await QuickInputService(api: $0).runs(projectId: projectId, cursor: next)
        }
        guard current(session), scope == expectedScope, generation == expectedGeneration,
          runRequest == ticket else { return }
        for run in page.items where run.executionProjectId == projectId {
          if let id = run.snapshot.origin?.quickInputId, latest[id] == nil { latest[id] = run }
        }
        cursor = page.nextCursor
      } while cursor != nil && !Task.isCancelled
      if current(session), scope == expectedScope, generation == expectedGeneration,
        runRequest == ticket { runs = latest; runFailure = nil }
    } catch { if current(session) && !(error is CancellationError) { runFailure = displayError(error) } }
  }

  func start(_ session: AppSession, item: BackendQuickInput, projectId: String) async throws -> ScheduledRun {
    guard canEdit(session), item.canRunInBackground, !projectId.isEmpty,
      !starting.contains(item.id) else { throw APIError.offline }
    starting.insert(item.id)
    defer { starting.remove(item.id) }
    await refresh(session)
    guard canEdit(session), let currentItem = items.first(where: { $0.id == item.id }),
      currentItem.canRunInBackground else { throw APIError.invalidResponse }
    guard currentItem.data == item.data, currentItem.mode == item.mode else {
      throw BackendQuickInputFailure(code: "input_changed", message: "Quick input changed")
    }
    let keyID = item.id + "\u{0}" + projectId
    let key = runKeys[keyID] ?? UUID().uuidString
    runKeys[keyID] = key
    let expected = generation
    let run = try await session.withConnection(reportFailure: false) {
      try await QuickInputService(api: $0).start(currentItem, projectId: projectId, key: key)
    }
    guard current(session), generation == expected else { throw CancellationError() }
    runKeys[keyID] = nil
    if runProjectId == projectId { runs[item.id] = run }
    return run
  }

  func run(for id: String, projectId: String?) -> ScheduledRun? {
    guard runProjectId == projectId else { return nil }
    return runs[id]
  }

  private func current(_ session: AppSession) -> Bool {
    guard let scope else { return false }
    return current(session, scope: scope, generation: generation)
  }

  private func current(_ session: AppSession, scope: String, generation: Int) -> Bool {
    session.connection?.scope == scope && session.generation == generation && session.authenticated
  }
}
