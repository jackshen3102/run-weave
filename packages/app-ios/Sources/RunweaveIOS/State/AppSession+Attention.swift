import Foundation

extension AppSession {
  func refreshAttention() async {
    guard authenticated, foreground, health.status == .online, terminal == nil, let api else { return }
    let epoch = generation
    do {
      let value = try await api.attentionSnapshot()
      guard generation == epoch, foreground, terminal == nil, !Task.isCancelled else { return }
      attentionSnapshot = value
    } catch {
      if generation == epoch, !Task.isCancelled { await handle(error, epoch: epoch) }
    }
  }

  func openAttentionSlot(_ slot: AttentionSlot) async {
    guard let api else { return }
    let epoch = generation
    do {
      if canWrite, let panelID = slot.panelId {
        do {
          try await api.focusTerminalPanel(terminalID: slot.terminalSessionId, panelID: panelID)
          guard await reload() else { return }
        } catch APIError.http(404), APIError.http(409) {
          guard await reload() else { return }
        }
      }
      if canWrite, slot.actionKind == "question", slot.source.evidence == "terminal_question" {
        terminalQuestions.requestOpen(terminalID: slot.terminalSessionId)
      }
      await openTerminal(slot.terminalSessionId)
      guard generation == epoch, terminal?.id == slot.terminalSessionId else { return }
    } catch {
      if generation == epoch, !Task.isCancelled { await handle(error, epoch: epoch) }
    }
  }

  var nextCompletionTerminals: [HomeTerminal] {
    let candidates = (overview?.sessions ?? []).filter {
      $0.id != terminal?.id && $0.hasUnreadCompletion && !$0.isAgentActive
    }
    let byID = Dictionary(uniqueKeysWithValues: candidates.map { ($0.id, $0) })
    return attentionRetention.orderedIDs.compactMap { byID[$0] }
  }

  func openNextCompletion() async {
    guard canWrite, terminal != nil, !openingNextCompletion,
      let next = nextCompletionTerminals.first else { return }
    let epoch = generation
    openingNextCompletion = true
    defer { if generation == epoch { openingNextCompletion = false } }
    await openTerminal(next.id, requireUnreadCompletion: true)
  }

  /// Only acknowledges the revision the user actually chose to open/read.
  func acknowledgeTerminal(_ id: String, revision: Int? = nil) async {
    guard canWrite, let api, !acknowledgementWrites.contains(id),
      let item = overview?.sessions.first(where: { $0.id == id })
    else { return }
    let target = revision ?? item.completionRevision ?? 0
    guard target > (item.acknowledgedCompletionRevision ?? 0) else { return }
    let epoch = generation
    acknowledgementWrites.insert(id)
    defer { if generation == epoch { acknowledgementWrites.remove(id) } }
    do {
      let value = try await api.acknowledgeTerminal(id: id, revision: target)
      guard generation == epoch, !Task.isCancelled else { return }
      mergeCompletionAcknowledgement(value)
      NotificationCoordinator.shared.syncBadgeSoon()
    } catch {
      if generation == epoch {
        await handle(error, epoch: epoch)
      }
    }
  }

  func applyBellEvents(_ events: [TerminalEvent]) {
    let known = Set(overview?.sessions.map(\.id) ?? [])
    for event in events where event.kind == "terminal_bell" {
      guard let id = event.terminalSessionId, known.contains(id), terminal?.id != id else {
        continue
      }
      bellTasks[id]?.cancel()
      if !bellMarkers.contains(id) { bellMarkers.insert(id) }
      let epoch = generation
      bellTasks[id] = Task { [weak self] in
        do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
        guard let self, self.generation == epoch else { return }
        if self.bellMarkers.contains(id) { self.bellMarkers.remove(id) }
        self.bellTasks.removeValue(forKey: id)
      }
    }
  }

  func clearBellMarker(_ id: String) {
    bellTasks.removeValue(forKey: id)?.cancel()
    if bellMarkers.contains(id) { bellMarkers.remove(id) }
  }

  func clearBellMarkers() {
    for task in bellTasks.values { task.cancel() }
    bellTasks.removeAll()
    if !bellMarkers.isEmpty { bellMarkers.removeAll() }
  }
}
