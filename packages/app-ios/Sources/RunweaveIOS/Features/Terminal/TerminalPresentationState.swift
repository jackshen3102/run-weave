import Combine
import Foundation

/// Only facts consumed by terminal chrome, not the entire Home conversation preview.
struct TerminalPresentationSnapshot: Equatable {
  let title: String?
  let alias: String?
  let projectID: String?
  let projectName: String?
  let cwd: String?
  let status: String?
  let state: TerminalState?
  let conversationKey: String?
  let conversationRevision: String?
  let turnID: String?
  let completionRevision: Int?
  let acknowledgedRevision: Int?
  let draft: TerminalDraftStore.Snapshot
  let metadataWriting: Bool
  let acknowledging: Bool
  let bell: Bool

  @MainActor init(record: HomeState.TerminalSnapshot, draft: TerminalDraftStore.Snapshot) {
    let terminal = record.terminal
    title = terminal?.title; alias = terminal?.alias
    projectID = terminal?.projectId; projectName = record.project?.name
    cwd = terminal?.cwd; status = terminal?.status; state = terminal?.terminalState
    conversationKey = terminal?.conversationKey; conversationRevision = terminal?.conversationRevision
    turnID = terminal?.conversationPreview?.turnId
    completionRevision = terminal?.completionRevision
    acknowledgedRevision = terminal?.acknowledgedCompletionRevision
    self.draft = draft
    metadataWriting = record.metadataWriting; acknowledging = record.acknowledging; bell = record.bell
  }
}

@MainActor
func terminalPresentationState(session: AppSession, terminalID: String) -> StateProjection<TerminalPresentationSnapshot> {
  let record = session.home.record(terminalID)
  let draft = session.drafts.record(terminalID)
  return StateProjection(changes: Publishers.Merge(record.objectWillChange, draft.objectWillChange).eraseToAnyPublisher()) {
    TerminalPresentationSnapshot(record: record.snapshot, draft: draft.snapshot)
  }
}
