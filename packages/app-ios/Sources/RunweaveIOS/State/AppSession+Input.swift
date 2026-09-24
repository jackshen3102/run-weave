import Foundation

extension AppSession {
  func isCommandActive(_ id: String) -> Bool {
    overview?.sessions.first { $0.id == id }?.terminalState.state == "agent_running"
  }

  func stopCommand(_ id: String) async throws {
    guard canWrite, terminal?.id == id else { throw APIError.offline }
    try await withConnection { try await $0.interrupt(id: id) }
    // The authoritative terminal-state event decides whether the Agent stopped.
  }

  func appendDraft(_ text: String, terminalID: String) {
    guard !text.isEmpty else { return }
    let previous = terminalDrafts[terminalID] ?? ""
    setDraft(
      previous
        + (previous.isEmpty || previous.hasSuffix(" ") || previous.hasSuffix("\n") ? "" : " ")
        + text,
      terminalID: terminalID)
  }

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

  func composerQueueKey(terminalID: String) -> TerminalPromptSubmitKey? {
    guard terminal?.id == terminalID, let controller = terminalController else { return nil }
    let current = overview?.sessions.first { $0.id == terminalID }
    // Overview receives command-change events even when the open socket's metadata is unchanged.
    let command: String?
    if let current { command = current.activeCommand }
    else if let metadata = controller.metadata { command = metadata.activeCommand }
    else { command = terminal?.activeCommand }
    let token = command?.split(whereSeparator: { $0.isWhitespace }).first
    let agent = token.flatMap {
      String($0).replacingOccurrences(of: "\\", with: "/")
        .split(separator: "/").last.map(String.init)?.lowercased()
    }
    switch agent {
    case "codex", "trae", "traex", "traecli": return .tab
    case "pi": return .altEnter
    default: return nil
    }
  }

  func sendCommand(terminalID: String, queue: Bool = false) async throws {
    guard canWrite, terminal?.id == terminalID, let controller = terminalController else {
      throw APIError.offline
    }
    let submitKey = queue ? composerQueueKey(terminalID: terminalID) : nil
    guard !queue || submitKey != nil else { throw AttachmentError("当前终端不支持原生排队") }
    let draft = terminalDrafts[terminalID] ?? ""
    let draftRevision = draftRevisions[terminalID]
    let recordQuickInput: Bool? = suppressedQuickInputDrafts.contains(terminalID) ? false : nil
    let text = queue ? draft : draft.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
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
    let mode = queue ? "prompt_replace" : (agent == "codex" && isSlash ? "codex_slash_command" : "line")
    do {
      try await controller.sendCommand(payload, mode: mode, recordQuickInput: recordQuickInput,
        submitKey: submitKey)
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
