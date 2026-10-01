enum HomeOverviewEventPatcher {
  static func preserveConversationPreviews(from previous: HomeOverview?, into value: inout HomeOverview) {
    for index in value.sessions.indices {
      let item = value.sessions[index]
      if let old = previous?.sessions.first(where: { $0.id == item.id }),
        item.conversationKey != nil, old.conversationKey == item.conversationKey,
        !(old.terminalState.state != "agent_running" && item.terminalState.state == "agent_running") {
        value.sessions[index].conversationPreview = old.conversationPreview
      }
    }
  }

  static func patchConversationPreviews(_ response: HomeConversationPreviewsResponse, into value: inout HomeOverview) {
    for item in response.sessions {
      guard let index = value.sessions.firstIndex(where: { $0.id == item.terminalSessionId }),
        value.sessions[index].conversationKey == item.conversationKey else { continue }
      value.sessions[index].conversationPreview = item.conversationPreview
    }
  }

  static func patch(_ batch: [TerminalEvent], into overview: inout HomeOverview) {
    for event in batch {
      guard let id = event.terminalSessionId,
        let index = overview.sessions.firstIndex(where: { $0.id == id })
      else { continue }
      if event.kind == "completion", let revision = event.payload.completionRevision {
        overview.sessions[index].completionRevision = max(
          overview.sessions[index].completionRevision ?? 0, revision)
        continue
      }
      guard let next = event.payload.next else { continue }
      if event.kind == "terminal_state_changed", let state = next.state {
        if state == "agent_running", overview.sessions[index].terminalState.state != "agent_running" {
          overview.sessions[index].conversationPreview = nil
        }
        overview.sessions[index].terminalState = TerminalState(state: state, agent: next.agent)
        let exited = overview.sessions[index].status == "exited"
        let labels = [
          "agent_running": ("running", "Agent Running"),
          "agent_starting": ("agent-starting", "Agent Starting"),
          "agent_idle": ("agent-idle", "Agent Idle"),
        ]
        let pair = exited ? ("exited", "Exited") : (labels[state] ?? ("idle", "Idle"))
        overview.sessions[index].displayStatus = pair.0
        overview.sessions[index].displayStatusLabel = pair.1
      } else if event.kind == "terminal_session_metadata_changed", let cwd = next.cwd {
        if overview.sessions[index].subtitle == event.payload.previous?.cwd {
          overview.sessions[index].subtitle = cwd
        }
        overview.sessions[index].cwd = cwd
        overview.sessions[index].activeCommand = next.activeCommand
      }
    }
  }
}
