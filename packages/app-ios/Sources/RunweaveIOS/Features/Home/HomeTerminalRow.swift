import SwiftUI
import UIKit

struct HomeTerminalRow: View {
  @ObservedObject var session: AppSession
  let terminal: HomeTerminal
  let projectName: String?
  var branchStatus: HomeBranchStatus? = nil
  let rename: () -> Void
  let delete: () -> Void
  @State private var showingCopied = false
  @State private var forkFailure: String?
  private var pinned: Bool { terminal.pinnedAt != nil }
  private var pinLabel: String { pinned ? "取消置顶" : "置顶" }
  private var hasConversation: Bool { terminal.conversationKey != nil || terminal.terminalState.agent != nil }
  private var userPreview: String {
    guard let preview = terminal.conversationPreview, preview.available else { return "输入暂不可用" }
    return preview.userText ?? "本轮暂无输入"
  }
  private var agentPreview: String {
    guard let preview = terminal.conversationPreview, preview.available else { return "回复暂不可用" }
    return preview.agentText ?? "本轮暂无回复"
  }

  private func setPinned() {
    Task { try? await session.updateTerminal(terminal.id, change: .pinned(!pinned)) }
  }

  var body: some View {
    Button {
      Task { await session.openTerminal(terminal.id) }
    } label: {
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(terminal.title).font(.headline).foregroundColor(.primary).lineLimit(1)
            .layoutPriority(1)
          TerminalAttentionBadge(
            unread: terminal.hasUnreadCompletion, bell: session.bellMarkers.contains(terminal.id),
            showLabel: false)
          if pinned {
            Image(systemName: "pin.fill").font(.caption).foregroundColor(.secondary)
              .accessibilityLabel("已置顶")
          }
          Spacer()
          if session.metadataWrites.contains(terminal.id) { ProgressView() }
          TerminalStatusBadge(terminal: terminal).fixedSize()
        }
        if let projectName {
          HStack(spacing: 5) {
            Text(projectName).lineLimit(1).truncationMode(.middle)
            if let branchStatus, branchStatus.state != "not-repository" {
              Text("·")
              HomeBranchStatusLabel(status: branchStatus)
                .frame(maxWidth: 160, alignment: .leading)
                .fixedSize(horizontal: true, vertical: false).layoutPriority(1)
            }
          }.font(.caption).foregroundColor(.secondary).lineLimit(1)
        }
        if hasConversation {
          Text("你：\(userPreview)").lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            .font(.caption).foregroundColor(.secondary)
          Text("Agent：\(agentPreview)").lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            .font(.caption).foregroundColor(.secondary)
        } else {
          Text(terminal.subtitle).lineLimit(1).font(.caption).foregroundColor(.secondary)
        }
      }.padding(.vertical, 4)
    }
    .swipeActions(edge: .leading, allowsFullSwipe: false) {
      Button(action: setPinned) { Label(pinLabel, systemImage: pinned ? "pin.slash" : "pin") }
        .tint(.orange).disabled(!session.canEditTerminal(terminal.id))
    }
    .contextMenu {
      Button {
        Task {
          do { try await session.forkTerminal(terminal.id) }
          catch { if !(error is CancellationError) { forkFailure = displayError(error) } }
        }
      } label: { Label("Fork Thread", systemImage: "arrow.triangle.branch") }
        .disabled(!session.canEditTerminal(terminal.id) || terminal.status != "running"
          || terminal.terminalState.agent != "codex" || terminal.terminalState.state != "agent_idle")
        .accessibilityIdentifier("terminal-fork-codex")
      Button {
        UIPasteboard.general.string = terminal.id
        showingCopied = true
      } label: {
        Label("复制终端 ID", systemImage: "doc.on.doc")
      }
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
    .alert("已复制终端 ID", isPresented: $showingCopied) {
      Button("好", role: .cancel) {}
    } message: {
      Text(terminal.id)
    }
    .alert("Fork 未确认", isPresented: Binding(get: { forkFailure != nil }, set: { if !$0 { forkFailure = nil } })) {
      Button("好", role: .cancel) { forkFailure = nil }
    } message: { Text(forkFailure ?? "") }
  }
}
