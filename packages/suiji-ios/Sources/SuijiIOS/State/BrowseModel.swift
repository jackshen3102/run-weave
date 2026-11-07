import Foundation
import CryptoKit
import SuijiCaptureCore
struct BrowseDraft: Codable {
  var captureId = UUID().uuidString; var body = ""; var url = ""; var date = MaterialInput.day(Date())
  var image: Data?; var pending: QueuedCapture?
}
struct BrowseLocal: Codable { var draft = BrowseDraft(); var operations: [String: PendingOperation] = [:] }
@MainActor final class BrowseModel: ObservableObject {
  @Published var items: [BrowseEntry] = []; @Published var counts: [BrowseDayCount] = []; @Published var digests: [BrowseDigest] = []
  @Published var sources: [BrowseSource] = []; @Published var connections: [BrowseConnection] = []
  @Published var source = ""; @Published var type = ""; @Published var from = ""; @Published var to = ""; @Published var query = ""
  @Published var message = ""; @Published var loading = false; @Published var busy = false; @Published var nextCursor: String?
  @Published var local = BrowseLocal(); @Published var editor = false
  let session: SuijiSession
  private var generation = UUID(); private var file: URL?
  var supported: Bool { session.info?.features?.browse == true }
  var filterKey: String { [source,type,from,to,query].joined(separator: "|") }
  init(session: SuijiSession) {
    self.session = session
    guard let info = session.info, let endpoint = session.client?.endpoint else { return }
    do {
      let identity = session.environment.scoped(endpoint.absoluteString + "\n" + info.serverId + "\n" + info.ownerId)
      let hash = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
      var root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("SuijiDrafts/" + hash + "/browse", isDirectory: true)
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      var values = URLResourceValues(); values.isExcludedFromBackup = true; try root.setResourceValues(values)
      file = root.appendingPathComponent("state.json")
      if let file, FileManager.default.fileExists(atPath: file.path) { local = try JSONDecoder().decode(BrowseLocal.self, from: Data(contentsOf: file)) }
    } catch { message = error.localizedDescription }
  }
  func persist() throws {
    guard let file else { throw MessageError(message: "浏览草稿存储不可用") }
    try JSONEncoder().encode(local).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
  func saveDraft() { do { try persist() } catch { message = error.localizedDescription } }
  func load(more: Bool = false, trash: Bool = false) async {
    guard supported, let client = session.client else { return }
    if more && (loading || nextCursor == nil) { return }
    let request = UUID(); generation = request; loading = true
    if !more { items = []; counts = []; digests = []; nextCursor = nil }
    defer { if generation == request { loading = false } }
    do {
      var q = [URLQueryItem(name: "limit", value: "30")]
      for (k,v) in [("source",source),("type",type),("from",from),("to",to),("q",query)] where !v.isEmpty { q.append(URLQueryItem(name:k,value:v)) }
      if trash { q.append(URLQueryItem(name:"trash",value:"true")) }
      if more, let nextCursor { q.append(URLQueryItem(name:"cursor",value:nextCursor)) }
      var url = URLComponents(); url.queryItems = q
      let page = try await client.request(BrowsePage.self, path: "api/suiji/v1/browse/entries" + (url.string ?? ""))
      guard generation == request, session.isCurrent(client) else { return }
      if more { let existing = Set(items.map(\.id)); items += page.items.filter { !existing.contains($0.id) } } else { items = page.items }
      if more {
        let incoming = page.digests ?? []; let replaced = Set(incoming.map(\.id))
        digests = digests.filter { !replaced.contains($0.id) } + incoming
      } else { digests = page.digests ?? [] }
      counts = page.dayCounts; sources = page.sources ?? sources; nextCursor = page.nextCursor; message = ""
    } catch { if generation == request { message = error.localizedDescription } }
  }
  func detail(_ entry: BrowseEntry) async throws -> BrowseEntry {
    guard let client = session.client else { throw CancellationError() }
    let value = try await client.request(BrowseEntryResponse.self, path: "api/suiji/v1/browse/entries/" + entry.id)
    guard session.isCurrent(client) else { throw CancellationError() }; return value.entry
  }
  func mutate(_ entry: BrowseEntry, fields: [String: Any], trash: Bool = false) async -> BrowseEntry? {
    guard let client = session.client, !busy else { return nil }; busy = true; defer { busy = false }
    do {
      if local.operations[entry.id] == nil {
        local.operations[entry.id] = PendingOperation(path: "api/suiji/v1/browse/entries/" + entry.id + (trash ? "/trash" : ""), method: trash ? "POST" : "PATCH", payload: try JSONSerialization.data(withJSONObject: fields.merging(["expectedVersion": entry.version]) { a, _ in a }))
        try persist()
      }
      let p = local.operations[entry.id]!
      let value = try await client.request(BrowseEntryResponse.self, path:p.path, method:p.method, data:p.payload, key:p.key)
      guard session.isCurrent(client), value.entry.id == entry.id else { throw CancellationError() }
      local.operations[entry.id] = nil; try persist(); message = ""; return value.entry
    } catch {
      if let e = error as? APIError, !e.uncertain { local.operations[entry.id] = nil; try? persist() }
      message = error.localizedDescription; return nil
    }
  }
  func save() async {
    guard let connection = session.captureConnection, let client = session.client, supported, !busy else { return }
    busy = true; defer { busy = false }
    do {
      if !local.draft.url.isEmpty {
        guard let url = URL(string:local.draft.url), ["http","https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { throw MessageError(message:"请输入有效的 HTTP(S) 链接") }
      }
      try persist()
      if local.draft.pending == nil {
        var material = MaterialInput(inputType: local.draft.image == nil ? (local.draft.url.isEmpty ? "text" : "link") : "image")
        material.captureId = local.draft.captureId; material.materialDate = local.draft.date; material.sourceUrl = local.draft.url.isEmpty ? nil : local.draft.url
        local.draft.pending = try await CaptureQueue.enqueue(connection: connection, body: local.draft.body, material: material, image: local.draft.image, method: local.draft.image == nil ? "manual" : "picker")
        try persist()
      }
      try await CaptureQueue.send(local.draft.pending!, connection: connection, api: client.transport)
      guard session.isCurrent(client) else { return }
      local.draft = BrowseDraft(); try persist(); editor = false; session.refreshCaptures(); await load()
    } catch { message = error.localizedDescription; session.refreshCaptures() }
  }
  func loadConnections() async {
    guard let client = session.client else { return }
    do { let value = try await client.request(BrowseConnections.self, path:"api/suiji/v1/browse/connections"); if session.isCurrent(client) { connections = value.items } }
    catch { message = error.localizedDescription }
  }
}
