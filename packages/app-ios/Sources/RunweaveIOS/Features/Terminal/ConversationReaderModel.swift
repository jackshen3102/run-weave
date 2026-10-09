import SwiftUI

@MainActor final class ConversationReaderModel: ObservableObject {
  @Published private(set) var data: TerminalConversation?
  @Published private(set) var loading = false
  @Published private(set) var failure: String?
  @Published private(set) var unchanged = false
  private weak var session: AppSession?
  private weak var controller: SessionController?
  private let terminalID: String
  private let generation: Int
  private let connectionID: String?
  var readingPositionKey: String? {
    guard let connectionID, let target = data?.target,
      let encoded = try? JSONEncoder().encode([connectionID, target.provider, target.threadId]) else { return nil }
    return String(data: encoded, encoding: .utf8)
  }
  private var sequence = 0
  private var operation: Task<Void, Never>?
  private var started = false
  private var boundTarget: TerminalConversation.Target?

  init(session: AppSession, controller: SessionController, terminalID: String) {
    self.session = session; self.controller = controller
    self.terminalID = terminalID; generation = session.generation
    connectionID = session.connection?.id
  }
  private var current: Bool {
    guard let session, let controller else { return false }
    return session.generation == generation && session.terminal?.id == terminalID
      && session.terminalController === controller
  }
  func open() { guard !started else { return }; started = true; refresh() }
  func refresh() {
    guard current, !loading, let session else { return }
    sequence += 1
    let ticket = sequence
    let previous = data
    let target = boundTarget
    loading = true; failure = nil; unchanged = false
    operation = Task { [weak self] in
      do {
        let response = try await session.withConnection(reportFailure: false) { api in
          try await api.terminalConversation(id: self?.terminalID ?? "",
            panelID: target?.panelId, expectedThreadID: target?.threadId)
        }
        try Task.checkCancellation()
        guard let self, self.current, self.sequence == ticket else { return }
        if let previousTarget = self.boundTarget, previousTarget != response.target {
          self.data = nil; self.failure = "会话已变化，请关闭后重新打开阅读页"
        } else {
          self.unchanged = previous?.turns == response.turns && previous?.availability == response.availability
          self.boundTarget = self.boundTarget ?? response.target
          self.data = response
        }
      } catch {
        guard let self, !(error is CancellationError), self.current, self.sequence == ticket else { return }
        if (error as? TerminalConversationFailure)?.code == "CONVERSATION_TARGET_CHANGED" { self.data = nil }
        self.failure = displayError(error)
      }
      guard let self, self.sequence == ticket else { return }
      self.loading = false; self.operation = nil
    }
  }
  func cancel() {
    sequence += 1; operation?.cancel(); operation = nil
    loading = false; data = nil
  }
}
