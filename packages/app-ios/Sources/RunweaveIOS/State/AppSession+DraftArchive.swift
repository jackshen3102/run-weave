import Foundation

extension AppSession {
  func scheduleDraftSave() {
    guard !changingDraftScope else { return }
    draftSaveTask?.cancel()
    draftSaveTask = Task { [weak self] in
      do { try await Task.sleep(nanoseconds: 500_000_000) } catch { return }
      self?.saveDraftsNow()
    }
  }
  func saveDraftsNow() {
    draftSaveTask?.cancel()
    draftSaveTask = nil
    guard let connection, !unreadableDraftScopes.contains(connection.scope) else { return }
    do {
      try draftArchive.save(
        scope: connection.scope, text: terminalDrafts, images: imageDrafts.images)
    } catch { self.error = "草稿暂未保存到本机，当前内容仍保留" }
  }
  func archivedDrafts(_ connection: BackendConnection?) -> (
    text: [String: String], images: [String: [TerminalDraftImage]]
  ) {
    guard let connection else { return ([:], [:]) }
    do { return try draftArchive.read(connection.scope) } catch {
      unreadableDraftScopes.insert(connection.scope)
      self.error = "本地草稿无法读取，原数据已保留"
      return ([:], [:])
    }
  }
  func forgetDrafts(_ connection: BackendConnection?) {
    draftSaveTask?.cancel()
    draftSaveTask = nil
    guard let connection else { return }
    discardDraftContents(connection)
    do {
      try draftArchive.remove(connection.scope)
      unreadableDraftScopes.remove(connection.scope)
    } catch { self.error = "本地草稿清理失败" }
  }
}
