import Foundation

extension AppSession {
  /// Sends a fixed reply without consuming or changing the composer's text and attachments.
  func sendInstantReply(_ text: String, terminalID: String, controller: SessionController) async throws {
    guard canWrite, terminal?.id == terminalID, terminalController === controller else {
      throw APIError.offline
    }
    let epoch = generation
    do {
      try await controller.sendCommand(text, mode: "line", recordQuickInput: false)
      guard generation == epoch, terminalController === controller, !Task.isCancelled else {
        throw CancellationError()
      }
    } catch {
      if generation == epoch, !(error is CancellationError) {
        await handle(error, epoch: epoch, reportFailure: false)
      }
      throw error
    }
  }

  func sendCommand(terminalID: String) async throws {
    guard canWrite, terminal?.id == terminalID, let controller = terminalController else {
      throw APIError.offline
    }
    let draft = terminalDrafts[terminalID] ?? ""
    let draftRevision = draftRevisions[terminalID]
    let recordQuickInput: Bool? = suppressedQuickInputDrafts.contains(terminalID) ? false : nil
    let text = draft.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
    let images = imageDrafts.images[terminalID] ?? []
    guard images.allSatisfy({ $0.path != nil }) else {
      throw AttachmentError("请等待图片上传完成，或重试、移除上传失败的图片")
    }
    let paths = images.compactMap(\.path).map {
      "'" + $0.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }
    let payload = ([text].filter { !$0.isEmpty } + paths).joined(separator: " ")
    guard !payload.isEmpty else { return }
    let epoch = generation
    let agent = overview?.sessions.first { $0.id == terminalID }?.terminalState.agent
    let isSlash = text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/")
    let mode = agent == "codex" && isSlash ? "codex_slash_command" : "line"
    do {
      try await controller.sendCommand(payload, mode: mode, recordQuickInput: recordQuickInput)
      guard generation == epoch, terminalController === controller, !Task.isCancelled else {
        throw CancellationError()
      }
      if draftRevisions[terminalID] == draftRevision { setDraft("", terminalID: terminalID) }
      imageDrafts.remove(Set(images.map(\.id)), terminalID: terminalID)
    } catch {
      if generation == epoch, !(error is CancellationError) { await handle(error, epoch: epoch) }
      throw error
    }
  }
}
