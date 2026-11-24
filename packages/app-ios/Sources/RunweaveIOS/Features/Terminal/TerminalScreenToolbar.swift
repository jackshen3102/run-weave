import RunweaveBrowser
import SwiftUI

extension TerminalScreen {
  @ToolbarContentBuilder var terminalToolbar: some ToolbarContent {
    ToolbarItem(placement: .principal) {
      TerminalTitleView(title: title, projectName: projectName,
        connectionName: session.connection?.name ?? "电脑", status: status,
        programStatus: currentTerminal?.programStatus?.label)
    }
    ToolbarItemGroup(placement: .navigationBarTrailing) {
      Button { tab = "Files" } label: { Image(systemName: "folder") }
        .accessibilityLabel("终端文件").accessibilityIdentifier("terminal-files-open")
      if let title = browser.pageTitle {
        Button {
          guard let source = session.browserSource,
            browser.hostPresentationAvailable(source: source, registrationID: browserPresentationID) else { return }
          browser.resume()
        } label: { Image(systemName: "globe") }
        .accessibilityLabel("恢复网页：\(title)")
        .accessibilityIdentifier("terminal-browser-resume")
        .disabled(browser.clearing)
      }
      if (presentation.value.completionRevision ?? 0) > (presentation.value.acknowledgedRevision ?? 0) {
        Button {
          Task { await session.acknowledgeTerminal(details.id) }
        } label: {
          TerminalAttentionBadge(unread: true, bell: false, showLabel: false)
            .padding(8)
        }
        .accessibilityLabel("有新的接管提醒，标记已读")
        .disabled(!session.canWrite || presentation.value.acknowledging)
      }
      TerminalActionsMenu(
        session: session, controller: controller, terminalID: details.id,
        cwd: cwd, canReturnToBottom: session.canWrite && controller.canSend,
        canReconnect: session.canReconnect, canDelete: session.canWrite,
        canShare: session.canWrite, sharing: sharing, share: shareSnapshot,
        canReview: codeReview.canStart, reviewAgain: codeReview.latest?.caseStatus == "open" && codeReview.latest?.reportId != nil, review: codeReview.start,
        hasReview: codeReview.latest != nil, showingReview: $codeReview.showingReport,
        canReply: currentTerminal?.terminalState.agent == "codex", reply: openReplyAssistant,
        openDesktop: { remoteDesktop.requestOpen(backendConnectionID: session.connection?.id) },
        supervisionEnabled: supervision.watch?.enabled == true,
        canFork: session.canWrite && currentTerminal?.terminalState.agent == "codex"
          && currentTerminal?.terminalState.state == "agent_idle",
        showingBranchUpdates: $showingBranchUpdates, showingSupervision: $showingSupervision,
        deleting: $deleting, showingHistory: $showingHistory,
        showingInfo: $showingInfo, showingDiagnostics: $showingDiagnostics
      ).equatable()
    }
  }
}
