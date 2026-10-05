import CryptoKit
import Foundation
import UIKit

/// Local, protected drafts survive a notification cold start; they never enter the push payload.
@MainActor
final class ConnectionDraftArchive {
  private struct TextArchive: Codable {
    let schemaVersion: Int
    let text: [String: String]
    let suppressedQuickInputs: Set<String>
  }
  typealias Snapshot = (
    text: [String: String], attachments: [String: [TerminalDraftAttachment]], suppressedQuickInputs: Set<String>
  )
  struct Attachment: Codable {
    let preview: Data?
    let fileName: String?
    let mimeType: String
    let data: Data?
    let path: String?
  }
  private var memory: [String: Snapshot] = [:]
  private var attachmentSignatures: [String: String] = [:]
  private func file(_ scope: String) throws -> URL {
    let root = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true
    ).appendingPathComponent("native-terminal-drafts", isDirectory: true)
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var directory = root
    try directory.setResourceValues(values)
    let key = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
    return root.appendingPathComponent(key + ".json")
  }
  func save(
    scope: String, text: [String: String], attachments: [String: [TerminalDraftAttachment]],
    suppressedQuickInputs: Set<String>
  ) throws {
    memory[scope] = (text, attachments, suppressedQuickInputs)
    let destination = try file(scope)
    if text.isEmpty && attachments.isEmpty {
      try remove(scope)
      return
    }
    try JSONEncoder().encode(TextArchive(
      schemaVersion: 1, text: text,
      suppressedQuickInputs: suppressedQuickInputs.intersection(text.keys)
    )).write(
      to: destination.appendingPathExtension("text"),
      options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    var parts: [String] = []
    for terminal in attachments.keys.sorted() {
      for image in attachments[terminal] ?? [] {
        parts.append(terminal)
        parts.append(image.id.uuidString)
        parts.append(image.path ?? "")
        parts.append(String(image.data?.count ?? 0))
      }
    }
    let signature = parts.joined(separator: "|")
    guard attachmentSignatures[scope] != signature else { return }
    var storedAttachments: [String: [Attachment]] = [:]
    for (terminal, values) in attachments {
      storedAttachments[terminal] = try values.map { value in
        let preview = value.preview?.jpegData(compressionQuality: 0.7)
        if value.preview != nil && preview == nil {
          throw APIError.invalidResponse
        }
        return Attachment(preview: preview, fileName: value.fileName, mimeType: value.mimeType, data: value.data, path: value.path)
      }
    }
    // Keep the existing archive filename so upgrades retain unsent image drafts.
    try JSONEncoder().encode(storedAttachments).write(
      to: destination.appendingPathExtension("images"),
      options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    attachmentSignatures[scope] = signature
  }
  func read(_ scope: String) throws -> Snapshot {
    if let value = memory[scope] { return value }
    let source = try file(scope)
    let textURL = source.appendingPathExtension("text")
    let attachmentsURL = source.appendingPathExtension("images")
    var text: [String: String] = [:]
    var suppressedQuickInputs = Set<String>()
    if FileManager.default.fileExists(atPath: textURL.path) {
      let data = try Data(contentsOf: textURL)
      let decoder = JSONDecoder()
      if let legacy = try? decoder.decode([String: String].self, from: data) {
        text = legacy
      } else {
        let archive = try decoder.decode(TextArchive.self, from: data)
        guard archive.schemaVersion == 1 else { throw APIError.invalidResponse }
        text = archive.text
        suppressedQuickInputs = archive.suppressedQuickInputs.intersection(text.keys)
      }
    }
    let storedAttachments =
      FileManager.default.fileExists(atPath: attachmentsURL.path)
      ? try JSONDecoder().decode([String: [Attachment]].self, from: Data(contentsOf: attachmentsURL)) : [:]
    let attachments = try storedAttachments.mapValues { values in
      try values.map { value in
        let preview = value.preview.flatMap { UIImage(data: $0) }
        if value.preview != nil && preview == nil { throw APIError.invalidResponse }
        return TerminalDraftAttachment(
          preview: preview, fileName: value.fileName, mimeType: value.mimeType, data: value.data, path: value.path,
          failure: value.path == nil ? "上传已暂停，请重试" : nil)
      }
    }
    return (text, attachments, suppressedQuickInputs)
  }
  func remove(_ scope: String) throws {
    memory.removeValue(forKey: scope)
    attachmentSignatures.removeValue(forKey: scope)
    let base = try file(scope)
    for url in [base.appendingPathExtension("text"), base.appendingPathExtension("images")] {
      if FileManager.default.fileExists(atPath: url.path) {
        try FileManager.default.removeItem(at: url)
      }
    }
  }
}
