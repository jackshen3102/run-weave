import Foundation
import CryptoKit
struct LocalAttachment: Codable, Identifiable, Equatable, Sendable {
  var id = UUID().uuidString
  var fileName: String
  var mimeType: String
  var kind: String
  var byteSize: Int
  var uploadKey = UUID().uuidString
  var uploaded: Attachment?
}
struct PendingOperation: Codable, Sendable {
  var key = UUID().uuidString
  let path: String
  let method: String
  let payload: Data
}
struct Draft: Codable, Identifiable, Sendable {
  var id: String { recordID ?? "new" }
  var kind: RecordKind = .task
  var body = ""
  var recordID: String?
  var expectedVersion: Int?
  var existing: [Attachment] = []
  var local: [LocalAttachment] = []
  var frozen = false
  var pending: PendingOperation?
  var conflict = false
  var revision: Int = 0
}
actor DraftStore {
  let root: URL
  private var revisions: [String: Int] = [:]
  init(endpoint: URL, info: ServiceInfo, environment: ConnectionEnvironment) throws {
    let identity = environment.scoped(endpoint.absoluteString + "\n" + info.serverId + "\n" + info.ownerId)
    let scope = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    root = base.appendingPathComponent("SuijiDrafts/" + scope, isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    var directory = root; try directory.setResourceValues(values)
  }
  private func url(_ id: String, prefix: String = "draft-") throws -> URL {
    guard id == "new" || UUID(uuidString: id) != nil else { throw MessageError(message: "草稿标识无效") }
    return root.appendingPathComponent(prefix + id + ".json")
  }
  func load(_ id: String) throws -> Draft? {
    let path = try url(id)
    guard FileManager.default.fileExists(atPath: path.path) else { revisions[id] = nil; return nil }
    let value = try JSONDecoder().decode(Draft.self, from: Data(contentsOf: path)); revisions[id] = value.revision; return value
  }
  func save(_ value: Draft) throws {
    if let revision = revisions[value.id], revision > value.revision { return }
    try JSONEncoder().encode(value).write(to: url(value.id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    revisions[value.id] = value.revision
  }
  func remove(_ value: Draft) throws {
    try FileManager.default.removeItem(at: url(value.id))
    revisions[value.id] = Int.max // Reject older autosaves still queued at confirmation time.
    for item in value.local { try? FileManager.default.removeItem(at: root.appendingPathComponent(item.id)) }
  }
  func importFile(data: Data, fileName: String, mimeType: String, kind: String, limit: Int) throws -> LocalAttachment {
    guard !data.isEmpty, data.count <= limit else { throw MessageError(message: "附件为空或超过 \(limit / 1024 / 1024) MiB") }
    let item = LocalAttachment(fileName: fileName, mimeType: mimeType, kind: kind, byteSize: data.count)
    try data.write(to: root.appendingPathComponent(item.id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]); return item
  }
  func removeLocal(_ item: LocalAttachment) throws { try FileManager.default.removeItem(at: root.appendingPathComponent(item.id)) }
  func data(_ item: LocalAttachment) throws -> Data { try Data(contentsOf: root.appendingPathComponent(item.id)) }
  func status(_ id: String) throws -> PendingOperation? {
    let path = try url(id, prefix: "status-")
    guard FileManager.default.fileExists(atPath: path.path) else { return nil }
    return try JSONDecoder().decode(PendingOperation.self, from: Data(contentsOf: path))
  }
  func saveStatus(_ operation: PendingOperation, id: String) throws {
    try JSONEncoder().encode(operation).write(to: url(id, prefix: "status-"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
  func removeStatus(_ id: String) throws { try FileManager.default.removeItem(at: url(id, prefix: "status-")) }
}
