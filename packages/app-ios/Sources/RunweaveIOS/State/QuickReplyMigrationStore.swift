import Foundation
import SwiftUI

@MainActor
final class QuickReplyMigrationStore: ObservableObject {
  private struct Archive: Codable { var imported: [String: [UUID]] }
  @Published private(set) var imported: [String: [UUID]] = [:]
  @Published private(set) var loading = false
  @Published private(set) var importing = false
  @Published var failure: String?
  @Published private(set) var itemFailures: [UUID: String] = [:]
  private var loaded = false

  func loadIfNeeded() async {
    guard !loaded, !loading else { return }
    loading = true
    defer { loading = false }
    do {
      let archive = try await Task.detached {
        let path = try Self.file()
        guard FileManager.default.fileExists(atPath: path.path) else { return Archive(imported: [:]) }
        return try JSONDecoder().decode(Archive.self, from: Data(contentsOf: path))
      }.value
      imported = archive.imported
      failure = nil
      loaded = true
    } catch {
      failure = "旧快捷回复的导入进度无法读取，原文件已保留；修复后重试。"
    }
  }

  func remaining(_ items: [LocalQuickReply], scope: String?) -> [LocalQuickReply] {
    guard let scope else { return items }
    let completed = Set(imported[scope] ?? [])
    return items.filter { !completed.contains($0.id) }
  }

  func importReplies(_ legacy: LocalQuickReplyStore, session: AppSession) async {
    await loadIfNeeded()
    guard loaded, !importing, let scope = session.connection?.scope, session.canWrite,
      legacy.readError == nil else { return }
    importing = true
    itemFailures = [:]
    failure = nil
    defer { importing = false }
    for item in remaining(legacy.items, scope: scope) {
      guard session.connection?.scope == scope, session.canWrite else { break }
      do {
        let saved = try await session.withConnection(reportFailure: false) {
          try await QuickInputService(api: $0).create(
            title: item.title, data: item.body, clientImportId: item.id.uuidString.lowercased())
        }
        guard saved.clientImportId?.lowercased() == item.id.uuidString.lowercased() else {
          throw APIError.invalidResponse
        }
        try await markImported(item.id, scope: scope)
      } catch {
        itemFailures[item.id] = displayError(error)
      }
    }
  }

  private func markImported(_ id: UUID, scope: String) async throws {
    var next = imported
    var values = Set(next[scope] ?? [])
    values.insert(id)
    next[scope] = Array(values)
    do {
      try await Task.detached {
        let data = try JSONEncoder().encode(Archive(imported: next))
        try data.write(to: Self.file(), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      }.value
      imported = next
    } catch {
      throw LocalQuickReplyStore.Failure(message: "导入成功，但进度未能保存在手机。旧文件已保留，请重试确认。")
    }
  }

  private nonisolated static func file() throws -> URL {
    let directory = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ).appendingPathComponent("native-quick-replies", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    return directory.appendingPathComponent("import-progress.json")
  }
}
