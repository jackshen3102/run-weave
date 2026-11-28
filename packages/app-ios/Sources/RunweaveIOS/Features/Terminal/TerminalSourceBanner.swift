import SwiftUI

struct TerminalSourceBanner: View {
  @ObservedObject var session: AppSession
  let source: TerminalSessionSource
  let sourceIsParent: Bool
  let scheduledSourceName: String?
  let dismiss: DismissAction

  var body: some View {
    switch source {
    case .scheduledTask(let scheduled):
      Button {
        // Pop the nested destination before disposing its terminal controller.
        // Home owns an in-place destination replacement and must not pop.
        if sourceIsParent { dismiss() }
        session.openScheduledSource(scheduled)
      } label: {
        Label("来源：\(scheduledSourceName ?? "定时任务")", systemImage: "calendar.badge.clock")
          .font(.caption).lineLimit(1)
      }.padding(.vertical, 5).accessibilityIdentifier("scheduled-task-source")
    case .terminal(let origin):
      if let originTerminal = session.home.terminal(origin.terminalSessionId) {
        Button {
          Task { await session.openTerminal(origin.terminalSessionId) }
        } label: {
          Label("来源：\(originTerminal.title)", systemImage: "arrow.uturn.backward.circle")
            .font(.caption).lineLimit(1)
        }.padding(.vertical, 5).accessibilityIdentifier("terminal-source")
      } else if session.overview != nil {
        Label("来源：原终端已关闭", systemImage: "arrow.uturn.backward.circle")
          .font(.caption).foregroundStyle(.secondary).lineLimit(1)
          .padding(.vertical, 5).accessibilityIdentifier("terminal-source-closed")
      } else {
        Button {
          Task { await session.openTerminal(origin.terminalSessionId) }
        } label: {
          Label("来源：原终端", systemImage: "arrow.uturn.backward.circle")
            .font(.caption).lineLimit(1)
        }.padding(.vertical, 5).accessibilityIdentifier("terminal-source")
      }
    case .unknown:
      EmptyView()
    }
  }
}
