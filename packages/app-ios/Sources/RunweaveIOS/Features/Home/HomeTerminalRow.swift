import Combine
import SwiftUI
import UIKit

private struct HomeBranchBadgeBounds: PreferenceKey {
  static var defaultValue: Anchor<CGRect>? { nil }
  static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
    value = nextValue() ?? value
  }
}

struct HomeTerminalRow: View, Equatable {
  @ObservedObject var session: AppSession
  private let initialTerminal: HomeTerminal
  private let record: HomeState.TerminalRecord
  private let connectionScope: String?
  @StateObject private var state: StateProjection<HomeState.TerminalSnapshot>
  let projectName: String?
  let inAttentionSection: Bool
  let attentionSlot: AttentionSlot?
  var branchStatus: HomeBranchStatus? = nil
  let showBranchUpdates: () -> Void
  let rename: () -> Void
  let move: () -> Void
  let delete: () -> Void
  @State private var handoff = false
  @State private var showingCopied = false
  @State private var forkFailure: String?
  private var terminal: HomeTerminal { state.value.terminal ?? initialTerminal }

  init(session: AppSession, terminal: HomeTerminal, projectName: String?, inAttentionSection: Bool = false, attentionSlot: AttentionSlot? = nil,
    branchStatus: HomeBranchStatus? = nil,
    showBranchUpdates: @escaping () -> Void, rename: @escaping () -> Void,
    move: @escaping () -> Void, delete: @escaping () -> Void) {
    self.session = session; initialTerminal = terminal; self.projectName = projectName
    self.inAttentionSection = inAttentionSection
    self.attentionSlot = attentionSlot
    self.branchStatus = branchStatus; self.showBranchUpdates = showBranchUpdates
    self.rename = rename; self.move = move; self.delete = delete
    connectionScope = session.connection?.scope
    let record = session.home.record(terminal.id)
    self.record = record
    _state = StateObject(wrappedValue: StateProjection(
      changes: Publishers.Merge(record.objectWillChange, session.objectWillChange).eraseToAnyPublisher(),
      isVisible: {
        session.authenticated && session.foreground && session.terminal == nil
          && !session.showingScheduledTasks && !session.showingEnergyMonitor && !session.showingDevelopmentResources
      }) {
      record.snapshot
    })
  }

  static func == (lhs: Self, rhs: Self) -> Bool {
    // HomeView's actions target this stable record and its State bindings; they
    // read the latest terminal on invocation instead of capturing a row snapshot.
    lhs.session === rhs.session && lhs.record === rhs.record
      && lhs.projectName == rhs.projectName && lhs.inAttentionSection == rhs.inAttentionSection
      && lhs.branchStatus == rhs.branchStatus
      && lhs.attentionSlot == rhs.attentionSlot
      && lhs.connectionScope == rhs.connectionScope
  }
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
    Task {
      guard session.connection?.scope == connectionScope, let current = record.snapshot.terminal else { return }
      try? await session.updateTerminal(current.id, change: .pinned(current.pinnedAt == nil))
    }
  }

  var body: some View {
    ZStack {
      Button {
        Task {
          guard session.connection?.scope == connectionScope, let current = record.snapshot.terminal else { return }
          if let attentionSlot { await session.openAttentionSlot(attentionSlot) }
          else { await session.openTerminal(current.id) }
        }
      } label: {
        VStack(alignment: .leading, spacing: 4) {
          HStack {
            Text(terminal.title).font(.headline).foregroundColor(.primary).lineLimit(1)
              .layoutPriority(1)
            TerminalAttentionBadge(
              unread: terminal.hasUnreadCompletion, bell: state.value.bell,
              showLabel: false)
            if let actionLabel = attentionSlot?.actionLabel {
              Text(actionLabel).font(.caption2).fontWeight(.semibold)
                .foregroundColor(.orange)
                .accessibilityIdentifier(
                  inAttentionSection
                    ? "home-attention-\(attentionSlot?.actionKind ?? "pending")-\(terminal.id)"
                    : "home-project-attention-\(attentionSlot?.actionKind ?? "pending")-\(terminal.id)"
                )
            }
            if pinned {
              Image(systemName: "pin.fill").font(.caption).foregroundColor(.secondary)
                .accessibilityLabel("已置顶")
            }
            Spacer()
            if state.value.metadataWriting { ProgressView() }
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
                  .hidden()
                  .anchorPreference(key: HomeBranchBadgeBounds.self, value: .bounds) { $0 }
              }
            }.font(.caption).foregroundColor(.secondary).lineLimit(1)
          }
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
        }.padding(.vertical, 4).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
    }
    .overlayPreferenceValue(HomeBranchBadgeBounds.self) { anchor in
      GeometryReader { geometry in
        if let anchor, let branchStatus {
          let bounds = geometry[anchor]
          // Keep the original text layout; the independent hit area does not size the row.
          Button(action: showBranchUpdates) {
            HomeBranchStatusLabel(status: branchStatus).font(.caption)
              .frame(width: max(44, bounds.width), height: max(44, bounds.height))
              .contentShape(Rectangle())
          }.buttonStyle(.borderless)
            .position(x: bounds.midX, y: bounds.midY)
            .accessibilityIdentifier("home-branch-updates-\(terminal.id)")
        }
      }
    }
    .swipeActions(edge: .leading, allowsFullSwipe: false) {
      Button(action: setPinned) { Label(pinLabel, systemImage: pinned ? "pin.slash" : "pin") }
        .tint(.orange).disabled(!session.canEditTerminal(terminal.id))
    }
    .contextMenu {
      Button { handoff = true } label: { Label("换 Agent / 交接…", systemImage: "arrow.left.arrow.right") }
        .disabled(!session.canEditTerminal(terminal.id))
      Button {
        Task {
          guard session.connection?.scope == connectionScope, let current = record.snapshot.terminal else { return }
          do { try await session.forkTerminal(current.id) }
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
        Button("标记已读") {
          Task {
            guard session.connection?.scope == connectionScope, let current = record.snapshot.terminal else { return }
            await session.acknowledgeTerminal(current.id)
          }
        }
          .disabled(!session.canWrite || session.acknowledgementWrites.contains(terminal.id))
      }
      Button(action: setPinned) { Label(pinLabel, systemImage: pinned ? "pin.slash" : "pin") }
        .disabled(!session.canEditTerminal(terminal.id))
      Button("重命名", action: rename).disabled(!session.canEditTerminal(terminal.id))
      Button(action: move) { Label("移动到项目", systemImage: "folder") }
        .disabled(!session.canEditTerminal(terminal.id)
          || !state.value.canMove)
        .accessibilityIdentifier("terminal-move-project")
      Button("删除终端", role: .destructive, action: delete)
        .disabled(!session.canEditTerminal(terminal.id))
    }
    .sheet(isPresented: $handoff) { ContextHandoffSheet(session: session, terminalID: terminal.id) }
    .alert("已复制终端 ID", isPresented: $showingCopied) {
      Button("好", role: .cancel) {}
    } message: {
      Text(terminal.id)
    }
    .alert("Fork 未确认", isPresented: Binding(get: { forkFailure != nil }, set: { if !$0 { forkFailure = nil } })) {
      Button("好", role: .cancel) { forkFailure = nil }
    } message: { Text(forkFailure ?? "") }
    .onAppear { state.setActive(true) }
    .onDisappear { state.setActive(false) }
    .disabled(session.connection?.scope != connectionScope || state.value.terminal == nil)
  }
}
