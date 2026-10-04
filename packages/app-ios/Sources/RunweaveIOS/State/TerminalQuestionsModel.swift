import Foundation

/// Question drafts never touch the terminal composer, attachments, queue or sendCommand.
@MainActor
final class TerminalQuestionsModel: ObservableObject {
  @Published private(set) var response: TerminalQuestionsResponse?
  @Published private(set) var error: String?
  @Published private(set) var submitting = false
  @Published private var drafts: [String: [String: String]] = [:]
  private var operations: [String: String] = [:]
  private var revision = UUID()
  private var terminalID: String?
  private var conversationKey: String?
  private var pinnedTarget: TerminalQuestionsResponse.Target?

  func reset() {
    revision = UUID(); terminalID = nil; pinnedTarget = nil; response = nil; error = nil; submitting = false
    drafts.removeAll(); operations.removeAll()
  }

  func open(terminalID: String, conversationKey: String?) {
    revision = UUID(); self.terminalID = terminalID; self.conversationKey = conversationKey; pinnedTarget = nil; response = nil; error = nil; submitting = false
  }

  func close() { revision = UUID(); response = nil; terminalID = nil; pinnedTarget = nil; submitting = false }

  private func key(_ request: TerminalQuestionRequest) -> String {
    [terminalID ?? "", pinnedTarget?.panelId ?? "", request.generation, request.requestId].joined(separator: "/")
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
    guard self.terminalID == terminalID, canSubmit(request), let target = response?.target else { return }
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
      response = value
    } catch {
      guard epoch == revision, !Task.isCancelled else { return }
      // Unknown delivery is not a retry button. The user's original draft stays available.
      self.error = "提交结果未确认，答案草稿已保留。请回原终端核对，不要重复发送。"
    }
  }
}
