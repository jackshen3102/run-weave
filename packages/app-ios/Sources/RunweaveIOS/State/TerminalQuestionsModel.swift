import Foundation

/// Question drafts never touch the terminal composer, attachments, queue or sendCommand.
@MainActor
final class TerminalQuestionsModel: ObservableObject {
  @Published private(set) var response: TerminalQuestionsResponse?
  @Published private(set) var error: String?
  @Published private(set) var submitting = false
  @Published private(set) var notificationStatus: TerminalQuestionNotificationResponse.Status?
  @Published private(set) var notificationResolved = false
  @Published private(set) var notificationTerminalID: String?
  @Published private(set) var requestedTerminalID: String?
  @Published private var drafts: [String: [String: String]] = [:]
  private var operations: [String: String] = [:]
  private var revision = UUID()
  private var terminalID: String?
  private var conversationKey: String?
  private var pinnedTarget: TerminalQuestionsResponse.Target?
  private var handoff: TerminalQuestionHandoff?

  func reset() {
    revision = UUID(); terminalID = nil; pinnedTarget = nil; response = nil; error = nil; submitting = false
    requestedTerminalID = nil
    drafts.removeAll(); operations.removeAll()
  }

  func requestOpen(terminalID: String) { requestedTerminalID = terminalID }
  func consumeOpen(terminalID: String) -> Bool {
    guard requestedTerminalID == terminalID else { return false }
    requestedTerminalID = nil
    return true
  }

  func open(terminalID: String, conversationKey: String?) {
    revision = UUID(); self.terminalID = terminalID; self.conversationKey = conversationKey; pinnedTarget = nil; response = nil; error = nil; submitting = false
  }

  func openNotification(_ target: TerminalQuestionHandoff) {
    close()
    handoff = target
    error = nil
    notificationStatus = nil
    notificationResolved = false
    notificationTerminalID = nil
  }

  func closeNotification(_ target: TerminalQuestionHandoff) {
    guard handoff?.id == target.id else { return }
    close()
    handoff = nil
  }

  var notificationSubmissionNeedsCheck: Bool {
    guard let handoff else { return false }
    return operations[handoff.reference] != nil && !notificationResolved
      && response?.requests.first?.state != "submitting"
  }

  func notificationUnavailable(_ target: TerminalQuestionHandoff) {
    guard handoff?.id == target.id else { return }
    response = nil
    notificationStatus = .unavailable
  }

  func invalidateNotificationTransport(_ target: TerminalQuestionHandoff) {
    guard handoff?.id == target.id, notificationStatus == .pending else { return }
    revision = UUID()
    submitting = false
    notificationUnavailable(target)
  }

  func refreshNotification(api: APIClient, target: TerminalQuestionHandoff, afterConflict: Bool = false) async {
    guard handoff?.id == target.id, !submitting else { return }
    let epoch = revision
    do {
      let location = try await api.terminalQuestionNotification(target)
      guard epoch == revision, !Task.isCancelled else { return }
      notificationTerminalID = location.terminalId
      terminalID = location.terminalId
      switch location.status {
      case .pending:
        guard !afterConflict, let value = location.questions, value.capability == "available",
          let original = value.target, original.terminalId == location.terminalId,
          original.panelId == location.panelId, value.requests.count == 1,
          let request = value.requests.first, request.threadId == original.threadId,
          request.generation == value.generation, ["pending", "submitting"].contains(request.state)
        else { notificationUnavailable(target); return }
        pinnedTarget = original
        response = value
        notificationStatus = .pending
      case .closed:
        response = nil
        notificationResolved = location.resolved == true
        notificationStatus = .closed
      case .unavailable:
        notificationUnavailable(target)
      }
      error = nil
    } catch {
      guard epoch == revision, !Task.isCancelled else { return }
      notificationUnavailable(target)
    }
  }

  func close() { revision = UUID(); response = nil; terminalID = nil; pinnedTarget = nil; submitting = false }

  private func key(_ request: TerminalQuestionRequest) -> String {
    handoff?.reference ?? [terminalID ?? "", pinnedTarget?.panelId ?? "", request.generation, request.requestId].joined(separator: "/")
  }

  func answer(_ request: TerminalQuestionRequest, questionID: String) -> String {
    drafts[key(request)]?[questionID] ?? ""
  }
  func setAnswer(_ value: String, request: TerminalQuestionRequest, questionID: String) {
    guard request.state == "pending", operations[key(request)] == nil, !submitting else { return }
    drafts[key(request), default: [:]][questionID] = value
  }
  func hasSubmitted(_ request: TerminalQuestionRequest) -> Bool { operations[key(request)] != nil }

  func canSubmit(_ request: TerminalQuestionRequest) -> Bool {
    error == nil && response?.capability == "available" && request.state == "pending" && !submitting
      && operations[key(request)] == nil
      && request.questions.allSatisfy { !answer(request, questionID: $0.id).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  }

  func refresh(api: APIClient, terminalID: String) async {
    guard self.terminalID == terminalID else { return }
    let epoch = revision
    do {
      let value = try await api.terminalQuestions(id: terminalID, panelID: pinnedTarget?.panelId)
      guard epoch == revision, !Task.isCancelled else { return }
      if let target = value.target, conversationKey != "codex:\(target.threadId):\(target.panelId)" {
        error = "任务归属已变化，请关闭后重新打开回复辅助。"; return
      }
      // Once the sheet is pinned, a new thread is never silently adopted.
      if let previous = pinnedTarget, let next = value.target,
        (previous.panelId != next.panelId || previous.threadId != next.threadId) {
        error = "任务已变化，请关闭后重新打开回复辅助。"; return
      }
      if pinnedTarget == nil { pinnedTarget = value.target }
      if value.capability != "available", response?.capability == "available" {
        error = value.reason ?? "原执行连接不可用，请回终端核对。"; return
      }
      response = value; error = nil
    } catch {
      guard epoch == revision, !Task.isCancelled else { return }
      self.error = "无法确认当前问题，答案草稿已保留。请回原终端核对。"
    }
  }

  func submit(api: APIClient, terminalID: String, request: TerminalQuestionRequest) async {
    guard self.terminalID == terminalID, canSubmit(request), let target = response?.target,
      response?.requests.contains(where: { $0.requestId == request.requestId && $0.generation == request.generation }) == true else { return }
    revision = UUID()
    let epoch = revision
    let draftKey = key(request)
    let operationID = UUID().uuidString
    let answers = Dictionary(uniqueKeysWithValues: request.questions.map { ($0.id, answer(request, questionID: $0.id)) })
    operations[draftKey] = operationID
    submitting = true; error = nil
    defer { if epoch == revision { submitting = false } }
    do {
      let value = try await api.answerTerminalQuestion(id: terminalID, panelID: target.panelId,
        request: request, operationID: operationID, answers: answers)
      guard epoch == revision, !Task.isCancelled else { return }
      if let handoff {
        submitting = false
        await refreshNotification(api: api, target: handoff)
      } else {
        response = value
      }
    } catch APIError.http(409) where handoff != nil {
      guard epoch == revision, !Task.isCancelled, let handoff else { return }
      submitting = false
      await refreshNotification(api: api, target: handoff, afterConflict: true)
    } catch {
      guard epoch == revision, !Task.isCancelled else { return }
      // Unknown delivery is not a retry button. The user's original draft stays available.
      self.error = "提交结果未确认，答案草稿已保留。请回原终端核对，不要重复发送。"
      if let handoff { notificationUnavailable(handoff) }
    }
  }
}
