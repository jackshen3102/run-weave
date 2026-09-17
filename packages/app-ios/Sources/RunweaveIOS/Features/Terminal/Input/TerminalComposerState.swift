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
    let commandActive: Bool

    @MainActor init(session: AppSession, controller: SessionController, terminalID: String) {
      draft = session.terminalDrafts[terminalID] ?? ""
      let terminal = session.overview?.sessions.first { $0.id == terminalID }
      let project = session.overview?.projects.first {
        $0.id == HomeOverview.parentProjectID(session.terminal?.projectId ?? "")
      }
      targetLabel = [session.connection?.name, project?.name, terminal?.title ?? terminalID]
        .compactMap { $0 }.joined(separator: " · ")
      canWrite = session.canWrite
      canSend = controller.canSend
      inputBusy = controller.inputBusy
      commandActive = session.isCommandActive(terminalID)
    }
  }

  @Published private(set) var snapshot: Snapshot
  private var subscription: AnyCancellable?

  init(session: AppSession, controller: SessionController, terminalID: String) {
    snapshot = Snapshot(session: session, controller: controller, terminalID: terminalID)
    subscription = Publishers.Merge(session.objectWillChange, controller.objectWillChange)
      // objectWillChange precedes the mutation. Read the completed state on the main queue.
      .receive(on: DispatchQueue.main)
      .sink { [weak self] in
        guard let self else { return }
        let next = Snapshot(session: session, controller: controller, terminalID: terminalID)
        if self.snapshot != next { self.snapshot = next }
      }
  }
}
