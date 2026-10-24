import SwiftUI
@MainActor final class WorkRecordModel: ObservableObject {
  @Published private(set) var items: [WorkFact] = []
  @Published private(set) var days: [WorkDay] = []
  @Published private(set) var nextCursor: String?
  @Published private(set) var loading = false
  @Published private(set) var busy = false
  @Published var message = ""
  @Published var detail: WorkFact?
  @Published var editorID: String?
  @Published private(set) var local = WorkLocal()
  private weak var session: SuijiSession?
  private let client: APIClient?
  private var store: WorkDraftStore?
  private var generation = UUID()
  private var readTask: Task<WorkFactPage, Error>?
  private var initialized = false
  private let root = "api/suiji/v1/work-facts"
  init(session: SuijiSession) { self.session = session; client = session.client }
  private var active: Bool { guard let client else { return false }; return session?.isCurrent(client) == true }
  static func today() -> String { let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(identifier: "Asia/Shanghai"); formatter.dateFormat = "yyyy-MM-dd"; return formatter.string(from: Date()) }
  private func persist() async throws {
    guard let store else { throw MessageError(message: "工作草稿尚未就绪") }
    local.revision += 1; let snapshot = local; try await store.save(snapshot)
  }
  func initialize() async {
    guard !initialized, let session, let client, let info = session.info else { return }; initialized = true
    do { store = try WorkDraftStore(endpoint: client.endpoint, info: info, environment: session.environment); let saved = try await store!.load(); guard active else { return }; local = saved; await load() }
    catch { if active { message = error.localizedDescription; initialized = false } }
  }
  func load(more: Bool = false, restart: Bool = true) async {
    guard let client, active, !(more && (loading || nextCursor == nil)) else { return }
    readTask?.cancel()
    let current = UUID(); generation = current; loading = true; message = ""
    var query = URLComponents(); query.queryItems = (local.from.isEmpty ? [] : [URLQueryItem(name: "from", value: local.from)]) + (local.to.isEmpty ? [] : [URLQueryItem(name: "to", value: local.to)]) + (more ? nextCursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [] : [])
    if !more { items = []; days = []; nextCursor = nil }
    defer { if current == generation { loading = false; readTask = nil } }
    do {
      let path = root + "?" + (query.percentEncodedQuery ?? "")
      let task = Task { try await client.request(WorkFactPage.self, path: path) }; readTask = task
      let page = try await task.value
      guard active, generation == current else { return }
      items = more ? items + page.items : page.items
      var merged = Dictionary(uniqueKeysWithValues: days.map { ($0.date, $0) }); for d in page.days { merged[d.date] = d }; days = merged.values.sorted { $0.date > $1.date }; nextCursor = page.nextCursor
    } catch {
      guard active, generation == current else { return }
      if let e = error as? APIError, e.error.code == "WORK_FEED_CHANGED", restart { await load(restart: false); return }
      message = error.localizedDescription
    }
  }
  func dates(from: String, to: String) async {
    guard from.isEmpty || to.isEmpty || from <= to else { message = "开始日期不能晚于结束日期"; return }
    local.from = from; local.to = to
    do { try await persist(); guard active else { return }; await load() } catch { if active { message = error.localizedDescription } }
  }
  func open(_ id: String) async {
    guard let client else { return }; let current = generation
    do { let result = try await client.request(WorkFactResponse.self, path: root + "/" + id); if active, generation == current { detail = result.fact } } catch { if active { message = error.localizedDescription } }
  }
  func edit(_ fact: WorkFact? = nil) async {
    guard !busy else { return }; let id = fact?.id ?? "new"
    if local.drafts[id] == nil { local.drafts[id] = WorkDraft(fields: fact.map(WorkFactInput.init) ?? WorkFactInput(date: Self.today()), base: fact) }
    do { try await persist(); if active { editorID = id; message = "" } } catch { if active { message = error.localizedDescription } }
  }
  func update(_ fields: WorkFactInput) {
    guard let id = editorID, local.drafts[id]?.pending == nil, !busy else { return }
    local.drafts[id]?.fields = fields
    Task { do { try await persist() } catch { if active { message = error.localizedDescription } } }
  }
  func discard() async {
    guard let id = editorID, local.drafts[id]?.pending == nil, !busy else { return }
    local.drafts[id] = nil
    do { try await persist(); if active { editorID = nil } } catch { if active { message = error.localizedDescription } }
  }
  func refreshVersion() async {
    guard let id = editorID, local.drafts[id]?.base != nil, local.drafts[id]?.pending == nil, let client else { return }
    do { let result = try await client.request(WorkFactResponse.self, path: root + "/" + id); guard active else { return }; local.drafts[id]?.base = result.fact; detail = result.fact; try await persist(); message = "已读取当前版本，保留你的草稿；请核对后再保存。" } catch { if active { message = error.localizedDescription } }
  }
  func save() async {
    guard let id = editorID, var draft = local.drafts[id], let client, !busy, active else { return }
    busy = true; message = ""; defer { if active { busy = false } }
    do {
      if draft.pending == nil {
        var fields = draft.fields; fields.title = fields.title.trimmingCharacters(in: .whitespacesAndNewlines); let project = (fields.project ?? "").trimmingCharacters(in: .whitespacesAndNewlines); fields.project = project.isEmpty ? nil : project
        guard !fields.title.isEmpty, fields.title.unicodeScalars.count <= 80, !fields.statement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, fields.statement.unicodeScalars.count <= 4000, project.unicodeScalars.count <= 80 else { throw MessageError(message: "标题1–80字、正文1–4000字，项目最多80字") }
        var payload = fields.dictionary
        if let base = draft.base {
          let old = WorkFactInput(base).dictionary as NSDictionary
          payload = payload.filter { key, value in !((old[key] as AnyObject?)?.isEqual(value) ?? false) }
          if payload.isEmpty { editorID = nil; return }
          payload["expectedVersion"] = base.version
        }
        draft.pending = PendingOperation(path: root + (draft.base == nil ? "" : "/" + id), method: draft.base == nil ? "POST" : "PATCH", payload: try JSONSerialization.data(withJSONObject: payload))
        local.drafts[id] = draft; try await persist()
      }
      guard active else { return }; let p = draft.pending!
      let result = try await client.request(WorkFactResponse.self, path: p.path, method: p.method, data: p.payload, key: p.key)
      guard active else { return }
      let expected = try JSONSerialization.jsonObject(with: p.payload) as! [String: Any], actual = WorkFactInput(result.fact).dictionary as NSDictionary
      guard (draft.base == nil || result.fact.id == id), expected.allSatisfy({ $0.key == "expectedVersion" || ((actual[$0.key] as AnyObject?)?.isEqual($0.value) ?? false) }) else { throw MessageError(message: "保存回执不匹配，请手动确认原请求") }
      local.drafts[id] = nil; try await persist(); guard active else { return }; editorID = nil; detail = result.fact; await dates(from: result.fact.workDate, to: result.fact.workDate)
    } catch {
      guard active else { return }
      if let e = error as? APIError, !e.uncertain { local.drafts[id]?.pending = nil; try? await persist() }
      message = error.localizedDescription
    }
  }
  func beginBatch(_ rows: [WorkFact], undo: Bool = false) async {
    guard local.batch == nil, !busy else { return }; local.batch = WorkBatch(rows: rows, undo: undo)
    do { try await persist() } catch { if active { message = error.localizedDescription } }
  }
  func updateBatch(rows: [WorkFact], project: String) {
    guard local.batch?.pending == nil, !busy else { return }; local.batch?.rows = rows; local.batch?.project = project
    Task { do { try await persist() } catch { if active { message = error.localizedDescription } } }
  }
  func refreshBatch() async {
    guard var batch = local.batch, !batch.undo, batch.pending == nil, !busy, let client else { return }
    do {
      var rows: [WorkFact] = []
      for row in batch.rows { let result = try await client.request(WorkFactResponse.self, path: root + "/" + row.id); guard active else { return }; rows.append(result.fact) }
      batch.rows = rows; local.batch = batch; try await persist(); if active { message = "已读取所选事实的最新版本，请核对后再确认归类。" }
    } catch { if active { message = error.localizedDescription } }
  }
  func cancelBatch() async {
    guard local.batch?.pending == nil, !busy else { return }; local.batch = nil
    do { try await persist() } catch { if active { message = error.localizedDescription } }
  }
  func commitBatch() async {
    guard var batch = local.batch, let client, active, !busy else { return }; busy = true; message = ""; defer { if active { busy = false } }
    do {
      if batch.pending == nil {
        let payload: [String: Any]
        if batch.undo { guard let undo = local.undo, !undo.isEmpty else { throw MessageError(message: "没有可撤销的归类") }; payload = ["items": undo.map(\.dictionary)] }
        else { guard (1...100).contains(batch.rows.count) else { throw MessageError(message: "请选择1–100条已加载记录") }; let project = batch.project.trimmingCharacters(in: .whitespacesAndNewlines); payload = ["items": batch.rows.map { ["id": $0.id, "expectedVersion": $0.version] }, "project": project.isEmpty ? NSNull() : project as Any] }
        batch.pending = PendingOperation(path: root + (batch.undo ? "/reclassify/undo" : "/reclassify"), method: "POST", payload: try JSONSerialization.data(withJSONObject: payload)); local.batch = batch; try await persist()
      }
      guard active else { return }; let p = batch.pending!
      let result = try await client.request(WorkFactsResponse.self, path: p.path, method: p.method, data: p.payload, key: p.key)
      guard active else { return }
      let payload = try JSONSerialization.jsonObject(with: p.payload) as! [String: Any], requests = payload["items"] as! [[String: Any]]
      guard result.facts.count == requests.count, requests.allSatisfy({ item in result.facts.contains { f in f.id == item["id"] as? String && f.version == (item["expectedVersion"] as? Int ?? 0) + 1 && ((f.project as Any? ?? NSNull()) as AnyObject).isEqual(item["project"] ?? payload["project"] ?? NSNull()) } }) else { throw MessageError(message: "归类回执不匹配，请手动确认原请求") }
      local.undo = batch.undo ? nil : result.facts.map { f in WorkRestoreItem(id: f.id, expectedVersion: f.version, project: batch.rows.first { $0.id == f.id }!.project) }
      local.batch = nil; try await persist(); guard active else { return }
      if let current = detail, let updated = result.facts.first(where: { $0.id == current.id }) { detail = updated }; await load()
    } catch { guard active else { return }; if let e = error as? APIError, !e.uncertain { local.batch?.pending = nil; try? await persist() }; message = error.localizedDescription }
  }
}
