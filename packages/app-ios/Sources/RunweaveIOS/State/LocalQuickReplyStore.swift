import Foundation
import SwiftUI

struct LocalQuickReply: Codable, Identifiable, Equatable {
  let id: UUID
  var title: String
  var body: String
  let createdAt: Date
  var updatedAt: Date
}

/// Personal device data, deliberately independent of connection and terminal lifetimes.
@MainActor
final class LocalQuickReplyStore: ObservableObject {
  private struct Archive: Codable {
    let schemaVersion: Int
    let items: [LocalQuickReply]
  }
  struct Failure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
  }
  @Published private(set) var items: [LocalQuickReply] = []
  @Published private(set) var loading = false
  @Published private(set) var saving = false
  @Published private(set) var readError: String?
  private var loaded = false
  var canEdit: Bool { loaded && !loading && !saving && readError == nil }

  func load() async {
    guard !loading, !saving else { return }
    loading = true
    defer { loading = false }
    do {
      let value = try await Task.detached {
        let file = try Self.file()
        guard FileManager.default.fileExists(atPath: file.path) else { return [LocalQuickReply]() }
        let archive = try JSONDecoder().decode(Archive.self, from: Data(contentsOf: file))
        guard archive.schemaVersion == 1, archive.items.count <= 500,
          Set(archive.items.map(\.id)).count == archive.items.count
        else { throw Failure(message: "不支持的快捷回复文件") }
        for item in archive.items { _ = try Self.validatedTitle(item.title, body: item.body) }
        return archive.items
      }.value
      items = value
      loaded = true
      readError = nil
    } catch {
      readError = "本地快捷回复无法读取，原文件已保留；请恢复文件后重试，不会自动清空。"
    }
  }

  func loadIfNeeded() async { if !loaded && readError == nil { await load() } }

  func save(id: UUID?, title: String, body: String) async throws {
    let title = try Self.validatedTitle(title, body: body)
    var next = items
    if let id {
      guard let index = next.firstIndex(where: { $0.id == id }) else {
        throw Failure(message: "此回复已不存在，请返回列表。")
      }
      next[index].title = title
      next[index].body = body
      next[index].updatedAt = Date()
    } else {
      guard next.count < 500 else { throw Failure(message: "最多保存 500 条，请先删除不再使用的回复。") }
      next.append(
        LocalQuickReply(id: UUID(), title: title, body: body, createdAt: Date(), updatedAt: Date()))
    }
    try await commit(next)
  }

  func delete(_ id: UUID) async throws { try await commit(items.filter { $0.id != id }) }

  func move(from offsets: IndexSet, to destination: Int) async throws {
    var next = items
    next.move(fromOffsets: offsets, toOffset: destination)
    try await commit(next)
  }

  private func commit(_ next: [LocalQuickReply]) async throws {
    guard canEdit else { throw Failure(message: "快捷回复暂不可写，请等待操作完成或重试读取。") }
    saving = true
    defer { saving = false }
    do {
      try await Task.detached {
        let data = try JSONEncoder().encode(Archive(schemaVersion: 1, items: next))
        try data.write(
          to: Self.file(), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      }.value
      items = next
    } catch {
      throw Failure(message: "快捷回复未能保存到本机，原数据已保留，请重试。")
    }
  }

  private nonisolated static func validatedTitle(_ title: String, body: String) throws -> String {
    guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw Failure(message: "请输入回复正文。")
    }
    guard body.utf8.count <= 64 * 1024 else { throw Failure(message: "正文不能超过 64 KiB，请缩短后保存。") }
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count <= 80 else { throw Failure(message: "标题不能超过 80 个字符。") }
    if !trimmed.isEmpty { return trimmed }
    let line =
      body.components(separatedBy: .newlines)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty } ?? body
    return String(line.prefix(40))
  }

  private nonisolated static func file() throws -> URL {
    var directory = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ).appendingPathComponent("native-quick-replies", isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try directory.setResourceValues(values)
    return directory.appendingPathComponent("replies.json")
  }
}
