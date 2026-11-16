import Combine
import Foundation

/// Projects connection/session changes onto only the values used by this terminal's composer.
@MainActor
final class TerminalComposerState: ObservableObject {
  struct Snapshot: Equatable {
    let draft: String
    let targetLabel: String
    let canWrite: Bool
    let canSend: Bool
    let inputBusy: Bool
    let unconfirmedInput: Bool
    let commandActive: Bool
    let queueKey: TerminalPromptSubmitKey?

    @MainActor init(session: AppSession, controller: SessionController, terminalID: String, record: HomeState.TerminalRecord, draftRecord: TerminalDraftStore.Record) {
      draft = draftRecord.snapshot.text
      let terminal = record.snapshot.terminal
      let project = record.snapshot.project
      targetLabel = [session.connection?.name, project?.name, terminal?.title ?? terminalID]
        .compactMap { $0 }.joined(separator: " · ")
      canWrite = session.canWrite
      canSend = controller.canSend
      inputBusy = controller.inputBusy
      unconfirmedInput = draftRecord.snapshot.unconfirmedInput
      commandActive = terminal?.terminalState.state == "agent_running"
      queueKey = session.composerQueueKey(terminalID: terminalID)
    }
  }

  @Published private(set) var snapshot: Snapshot
  private var subscription: AnyCancellable?

  init(session: AppSession, controller: SessionController, terminalID: String) {
    let record = session.home.record(terminalID)
    let draftRecord = session.drafts.record(terminalID)
    snapshot = Snapshot(session: session, controller: controller, terminalID: terminalID, record: record, draftRecord: draftRecord)
    subscription = Publishers.MergeMany(session.objectWillChange, controller.objectWillChange, record.objectWillChange, draftRecord.objectWillChange)
      // objectWillChange precedes the mutation. Read the completed state on the main queue.
      .receive(on: DispatchQueue.main)
      .sink { [weak self] in
        guard let self else { return }
        let next = Snapshot(session: session, controller: controller, terminalID: terminalID, record: record, draftRecord: draftRecord)
        if self.snapshot != next { self.snapshot = next }
      }
  }
}
