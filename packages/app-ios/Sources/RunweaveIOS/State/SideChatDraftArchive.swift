import CryptoKit
import Foundation

struct SideChatDraft: Codable {
  var text = ""
  var start = 0
  var end = 0
  var revision = 0
}
struct SideChatPending: Codable {
  let operationID: String
  var chatID: String?
  let kind: String
  let draft: SideChatDraft?
}
struct SideChatArchive: Codable {
  var schemaVersion = 1
  var chatID: String?
  var visible = false
  var drafts: [String: SideChatDraft] = [:]
  var snapshots: [String: SideChatSnapshot] = [:]
  var readSequences: [String: Int] = [:]
  var pending: SideChatPending?
}
/// Separate protected storage; main terminal archives and attachment formats are untouched.
@MainActor
final class SideChatDraftArchive {
  private let file: URL
  init(scope: String, terminalID: String) throws {
    var root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true).appendingPathComponent("side-chat-drafts-v1", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    try root.setResourceValues(values)
    let key = SHA256.hash(data: Data((scope + "\u{0}" + terminalID).utf8))
      .map { String(format: "%02x", $0) }.joined()
    file = root.appendingPathComponent(key + ".json")
  }
  func load() throws -> SideChatArchive {
    guard FileManager.default.fileExists(atPath: file.path) else { return SideChatArchive() }
    let archive = try JSONDecoder().decode(SideChatArchive.self, from: Data(contentsOf: file))
    guard archive.schemaVersion == 1 else { throw APIError.invalidResponse }; return archive
  }
  func save(_ archive: SideChatArchive) throws {
    try JSONEncoder().encode(archive).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
}
