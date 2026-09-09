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
  }

  var body: some View {
    Menu {
      Text(cwd)
      Button { showingInfo = true } label: {
        Label("终端信息", systemImage: "info.circle")
      }
      Button("终端历史") { showingHistory = true }
      Button("诊断") { showingDiagnostics = true }
      Button("回到底部") { controller.returnToBottom() }.disabled(!canReturnToBottom)
      Button("重连") { Task { await session.reconnectTerminal() } }.disabled(!canReconnect)
      Button("删除终端", role: .destructive) { deleting = true }.disabled(!canDelete)
    } label: {
      Image(systemName: "ellipsis")
    }.accessibilityLabel("终端操作")
  }
}
