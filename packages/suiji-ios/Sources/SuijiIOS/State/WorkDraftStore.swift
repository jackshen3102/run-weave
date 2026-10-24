import Foundation
import CryptoKit
struct WorkDraft: Codable, Sendable {
  var fields: WorkFactInput
  var base: WorkFact?
  var pending: PendingOperation?
}
struct WorkBatch: Codable, Sendable {
  var id = UUID().uuidString
  var rows: [WorkFact]
  var project = ""
  var undo = false
  var pending: PendingOperation?
}
struct WorkLocal: Codable, Sendable {
  var revision = 0
  var from = ""
  var to = ""
  var drafts: [String: WorkDraft] = [:]
  var batch: WorkBatch?
  var undo: [WorkRestoreItem]?
}
actor WorkDraftStore {
  private let file: URL
  private var revision = -1
  init(endpoint: URL, info: ServiceInfo, environment: ConnectionEnvironment) throws {
    let identity = environment.scoped(endpoint.absoluteString + "\n" + info.serverId + "\n" + info.ownerId)
    let scope = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    var root = base.appendingPathComponent("SuijiDrafts/" + scope + "/work", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    var values = URLResourceValues(); values.isExcludedFromBackup = true; try root.setResourceValues(values)
    file = root.appendingPathComponent("state.json")
  }
  func load() throws -> WorkLocal {
    guard FileManager.default.fileExists(atPath: file.path) else { return WorkLocal() }
    let value = try JSONDecoder().decode(WorkLocal.self, from: Data(contentsOf: file)); revision = value.revision; return value
  }
  func save(_ value: WorkLocal) throws {
    guard value.revision >= revision else { return }
    try JSONEncoder().encode(value).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]); revision = value.revision
  }
}
