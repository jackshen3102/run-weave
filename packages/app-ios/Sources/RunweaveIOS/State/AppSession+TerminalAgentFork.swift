import Foundation

extension AppSession {
  func forkTerminal(_ id: String) async throws {
    guard canEditTerminal(id), let api else { throw APIError.offline }
    let epoch = generation
    let openedTerminalID = terminal?.id
    writing = true
    defer { if epoch == generation { writing = false } }
    var createdID: String?
    var failure: Error?
    do {
      let target = try await api.terminalAgentForkTarget(id: id)
      guard generation == epoch, foreground, !Task.isCancelled else { throw CancellationError() }
      let result = try await api.forkTerminalAgent(id: id, target: target, operationID: UUID().uuidString)
      guard result.sourceThreadId == target.threadId, result.threadId != target.threadId else {
        throw APIError.invalidResponse
      }
      createdID = result.terminalSessionId
    } catch {
      if let value = error as? TerminalAgentForkFailure {
        createdID = value.details?.terminalSessionId
        failure = error
      } else if error is CancellationError { throw error }
      else { failure = TerminalAgentForkFailure(message: "Fork 结果未确认，请核对终端列表；不会自动重试。", details: nil) }
    }
    guard generation == epoch, foreground, !Task.isCancelled else { throw CancellationError() }
    await reload()
    guard generation == epoch, foreground, !Task.isCancelled else { throw CancellationError() }
    if let createdID, terminal?.id == openedTerminalID { await openTerminal(createdID) }
    if let failure { error = displayError(failure); throw failure }
  }
}
