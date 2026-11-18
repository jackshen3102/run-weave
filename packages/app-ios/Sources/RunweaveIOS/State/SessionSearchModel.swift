import Foundation

@MainActor
final class SessionSearchModel: ObservableObject {
  @Published var query = ""
  @Published var projectID = ""
  @Published var provider = ""
  @Published var level = "chat"
  @Published var others = false
  @Published private(set) var page: SessionSearchPage?
  @Published private(set) var hits: [SessionSearchHit] = []
  @Published private(set) var status: SessionSearchStatus?
  @Published private(set) var failure: String?
  @Published private(set) var loading = false
  private var request = UUID()
  var filter: String { "\(query):\(projectID):\(provider):\(level):\(others)" }
  func clear() { request = UUID(); page = nil; hits = []; failure = nil; loading = false }
  func suspend() { request = UUID(); loading = false }
  func reset() { clear(); status = nil; projectID = "" }
  func search(session: AppSession, more: Bool = false) async {
    guard let api = session.api, session.authenticated, session.foreground, !projectID.isEmpty,
      !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    let epoch = session.generation, selected = filter, current = UUID()
    let cursor = more ? page?.nextCursor : nil
    if more && cursor == nil { return }
    if !more { clear() }
    request = current; loading = true; failure = nil
    defer { if request == current { loading = false } }
    do {
      let value = try await SessionSearchService(api: api).search(query: query, projectID: projectID, provider: provider, level: level, others: others, cursor: cursor)
      guard session.generation == epoch, selected == filter, request == current, session.foreground, !Task.isCancelled else { return }
      page = value; status = value.coverage
      hits = (more ? hits : []) + value.hits
    } catch {
      guard session.generation == epoch, selected == filter, request == current, !Task.isCancelled else { return }
      failure = "搜索失败，请检查连接或更新索引后重试。"
      if case APIError.http(409) = error { failure = "索引已更新，请重新搜索。" }
      if case APIError.http(404) = error { failure = "当前电脑的 Backend 尚不支持会话搜索。" }
      await session.handle(error, epoch: epoch, reportFailure: false)
    }
  }
  func poll(session: AppSession) async {
    guard let api = session.api, session.authenticated else { return }
    let epoch = session.generation
    do {
      let value = try await SessionSearchService(api: api).status()
      guard session.generation == epoch, session.foreground, !Task.isCancelled else { return }
      status = value
    } catch {
      guard session.generation == epoch, !Task.isCancelled else { return }
      failure = "索引状态不可用，请检查连接与 Backend 版本。"
      await session.handle(error, epoch: epoch, reportFailure: false)
    }
  }
  func refresh(session: AppSession) async {
    guard let api = session.api, session.authenticated else { return }
    clear(); let epoch = session.generation, current = request
    do {
      try await SessionSearchService(api: api).refresh()
      guard session.generation == epoch, current == request, !Task.isCancelled else { return }
      await poll(session: session)
    } catch {
      guard session.generation == epoch, current == request, !Task.isCancelled else { return }
      failure = "更新索引请求失败，请重试。"
      await session.handle(error, epoch: epoch, reportFailure: false)
    }
  }
}
