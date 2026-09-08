import SwiftUI
enum RecordAction { case status(TaskStatus), trash(Bool) }
@MainActor final class SuijiSession: ObservableObject {
  @Published var endpoint: String
  @Published var info: ServiceInfo?
  @Published var lastChangedRecord: SuijiRecord?
  @Published var records: [SuijiRecord] = []
  @Published var message = ""
  @Published var loading = false
  @Published var editor: EditorModel?
  @Published var nextCursor: String?
  @Published var pendingStatuses: Set<String> = []
  @Published var statusBusy: Set<String> = []
  private(set) var client: APIClient?
  private var store: DraftStore?
  private var editingModels: [String: EditorModel] = [:]
  private var generation = UUID()
  private var listGeneration = UUID()
  init(endpoint: URL?) { self.endpoint = endpoint?.absoluteString ?? UserDefaults.standard.string(forKey: "suiji.endpoint") ?? "" }
  func connect(username: String? = nil, password: String? = nil) async {
    let previous = client; generation = UUID(); let current = generation
    editingModels.values.forEach { $0.cancel() }; editingModels = [:]; editor = nil; lastChangedRecord = nil; records = []; info = nil; store = nil; client = nil; pendingStatuses = []; statusBusy = []
    await previous?.cancel()
    do {
      let url = try APIClient.normalize(endpoint); let api = try APIClient(endpoint: url); client = api
      endpoint = url.absoluteString; UserDefaults.standard.set(endpoint, forKey: "suiji.endpoint")
      let identity: ServiceInfo
      if let username, let password { identity = try await api.login(username: username, password: password) } else { identity = try await api.info() }
      guard generation == current else { await api.cancel(); return }
      let drafts = try DraftStore(endpoint: url, info: identity)
      store = drafts; info = identity; message = ""
    } catch { if generation == current { message = error.localizedDescription } }
  }
  func isCurrent(_ api: APIClient) -> Bool { client === api && info != nil }
  func logout() async {
    generation = UUID(); editingModels.values.forEach { $0.cancel() }; editingModels = [:]; editor = nil; lastChangedRecord = nil; info = nil; records = []; store = nil; pendingStatuses = []; statusBusy = []
    let old = client; client = nil
    do { try await old?.logout() } catch { message = error.localizedDescription }
  }
  func load(kind: String?, status: String?, q: String, more: Bool = false, trash: Bool = false) async {
    guard let client, info != nil else { return }
    if more && (loading || nextCursor == nil) { return }
    let current = generation, request = UUID(); listGeneration = request
    loading = true
    if !more { records = []; nextCursor = nil }
    defer { if listGeneration == request { loading = false } }
    var query = URLComponents(); var items: [URLQueryItem] = []
    if trash { items.append(URLQueryItem(name: "trash", value: "true")) }
    if let kind { items.append(URLQueryItem(name: "kind", value: kind)) }
    if let status { items.append(URLQueryItem(name: "taskStatus", value: status)) }
    if !q.isEmpty { items.append(URLQueryItem(name: "q", value: q)) }
    if more, let cursor = nextCursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
    query.queryItems = items
    do {
      let page = try await client.request(RecordPage.self, path: "api/suiji/v1/records?" + (query.percentEncodedQuery ?? ""))
      guard generation == current, listGeneration == request else { return }
      records = more ? records + page.items.filter { new in !records.contains { $0.id == new.id } } : page.items; nextCursor = page.nextCursor; message = ""
      if let store {
        var pending: Set<String> = []
        for record in records { if try await store.status(record.id) != nil { pending.insert(record.id) } }
        if generation == current, listGeneration == request { pendingStatuses = pending }
      }
    } catch {
      if generation == current, listGeneration == request {
        message = error.localizedDescription
        if let apiError = error as? APIError, apiError.error.code == "UNAUTHENTICATED" {
          generation = UUID(); editingModels.values.forEach { $0.cancel() }; editingModels = [:]; editor = nil; lastChangedRecord = nil
          records = []; info = nil; store = nil; await client.cancel(); self.client = nil
        }
      }
    }
  }
  func openEditor(record: SuijiRecord? = nil, kind: RecordKind = .note, body: String = "") async {
    guard let client, let store, let info else { return }; let current = generation
    guard record?.deletedAt == nil else { return }
    do {
      if let record, try await store.status(record.id) != nil { message = "此记录有状态操作待确认，请先手动重试确认"; return }
      if let cached = editingModels[record?.id ?? "new"], cached.canReopen {
        await cached.prepareForCapture(kind: kind, body: body)
        guard generation == current else { return }
        editor = cached; return
      }
      let restored = try await store.load(record?.id ?? "new")
      guard generation == current else { return }
      let draft = restored ?? Draft(kind: record?.kind ?? kind, body: record?.body ?? body, recordID: record?.id, expectedVersion: record?.version, existing: record?.attachments ?? [])
      let model = EditorModel(draft: draft, client: client, store: store, limits: info.limits); editingModels[draft.id] = model; editor = model
      await model.persist()
      if restored != nil { await model.prepareForCapture(kind: kind, body: body) }
    } catch { if generation == current { message = error.localizedDescription } }
  }
  func changeRecord(_ record: SuijiRecord, action: RecordAction) async {
    guard let client, let store, !statusBusy.contains(record.id) else { return }
    let current = generation; statusBusy.insert(record.id)
    defer { if current == generation { statusBusy.remove(record.id) } }
    do {
      let previous = try await store.status(record.id)
      if previous == nil, let draft = try await store.load(record.id), draft.frozen { throw MessageError(message: "正文保存结果待确认，请先在编辑器确认") }
      let payload: [String: Any], suffix: String
      switch action {
      case .status(let target): payload = ["expectedVersion": record.version, "targetStatus": target.rawValue]; suffix = "task-status"
      case .trash(let trashed): payload = ["expectedVersion": record.version, "trashed": trashed]; suffix = "trash"
      }
      let path = "api/suiji/v1/records/\(record.id)/" + suffix
      let operation = try previous ?? PendingOperation(path: path, method: "POST", payload: JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
      try await store.saveStatus(operation, id: record.id)
      guard current == generation else { return }; pendingStatuses.insert(record.id)
      let result = try await client.request(RecordResponse.self, path: operation.path, method: operation.method, data: operation.payload, key: operation.key)
      guard current == generation else { return }
      try await store.removeStatus(record.id); pendingStatuses.remove(record.id)
      lastChangedRecord = result.record
      if let index = records.firstIndex(where: { $0.id == record.id }) { records[index] = result.record }; message = ""
    } catch let error as APIError {
      guard current == generation else { return }
      if !error.uncertain {
        do { try await store.removeStatus(record.id); pendingStatuses.remove(record.id) } catch { message = "本机操作状态写入失败"; return }
      }
      message = error.localizedDescription
    } catch { if current == generation { message = "状态结果待确认：" + error.localizedDescription } }
  }
}
