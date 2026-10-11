import SwiftUI

/// Only menu inputs invalidate the native menu, never output counters or unrelated sessions.
struct TerminalActionsMenu: View, Equatable {
  let session: AppSession
  let controller: SessionController
  let terminalID: String
  let cwd: String
  let canReturnToBottom: Bool
  let canReconnect: Bool
  let canDelete: Bool
  let canShare: Bool
  let sharing: Bool
  let share: () -> Void
  let supervisionEnabled: Bool
  let canFork: Bool
  @Binding var showingSupervision: Bool
  @Binding var deleting: Bool
  @Binding var showingHistory: Bool
  @Binding var showingInfo: Bool
  @Binding var showingDiagnostics: Bool

  static func == (lhs: Self, rhs: Self) -> Bool {
    // Bindings target the same TerminalScreen state for this controller and terminal identity.
    lhs.session === rhs.session && lhs.controller === rhs.controller
      && lhs.terminalID == rhs.terminalID && lhs.cwd == rhs.cwd
      && lhs.canReturnToBottom == rhs.canReturnToBottom
      && lhs.canReconnect == rhs.canReconnect && lhs.canDelete == rhs.canDelete
      && lhs.canShare == rhs.canShare && lhs.sharing == rhs.sharing
      && lhs.supervisionEnabled == rhs.supervisionEnabled
      && lhs.canFork == rhs.canFork
  }

  var body: some View {
    Menu {
      Text(cwd)
      Button {
        Task {
          do { try await session.forkTerminal(terminalID) }
          catch { if !(error is CancellationError) { session.error = displayError(error) } }
        }
      } label: { Label("Fork Thread", systemImage: "arrow.triangle.branch") }
        .disabled(!canFork).accessibilityIdentifier("terminal-menu-fork-codex")
      Button { showingSupervision = true } label: {
        Label(supervisionEnabled ? "长任务监控 · 已开启" : "长任务监控", systemImage: "eye")
      }.accessibilityIdentifier("terminal-menu-task-supervision")
      Button { showingInfo = true } label: {
        Label("终端信息", systemImage: "info.circle")
      }
      Button("终端历史") { showingHistory = true }
      Button(action: share) {
        Label(sharing ? "正在创建快照…" : "分享终端快照", systemImage: "square.and.arrow.up")
      }.disabled(!canShare || sharing)
        .accessibilityIdentifier("terminal-share-snapshot")
      Button("诊断") { showingDiagnostics = true }
      Button("回到底部") { controller.returnToBottom() }.disabled(!canReturnToBottom)
      Button("重连") { Task { await session.reconnectTerminal() } }.disabled(!canReconnect)
      Button("删除终端", role: .destructive) { deleting = true }.disabled(!canDelete)
    } label: {
      Image(systemName: "ellipsis")
    }.accessibilityLabel("终端操作")
  }
}
