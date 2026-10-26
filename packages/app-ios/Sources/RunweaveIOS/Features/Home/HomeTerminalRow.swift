import SwiftUI
import UIKit

struct HomeTerminalRow: View {
  @ObservedObject var session: AppSession
  let terminal: HomeTerminal
  let projectName: String?
  var branchStatus: HomeBranchStatus? = nil
  let showBranchUpdates: () -> Void
  let rename: () -> Void
  let move: () -> Void
  let delete: () -> Void
  @State private var showingCopied = false
  @State private var forkFailure: String?
  private var pinned: Bool { terminal.pinnedAt != nil }
  private var pinLabel: String { pinned ? "取消置顶" : "置顶" }
  private var hasConversation: Bool { terminal.conversationKey != nil || terminal.terminalState.agent != nil }
  private var previewStatus: String {
    guard session.health.status == .online else { return "离线，预览暂停更新" }
    guard terminal.conversationKey != nil else { return "尚未关联会话记录" }
    guard let preview = terminal.conversationPreview else { return "正在加载对话预览…" }
    switch preview.availability {
    case "source_missing": return "未找到会话记录"
    case "provider_unsupported": return "此 Agent 暂不支持对话预览"
    case "read_failed": return "对话预览加载失败，稍后自动重试"
    case "loading": return "正在加载对话预览…"
    default: return "对话预览暂不可用"
    }
  }

  private func setPinned() {
    Task { try? await session.updateTerminal(terminal.id, change: .pinned(!pinned)) }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button { Task { await session.openTerminal(terminal.id) } } label: {
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
        }.contentShape(Rectangle())
      }.buttonStyle(.plain).frame(minHeight: 44)
      if let projectName {
        HStack(spacing: 5) {
          Text(projectName).font(.caption).foregroundColor(.secondary).lineLimit(1)
          Spacer(minLength: 3)
          if let branchStatus, branchStatus.state != "not-repository" {
            Button(action: showBranchUpdates) {
              HomeBranchStatusLabel(status: branchStatus)
                .font(.caption).frame(minHeight: 44)
            }.buttonStyle(.borderless)
              .accessibilityIdentifier("home-branch-updates-\(terminal.id)")
          }
        }
      }
      Button { Task { await session.openTerminal(terminal.id) } } label: {
        VStack(alignment: .leading, spacing: 4) {
          if hasConversation {
            if let preview = terminal.conversationPreview, preview.available {
              Text("最近输入：\(preview.userText ?? "暂无输入记录")").lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                .font(.caption).foregroundColor(.secondary)
              Text("最近回复：\(preview.agentText ?? "尚无回复")").lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                .font(.caption).foregroundColor(.secondary)
            } else {
              Text(previewStatus).lineLimit(1).font(.caption).foregroundColor(.secondary)
            }
          } else {
            Text(terminal.subtitle).lineLimit(1).font(.caption).foregroundColor(.secondary)
          }
        }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
      }.buttonStyle(.plain)
    }.padding(.vertical, 4)
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
      Button(action: move) { Label("移动到项目", systemImage: "folder") }
        .disabled(!session.canEditTerminal(terminal.id)
          || !(session.overview?.projects.contains { $0.id != terminal.projectId } ?? false))
        .accessibilityIdentifier("terminal-move-project")
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
