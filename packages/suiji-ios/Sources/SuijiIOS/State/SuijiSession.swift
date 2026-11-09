import SuijiCaptureCore
import IOSDiagnostics
import SwiftUI
import RunweaveBrowser
enum RecordAction { case status(TaskStatus), trash(Bool), tags([String]) }
@MainActor final class SuijiSession: ObservableObject {
  @Published var captureConnection: CaptureConnection?
  @Published var pendingCaptures: [QueuedCapture] = []
  @Published var captureBusy = false
  @Published var captureMessage = ""
  @Published var materialFrom = ""
  @Published var materialTo = ""
  @Published var endpoint: String
  @Published var username: String
  @Published private(set) var environment: ConnectionEnvironment
  @Published private(set) var connecting = false
  @Published var info: ServiceInfo?
  @Published var returnHomeRequest = UUID()
  @Published var lastChangedRecord: SuijiRecord?
  @Published var records: [SuijiRecord] = []
  @Published var availableTags: [String] = []
  @Published var selectedTag = ""
  @Published var message = ""
  @Published var loading = false
  @Published var editor: EditorModel?
  @Published var nextCursor: String?
  @Published private(set) var loadMoreError: String?
  @Published var pendingStatuses: Set<String> = []
  @Published var statusBusy: Set<String> = []
  private(set) var client: APIClient?
  private var store: DraftStore?
  private var editingModels: [String: EditorModel] = [:]
  private var generation = UUID()
  let browser = BrowserSession(configuration: BrowserPresentationConfiguration(
    applicationName: "随记", returnLabel: "回随记",
    clearDataMessage: "清除此 App 全部内置网站的登录与存储数据？网页将关闭，不影响随记账户或草稿。网站登录独立于随记账户。"))
  var browserSource: BrowserContext? {
    guard let info, let client else { return nil }
    return BrowserContext(
      scope: [environment.rawValue, client.endpoint.absoluteString, info.serverId, info.ownerId],
      generation: generation.uuidString)
  }
  private var listGeneration = UUID()
  private struct ListScope: Equatable {
    let category: String?
    let materialFrom: String
    let materialTo: String
    let kind: String?
    let status: String?
    let query: String
    let tag: String
    let trash: Bool
    let hideClosedTasks: Bool
  }
  private var listScope: ListScope?
  private var profiles: ConnectionProfiles
  init(endpoint: URL?) {
    let saved = ConnectionProfiles.restore(endpoint: endpoint)
    profiles = saved; environment = saved.active
    self.endpoint = saved[saved.active].endpoint; username = saved[saved.active].username
    MobileAnalytics.observeBrowser(browser)
    browser.currentSource = { [weak self] in self?.browserSource }
  }
  private func rememberConnection() {
    profiles[environment] = ConnectionProfile(endpoint: endpoint, username: username)
    profiles.active = environment; profiles.save()
  }
  private func resetConnection(preserveShared: Bool = false) async -> (client: APIClient?, generation: UUID) {
    browser.invalidate()
    captureConnection = nil; pendingCaptures = []; materialFrom = ""; materialTo = ""
    let previous = client; generation = UUID(); let resetGeneration = generation; listGeneration = UUID()
    editingModels.values.forEach { $0.cancel() }; editingModels = [:]; editor = nil; lastChangedRecord = nil
    records = []; info = nil; store = nil; client = nil; pendingStatuses = []; statusBusy = []
    availableTags = []; selectedTag = ""
    loading = false; nextCursor = nil; loadMoreError = nil; listScope = nil; message = ""; connecting = false
    await previous?.cancel()
    if !preserveShared {
      do { try await SharedCaptureStore.setConnection(nil, ifCurrent: { self.generation == resetGeneration }) } catch { captureMessage = error.localizedDescription }
    }
    return (previous, resetGeneration)
  }
  func switchEnvironment(_ target: ConnectionEnvironment) async {
    guard target != environment else { return }
    rememberConnection(); environment = target
    endpoint = profiles[target].endpoint; username = profiles[target].username
    await connect()
  }
  func editConnection() async {
    rememberConnection()
    _ = await resetConnection()
  }
  func connect(username: String? = nil, password: String? = nil) async {
    let action = ClientDiagnosticOperation(.connectionRecover)
    var complete = false
    defer { if !complete { action.stage(.cancelled) } }
    if let username { self.username = username }
    rememberConnection()
    let address = endpoint, target = environment
    let savedCapture = try? SharedCaptureStore.connection()
    let preserveShared = username == nil && savedCapture?.identity.environment == target
      && savedCapture?.identity.endpoint == (try? APIClient.normalize(address).absoluteString)
    let reset = await resetConnection(preserveShared: preserveShared); let current = reset.generation
    guard generation == current else { return }; connecting = true
    defer { if generation == current { connecting = false } }
    guard generation == current, !address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    do {
      let url = try APIClient.normalize(address); let api = try APIClient(endpoint: url, environment: target); client = api
      endpoint = url.absoluteString; rememberConnection()
      action.stage(.requestStarted)
      let identity: ServiceInfo
      if let username, let password { identity = try await api.login(username: username, password: password) } else { identity = try await api.info() }
      action.stage(.responseReceived)
      guard generation == current else { await api.cancel(); return }
      let drafts = try DraftStore(endpoint: url, info: identity, environment: target)
      store = drafts; info = identity; message = ""
      do {
        let connection = CaptureConnection(identity: CaptureIdentity(environment: target, endpoint: url.absoluteString,
          serverId: identity.serverId, ownerId: identity.ownerId), materials: identity.features?.materials == true || identity.features?.browse == true, browse: identity.features?.browse == true)
        try await SharedCaptureStore.setConnection(connection, ifCurrent: { self.generation == current })
        guard generation == current else { return }
        captureConnection = connection; refreshCaptures()
      } catch { captureMessage = error.localizedDescription }
      action.stage(.confirmed); action.stage(.stateUpdated); complete = true
    } catch {
      action.stage(.failed, error: error); complete = true
      if generation == current { message = error.localizedDescription }
    }
  }
  func isCurrent(_ api: APIClient) -> Bool { client === api && info != nil }
  func logout() async {
    rememberConnection()
    let reset = await resetConnection(); let current = reset.generation
    let old = reset.client
    do { try await old?.logout() } catch { if generation == current { message = error.localizedDescription } }
  }
  func load(kind: String?, status: String?, q: String, tag: String = "", more: Bool = false, trash: Bool = false, hideClosedTasks: Bool = false, category: String? = nil) async {
    guard let client, info != nil else { return }
    let scope = ListScope(category: category, materialFrom: materialFrom, materialTo: materialTo, kind: kind, status: status, query: q, tag: tag, trash: trash, hideClosedTasks: hideClosedTasks)
    if more && (loading || nextCursor == nil || listScope != scope) { return }
    let current = generation, request = UUID(); listGeneration = request
    loading = true; loadMoreError = nil
    if !more { records = []; nextCursor = nil; listScope = scope }
    defer { if listGeneration == request { loading = false } }
    var query = URLComponents(); var items: [URLQueryItem] = []
    if let category { items.append(URLQueryItem(name: "category", value: category)) }
    if category == "material" {
      if !materialFrom.isEmpty { items.append(URLQueryItem(name: "materialFrom", value: materialFrom)) }
      if !materialTo.isEmpty { items.append(URLQueryItem(name: "materialTo", value: materialTo)) }
      refreshCaptures()
    }
    if trash { items.append(URLQueryItem(name: "trash", value: "true")) }
    if let kind { items.append(URLQueryItem(name: "kind", value: kind)) }
    if let status { items.append(URLQueryItem(name: "taskStatus", value: status)) }
    if !q.isEmpty { items.append(URLQueryItem(name: "q", value: q)) }
    if !tag.isEmpty { items.append(URLQueryItem(name: "tag", value: tag)) }
    do {
      if !more {
        Task { @MainActor [weak self] in
          guard let self else { return }
          do {
            let directory = try await client.request(TagDirectory.self, path: "api/suiji/v1/tags")
            guard generation == current, listGeneration == request else { return }
            availableTags = directory.items
          } catch { /* Tags do not block the record list. */ }
        }
      }
      var cursor = more ? nextCursor : nil
      var incoming: [SuijiRecord] = [], pending: Set<String> = []
      repeat {
        query.queryItems = items + (cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [])
        let page = try await client.request(RecordPage.self, path: "api/suiji/v1/records?" + (query.percentEncodedQuery ?? ""))
        guard generation == current, listGeneration == request else { return }
        if let store {
          for record in page.items { if try await store.status(record.id) != nil { pending.insert(record.id) } }
        }
        guard generation == current, listGeneration == request else { return }
        // Filter server reads only: a status change stays visible until the next reload.
        incoming = page.items.filter { !hideClosedTasks || ($0.taskStatus != .done && $0.taskStatus != .archived) || pending.contains($0.id) }
        cursor = page.nextCursor
      } while incoming.isEmpty && cursor != nil
      records = more ? records + incoming.filter { new in !records.contains { $0.id == new.id } } : incoming
      nextCursor = cursor; pendingStatuses = more ? pendingStatuses.union(pending) : pending; message = ""
    } catch {
      if generation == current, listGeneration == request {
        if more { loadMoreError = error.localizedDescription }
        else { message = error.localizedDescription }
        if let apiError = error as? APIError, apiError.error.code == "UNAUTHENTICATED" {
          _ = await resetConnection(); message = error.localizedDescription; await client.cancel()
        }
      }
    }
  }
  func openEditor(record: SuijiRecord? = nil, kind: RecordKind = .task, body: String = "", material: Bool = false) async {
    guard let client, let store, let info else { return }; let current = generation
    guard record?.deletedAt == nil else { return }
    do {
      if let record, try await store.status(record.id) != nil { message = "此记录有操作待确认，请先手动重试确认"; return }
      if let cached = editingModels[record?.id ?? "new"], cached.canReopen {
        await cached.prepareForCapture(kind: kind, body: body)
        guard generation == current else { return }
        editor = cached; return
      }
      let restored = try await store.load(record?.id ?? "new")
      guard generation == current else { return }
      var draft = restored ?? Draft(kind: record?.kind ?? kind, body: record?.body ?? body, tags: record?.tags ?? [], recordID: record?.id, expectedVersion: record?.version, existing: record?.attachments ?? [])
      if restored == nil {
        draft.material = record?.material?.input ?? (material ? MaterialInput() : nil)
        if draft.material != nil { draft.kind = .note }
      }
      let model = EditorModel(draft: draft, client: client, store: store, limits: info.limits, correctionCapability: info.features?.correction, historyCapability: info.features?.correctionHistory); model.materialsSupported = info.features?.materials == true; model.browseSupported = info.features?.browse == true; editingModels[draft.id] = model; editor = model
      await model.persist()
      if restored != nil { await model.prepareForCapture(kind: kind, body: body) }
    } catch { if generation == current { message = error.localizedDescription } }
  }
  func refreshCaptures() {
    guard let captureConnection else { return }
    do { pendingCaptures = try CaptureQueue.list(captureConnection.identity) }
    catch { captureMessage = error.localizedDescription }
  }
  func retryCapture(_ item: QueuedCapture) async {
    guard !captureBusy, let captureConnection, let client else { return }
    captureBusy = true; captureMessage = ""; defer { captureBusy = false; refreshCaptures() }
    do { try await CaptureQueue.send(item, connection: captureConnection, api: client.transport); captureMessage = "已保存，请刷新浏览列表" }
    catch { captureMessage = "待发送或保存结果待确认：" + error.localizedDescription }
  }
  func acceptFollowupRecord(_ record: SuijiRecord) {
    records = records.map { $0.id == record.id ? mergeSuijiRecord($0, record) : $0 }
    lastChangedRecord = lastChangedRecord.flatMap { $0.id == record.id ? mergeSuijiRecord($0, record) : nil } ?? record
  }
  func openFollowup(_ record: SuijiRecord) async {
    guard let client, let store, let info, info.features?.followups == true, record.deletedAt == nil else { return }
    let current = generation, key = "followup:" + record.id
    if let cached = editingModels[key], cached.canReopen { editor = cached; return }
    do {
      let restored = try await store.load(record.id, followup: true)
      guard generation == current else { return }
      var draft = restored ?? Draft(kind: .note)
      draft.followupRecordID = record.id
      let model = EditorModel(draft: draft, client: client, store: store, limits: info.limits, correctionCapability: info.features?.correction, historyCapability: info.features?.correctionHistory)
      model.onFollowupSaved = { [weak self] result in
        guard let self, self.generation == current else { return }
        var updated = self.records.first { $0.id == record.id } ?? record
        updated.followupSummary = result.followupSummary
        self.acceptFollowupRecord(updated)
      }
      editingModels[key] = model; editor = model; await model.persist()
    } catch { if generation == current { message = error.localizedDescription } }
  }
  @discardableResult
  func changeRecord(_ record: SuijiRecord, action: RecordAction, returnHomeAfterCompletion: Bool = false) async -> SuijiRecord? {
    guard let client, let store, !statusBusy.contains(record.id) else { return nil }
    let current = generation; statusBusy.insert(record.id); message = ""
    defer { if current == generation { statusBusy.remove(record.id) } }
    do {
      let previous = try await store.status(record.id)
      if previous == nil, let draft = try await store.load(record.id), draft.frozen { throw MessageError(message: "正文保存结果待确认，请先在编辑器确认") }
      let payload: [String: Any], suffix: String, method: String
      switch action {
      case .status(let target): payload = ["expectedVersion": record.version, "targetStatus": target.rawValue]; suffix = "/task-status"; method = "POST"
      case .trash(let trashed): payload = ["expectedVersion": record.version, "trashed": trashed]; suffix = "/trash"; method = "POST"
      case .tags(let tags): payload = ["expectedVersion": record.version, "tags": try SuijiTags.normalize(tags)]; suffix = ""; method = "PATCH"
      }
      let path = "api/suiji/v1/records/\(record.id)" + suffix
      let operation = try previous ?? PendingOperation(path: path, method: method, payload: JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
      try await store.saveStatus(operation, id: record.id)
      guard current == generation else { return nil }; pendingStatuses.insert(record.id)
      let result = try await client.request(RecordResponse.self, path: operation.path, method: operation.method, data: operation.payload, key: operation.key)
      guard current == generation else { return nil }
      try await store.removeStatus(record.id); pendingStatuses.remove(record.id)
      acceptFollowupRecord(result.record); message = ""
      if operation.method == "PATCH" || operation.path.hasSuffix("/trash") {
        do {
          let directory = try await client.request(TagDirectory.self, path: "api/suiji/v1/tags")
          if current == generation { availableTags = directory.items }
        } catch {
          if current == generation { message = "记录已更新，标签列表刷新失败，请重新读取" }
        }
      }
      if current == generation, returnHomeAfterCompletion, operation.path.hasSuffix("/task-status"), result.record.taskStatus == .done, result.record.deletedAt == nil {
        returnHomeRequest = UUID()
      }
      return current == generation ? result.record : nil
    } catch let error as APIError {
      guard current == generation else { return nil }
      if !error.uncertain {
        do { try await store.removeStatus(record.id); pendingStatuses.remove(record.id) } catch { message = "本机操作状态写入失败"; return nil }
      }
      if error.error.code == "VERSION_CONFLICT" {
        do {
          let latest = try await client.request(RecordResponse.self, path: "api/suiji/v1/records/\(record.id)")
          guard current == generation else { return nil }
          acceptFollowupRecord(latest.record)
          message = "记录已在其他地方更新，已显示最新内容，请重新选择标签或操作"
        } catch { if current == generation { message = "记录已有新版本，读取失败，请返回列表重新打开后再操作" } }
        return nil
      }
      message = error.localizedDescription
    } catch { if current == generation { message = "操作结果待确认：" + error.localizedDescription } }
    return nil
  }
}
