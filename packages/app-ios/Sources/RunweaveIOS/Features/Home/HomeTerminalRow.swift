import SwiftUI

struct HomeTerminalRow: View {
  @ObservedObject var session: AppSession
  let terminal: HomeTerminal
  let projectName: String?
  let rename: () -> Void
  let delete: () -> Void
  private var pinned: Bool { terminal.pinnedAt != nil }
  private var pinLabel: String { pinned ? "取消置顶" : "置顶" }

  private func setPinned() {
    Task { try? await session.updateTerminal(terminal.id, change: .pinned(!pinned)) }
  }

  var body: some View {
    Button {
      Task { await session.openTerminal(terminal.id) }
    } label: {
      VStack(alignment: .leading, spacing: 5) {
        HStack {
          Text(terminal.title).font(.headline).foregroundColor(.primary).lineLimit(1)
          TerminalAttentionBadge(
            unread: terminal.hasUnreadCompletion, bell: session.bellMarkers.contains(terminal.id),
            showLabel: false)
          if pinned {
            Image(systemName: "pin.fill").font(.caption).foregroundColor(.secondary)
              .accessibilityLabel("已置顶")
          }
          Spacer()
          if session.metadataWrites.contains(terminal.id) { ProgressView() }
          TerminalStatusBadge(terminal: terminal)
        }
        if let projectName { Text(projectName).font(.caption).foregroundColor(.secondary) }
        HStack {
          Text(terminal.subtitle).lineLimit(2)
          Spacer()
          Text(terminal.relativeTime)
        }.font(.caption).foregroundColor(.secondary)
      }.padding(.vertical, 4)
    }
    .swipeActions(edge: .leading, allowsFullSwipe: false) {
      Button(action: setPinned) { Label(pinLabel, systemImage: pinned ? "pin.slash" : "pin") }
        .tint(.orange).disabled(!session.canEditTerminal(terminal.id))
    }
    .contextMenu {
      if terminal.hasUnreadCompletion {
        Button("标记已读") { Task { await session.acknowledgeTerminal(terminal.id) } }
          .disabled(!session.canWrite || session.acknowledgementWrites.contains(terminal.id))
      }
      Button(action: setPinned) { Label(pinLabel, systemImage: pinned ? "pin.slash" : "pin") }
        .disabled(!session.canEditTerminal(terminal.id))
      Button("重命名", action: rename).disabled(!session.canEditTerminal(terminal.id))
      Button("删除终端", role: .destructive, action: delete)
        .disabled(!session.canEditTerminal(terminal.id))
    }
  }
}
