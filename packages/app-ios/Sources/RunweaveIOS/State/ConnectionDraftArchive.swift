import CryptoKit
import Foundation
import UIKit

/// Local, protected drafts survive a notification cold start; they never enter the push payload.
@MainActor
final class ConnectionDraftArchive {
  struct Snapshot: Codable {
    var text: [String: String]
    var images: [String: [Image]]
  }
  struct Image: Codable {
    let preview: Data
    let mimeType: String
    let data: Data?
    let path: String?
  }
  private var memory: [String: (text: [String: String], images: [String: [TerminalDraftImage]])] =
    [:]
  private var imageSignatures: [String: String] = [:]
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
  func save(scope: String, text: [String: String], images: [String: [TerminalDraftImage]]) throws {
    memory[scope] = (text, images)
    let destination = try file(scope)
    if text.isEmpty && images.isEmpty {
      try remove(scope)
      return
    }
    try JSONEncoder().encode(text).write(
      to: destination.appendingPathExtension("text"),
      options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    var parts: [String] = []
    for terminal in images.keys.sorted() {
      for image in images[terminal] ?? [] {
        parts.append(terminal)
        parts.append(image.id.uuidString)
        parts.append(image.path ?? "")
        parts.append(String(image.data?.count ?? 0))
      }
    }
    let signature = parts.joined(separator: "|")
    guard imageSignatures[scope] != signature else { return }
    var attachments: [String: [Image]] = [:]
    for (terminal, values) in images {
      attachments[terminal] = try values.map { value in
        guard let preview = value.preview.jpegData(compressionQuality: 0.7) else {
          throw APIError.invalidResponse
        }
        return Image(preview: preview, mimeType: value.mimeType, data: value.data, path: value.path)
      }
    }
    try JSONEncoder().encode(attachments).write(
      to: destination.appendingPathExtension("images"),
      options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    imageSignatures[scope] = signature
  }
  func read(_ scope: String) throws -> (
    text: [String: String], images: [String: [TerminalDraftImage]]
  ) {
    if let value = memory[scope] { return value }
    let source = try file(scope)
    let textURL = source.appendingPathExtension("text")
    let imagesURL = source.appendingPathExtension("images")
    let text =
      FileManager.default.fileExists(atPath: textURL.path)
      ? try JSONDecoder().decode([String: String].self, from: Data(contentsOf: textURL)) : [:]
    let storedImages =
      FileManager.default.fileExists(atPath: imagesURL.path)
      ? try JSONDecoder().decode([String: [Image]].self, from: Data(contentsOf: imagesURL)) : [:]
    let images = try storedImages.mapValues { values in
      try values.map { value in
        guard let preview = UIImage(data: value.preview) else { throw APIError.invalidResponse }
        return TerminalDraftImage(
          preview: preview, mimeType: value.mimeType, data: value.data, path: value.path,
          failure: value.path == nil ? "上传已暂停，请重试" : nil)
      }
    }
    return (text, images)
  }
  func remove(_ scope: String) throws {
    memory.removeValue(forKey: scope)
    imageSignatures.removeValue(forKey: scope)
    let base = try file(scope)
    for url in [base.appendingPathExtension("text"), base.appendingPathExtension("images")] {
      if FileManager.default.fileExists(atPath: url.path) {
        try FileManager.default.removeItem(at: url)
      }
    }
  }
}
