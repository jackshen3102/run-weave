import Foundation

@MainActor
final class KnowledgeInboxModel: ObservableObject {
  @Published private(set) var preview: InboxPage?
  @Published private(set) var items: [InboxItem] = []
  @Published private(set) var repositories: [InboxRepository] = []
  @Published private(set) var nextCursor: String?
  @Published private(set) var detail: InboxItem?
  @Published private(set) var failure: String?
  @Published private(set) var detailFailure: String?
  @Published private(set) var actionFailure: String?
  @Published private(set) var partial = false
  @Published private(set) var loading = false
  @Published private(set) var writing = false
  @Published private(set) var unsupported = false
  @Published private(set) var offline = false
  @Published var state = "pending"
  @Published var source = "evolution"
  @Published var repositoryID = ""
  private var service: KnowledgeInboxService?
  private var epoch = UUID()
  private var previewRequest = 0
  private var listRequest = 0
  private var detailRequest = 0
  private var loadedPages = 1
  private var activeFilter = ""
  private var detailID: String?
  private var detailVersion: String?
  private var writeTask: Task<InboxItem, Error>?

  func reset(api: APIClient? = nil) {
    epoch = UUID()
    writeTask?.cancel()
    writeTask = nil
    service = api.map { KnowledgeInboxService(api: $0) }
    preview = nil; items = []; repositories = []; nextCursor = nil; detail = nil
    failure = nil; detailFailure = nil; actionFailure = nil; unsupported = false; offline = false
    partial = false; writing = false; loading = false
    loadedPages = 1; activeFilter = ""
    state = "pending"; source = "evolution"; repositoryID = ""; detailID = nil; detailVersion = nil
  }
  func suspend() { writeTask?.cancel() }
  var canWrite: Bool { service != nil && !writing && !offline && !unsupported && failure == nil && detailFailure == nil }

  func refreshPreview() async {
    guard let service, !unsupported else { return }
    let current = epoch
    previewRequest += 1
    let request = previewRequest
    do {
      let page = try await service.list(limit: 4)
      guard epoch == current, request == previewRequest, !Task.isCancelled else { return }
      preview = page; repositories = page.repositories; failure = nil; offline = false
    } catch { if epoch == current, request == previewRequest { receive(error) } }
  }
  func refreshList(more: Bool = false) async {
    guard let service, !unsupported else { return }
    let current = epoch
    let selectedState = state, selectedSource = source, selectedRepository = repositoryID
    let filter = "\(selectedState):\(selectedSource):\(selectedRepository)"
    if activeFilter != filter { items = []; nextCursor = nil; loadedPages = 1; activeFilter = filter }
    let cursor = more ? nextCursor : nil
    if more && cursor == nil { return }
    listRequest += 1
    let request = listRequest
    loading = true
    defer { if epoch == current, request == listRequest { loading = false } }
    do {
      var page = try await service.list(state: selectedState, source: selectedSource, repositoryID: selectedRepository, cursor: cursor)
      var freshItems = page.items
      if !more && loadedPages > 1 {
        for _ in 1..<loadedPages {
          guard let next = page.nextCursor, epoch == current, request == listRequest,
            filter == "\(state):\(source):\(repositoryID)", !Task.isCancelled else { break }
          page = try await service.list(state: selectedState, source: selectedSource, repositoryID: selectedRepository, cursor: next)
          freshItems += page.items
        }
      }
      guard epoch == current, request == listRequest, filter == "\(state):\(source):\(repositoryID)", !Task.isCancelled else { return }
      var seen = Set<String>()
      items = ((more ? items : []) + freshItems).filter { seen.insert($0.id).inserted }
      if more { loadedPages += 1 }
      nextCursor = page.nextCursor; repositories = page.repositories
      partial = page.sourceStatus.status == "partial"; failure = nil; offline = false
    } catch { if epoch == current, request == listRequest, filter == "\(state):\(source):\(repositoryID)" { receive(error) } }
  }
  func select(_ item: InboxItem) {
    detailRequest += 1
    detailID = item.id; detailVersion = item.processedAt == nil ? nil : item.contentVersion
    detail = item; detailFailure = nil; actionFailure = nil
  }
  func refreshDetail() async {
    guard let service, let id = detailID, !unsupported else { return }
    let current = epoch
    detailRequest += 1
    let request = detailRequest
    do {
      let value = try await service.detail(id, version: detailVersion)
      guard epoch == current, request == detailRequest, !Task.isCancelled else { return }
      detail = value; detailFailure = nil; offline = false
    } catch { if epoch == current, request == detailRequest { receive(error, detailRead: true) } }
  }
  func change() async {
    guard canWrite, let service, let item = detail, item.availability == "available" else { return }
    if item.currentContentVersion != nil {
      detailVersion = nil
      await refreshDetail()
      return
    }
    let current = epoch
    writing = true; actionFailure = nil
    let task = Task { try await service.change(item) }
    writeTask = task
    defer { if epoch == current { writing = false; writeTask = nil } }
    do {
      let updated = try await task.value
      guard epoch == current, !Task.isCancelled else { return }
      detail = updated; detailVersion = updated.processedAt == nil ? nil : updated.contentVersion
      await refreshPreview()
      await refreshList()
    } catch {
      guard epoch == current, !(error is CancellationError), !Task.isCancelled else { return }
      actionFailure = (error as? APIError) == nil ? "保存失败，请重试" : displayError(error)
      if case APIError.http(409) = error { actionFailure = "正文或处理状态已变化，请阅读最新内容后重试" }
      await refreshDetail()
    }
  }
  func poll(_ area: String) async {
    while !Task.isCancelled && !unsupported {
      if area == "preview" { await refreshPreview() }
      else if area == "list" { await refreshList() }
      else { await refreshDetail() }
      do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
    }
  }
  private func receive(_ error: Error, detailRead: Bool = false) {
    guard !(error is CancellationError), !Task.isCancelled else { return }
    if detailRead {
      if error is URLError {
        offline = true
        detailFailure = "离线，显示本连接最近缓存；恢复连接后自动刷新"
      } else { detailFailure = "详情暂不可用，请刷新后重试" }
      return
    }
    if case APIError.http(404) = error {
      failure = detailRead ? "此成果已不可用，请返回列表刷新" : "当前服务版本不支持"
      if !detailRead { unsupported = true }
    } else if error is URLError {
      offline = true; failure = "离线，显示本连接最近缓存；恢复连接后自动刷新"
    } else { failure = "成果暂不可用，请下拉重试" }
  }
}
