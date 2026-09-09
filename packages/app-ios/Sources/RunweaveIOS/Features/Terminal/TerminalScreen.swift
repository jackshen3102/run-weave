import SwiftUI

struct TerminalScreen: View {
  @ObservedObject var session: AppSession
  @ObservedObject var controller: SessionController
  let details: TerminalDetails
  @State private var deleting = false
  @State private var showingHistory = false
  @State private var showingInfo = false
  @State private var showingDiagnostics = false
  @State private var showingComposer = false
  @State private var composerPreventsDismissal = false
  @State private var stoppingCommand = false
  @State private var actionFailure: String?
  @State private var tab = "Chat"
  @State private var requestedChange: SelectedFile?
  @StateObject private var changes: ProjectChangesModel
  @ObservedObject private var imageDrafts: TerminalImageDrafts
  @AppStorage("native.theme") private var theme = "dark"

  init(session: AppSession, controller: SessionController, details: TerminalDetails) {
    self.session = session
    self.controller = controller
    self.details = details
    _changes = StateObject(wrappedValue: ProjectChangesModel(session: session, terminal: details))
    self.imageDrafts = session.imageDrafts
  }

  private var canReadChanges: Bool {
    session.foreground && session.authenticated && session.health.status == .online
  }

  private var currentTerminal: HomeTerminal? {
    session.overview?.sessions.first { $0.id == details.id }
  }
  private var title: String {
    if let currentTerminal { return currentTerminal.title }
    if let alias = details.alias, !alias.isEmpty { return alias }
    let command: String?
    if let metadata = controller.metadata {
      command = metadata.activeCommand
    } else {
      command = details.activeCommand
    }
    return command ?? (details.command as NSString).lastPathComponent
  }
  private var cwd: String { controller.metadata?.cwd ?? currentTerminal?.cwd ?? details.cwd }
  private var status: String {
    if session.health.status == .offline { return "电脑离线" }
    if controller.runtimeStatus == "exited" { return "已退出" }
    return controller.connectionStatus
  }

  private var projectName: String {
    session.overview?.projects.first {
      $0.id == HomeOverview.parentProjectID(details.projectId)
    }?.name ?? (cwd as NSString).lastPathComponent
  }

  var body: some View {
    VStack(spacing: 0) {
      if let error = session.error {
        Text(error).font(.caption).foregroundColor(.red).padding(.horizontal)
      }
      tabs
      ZStack {
        chat.opacity(tab == "Chat" ? 1 : 0).allowsHitTesting(tab == "Chat").accessibilityHidden(
          tab != "Chat")
        ChangesView(
          session: session, projectID: details.projectId, active: tab == "Changes",
          requested: $requestedChange, model: changes
        )
        .opacity(tab == "Changes" ? 1 : 0).allowsHitTesting(tab == "Changes").accessibilityHidden(
          tab != "Changes")
        FilesView(session: session, projectID: details.projectId, active: tab == "Files", model: changes) {
          change in
          requestedChange = change
          tab = "Changes"
        }.opacity(tab == "Files" ? 1 : 0).allowsHitTesting(tab == "Files").accessibilityHidden(
          tab != "Files")
      }
    }
    .background(TerminalAppearance.background.ignoresSafeArea())
    .tint(TerminalAppearance.accent)
    .modifier(TerminalNavigationBackground())
    .onAppear { controller.surface.applyTheme(dark: theme != "light") }
    .onChange(of: theme) { controller.surface.applyTheme(dark: $0 != "light") }
    .task(id: canReadChanges) {
      if canReadChanges { await changes.refresh() }
      else { changes.cancel() }
    }
    .onChange(of: controller.connectionStatus) { status in
      if status == "已连接" { Task { await changes.refresh() } }
    }
    .onDisappear { changes.cancel() }
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { terminalToolbar }
    .sheet(isPresented: $showingHistory) { HistoryView(session: session, terminalID: details.id) }
    .sheet(isPresented: $showingInfo) { TerminalInfoView(terminalID: details.id) }
    .sheet(isPresented: $showingDiagnostics) { DiagnosticsView(session: session) }
    .sheet(isPresented: $showingComposer) {
      TerminalComposerSheet(
        session: session, controller: controller, terminalID: details.id,
        preventsDismissal: $composerPreventsDismissal)
    }
    .confirmationDialog("删除终端？", isPresented: $deleting, titleVisibility: .visible) {
      Button("删除", role: .destructive) { Task { await session.deleteTerminal(details.id) } }
      Button("取消", role: .cancel) {}
    } message: {
      Text("删除后将结束该远端终端会话。")
    }
  }

  private var tabs: some View {
    HStack(spacing: 24) {
      ForEach(["Chat", "Changes", "Files"], id: \.self) { value in tabButton(value) }
      Spacer(minLength: 0)
    }
    .buttonStyle(.plain).padding(.horizontal, 16)
    .overlay(alignment: .bottom) {
      Rectangle().fill(TerminalAppearance.border).frame(height: 0.5)
    }
  }

  private func tabButton(_ value: String) -> some View {
    Button {
      controller.surface.view.window?.endEditing(true)
      tab = value
    } label: {
      HStack(spacing: 5) {
        Text(value == "Chat" ? "终端" : value == "Changes" ? "变更" : "文件")
        if value == "Changes" {
          Text(changes.count.map(String.init) ?? "0").font(.caption2)
            .padding(.horizontal, 5).padding(.vertical, 2)
            .background(TerminalAppearance.panel).cornerRadius(5)
            .opacity(changes.count == nil ? 0 : 1)
            .accessibilityHidden(changes.count == nil)
            .accessibilityIdentifier("terminal-changes-count")
        }
      }
      .font(.subheadline.weight(tab == value ? .semibold : .regular))
      .foregroundColor(tab == value ? Color.primary : Color.secondary)
      .frame(minHeight: 44)
      .overlay(alignment: .bottom) {
        if tab == value { Rectangle().fill(TerminalAppearance.accent).frame(height: 2) }
      }
    }
    .accessibilityAddTraits(tab == value ? .isSelected : [])
  }

  private var chat: some View {
    VStack(spacing: 0) {
      if session.health.status == .offline { Text("本地电脑暂时不可用").foregroundColor(.orange) }
      if let failure = controller.failure { Text(failure).font(.caption).foregroundColor(.red) }
      if let actionFailure { Text(actionFailure).font(.caption).foregroundColor(.red) }
      if let notice = controller.notice { Text(notice).font(.caption).foregroundColor(.orange) }
      TerminalHostView(surface: controller.surface).frame(minHeight: 24)
        .padding(.horizontal, 12).padding(.top, 10)
        .overlay(alignment: .bottomTrailing) {
          floatingControls.padding(12)
        }
    }
  }

  private var hasComposerDraft: Bool {
    let text = session.terminalDrafts[details.id] ?? ""
    return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || !(imageDrafts.images[details.id] ?? []).isEmpty
  }

  private var floatingControls: some View {
    VStack(alignment: .trailing, spacing: 8) {
      if controller.scrolledBack {
        Button("回到底部") { controller.returnToBottom() }
          .font(.caption).padding(8).background(.regularMaterial).cornerRadius(12)
          .disabled(!session.canWrite || !controller.canSend)
      }
      if session.isCommandActive(details.id) {
        Button(action: stopActiveCommand) {
          Group {
            if stoppingCommand { ProgressView().tint(.white) }
            else { Image(systemName: "stop.fill") }
          }
          .frame(width: 48, height: 48)
          .foregroundColor(.white)
          .background(Color.red)
          .clipShape(Circle())
          .shadow(radius: 4, y: 2)
        }
        .accessibilityLabel(stoppingCommand ? "停止中…" : "停止执行")
        .accessibilityIdentifier("terminal-floating-stop")
        .disabled(stoppingCommand || !session.canWrite)
      }
      Button {
        actionFailure = nil
        composerPreventsDismissal = false
        showingComposer = true
      } label: {
        Image(systemName: "square.and.pencil")
          .font(.system(size: 20, weight: .semibold))
          .frame(width: 52, height: 52)
          .foregroundColor(TerminalAppearance.background)
          .background(TerminalAppearance.accent)
          .clipShape(Circle())
          .shadow(radius: 4, y: 2)
          .overlay(alignment: .topTrailing) {
            if hasComposerDraft {
              Circle().fill(Color.orange).frame(width: 11, height: 11)
                .overlay(Circle().stroke(TerminalAppearance.background, lineWidth: 2))
            }
          }
      }
      .accessibilityLabel("打开终端输入")
      .accessibilityValue(hasComposerDraft ? "有未发送草稿" : "无草稿")
      .accessibilityIdentifier("terminal-composer-open")
    }
  }

  private func stopActiveCommand() {
    actionFailure = nil
    stoppingCommand = true
    session.recordUserAction("composer.stop", terminalID: details.id)
    Task {
      defer { stoppingCommand = false }
      do {
        try await session.stopCommand(details.id)
      } catch {
        if !(error is CancellationError) { actionFailure = displayError(error) }
      }
    }
  }

  @ToolbarContentBuilder private var terminalToolbar: some ToolbarContent {
    ToolbarItem(placement: .principal) {
      VStack(alignment: .leading, spacing: 3) {
        (Text(title).fontWeight(.semibold) + Text(" / \(projectName)").foregroundColor(.secondary))
          .font(.subheadline).lineLimit(1)
        HStack(spacing: 4) {
          Circle().fill(status == "已连接" ? TerminalAppearance.accent : .orange)
            .frame(width: 5, height: 5)
          Text("\(session.connection?.name ?? "电脑") · \(status)")
            .font(.caption2).foregroundColor(.secondary).lineLimit(1)
        }
      }
      .accessibilityElement(children: .combine)
    }
    ToolbarItemGroup(placement: .navigationBarTrailing) {
      if currentTerminal?.hasUnreadCompletion == true {
        Button {
          Task { await session.acknowledgeTerminal(details.id) }
        } label: {
          TerminalAttentionBadge(unread: true, bell: false, showLabel: false)
            .padding(8)
        }
        .accessibilityLabel("有新的接管提醒，标记已读")
        .disabled(!session.canWrite || session.acknowledgementWrites.contains(details.id))
      }
      TerminalActionsMenu(
        session: session, controller: controller, terminalID: details.id,
        cwd: cwd, canReturnToBottom: session.canWrite && controller.canSend,
        canReconnect: session.canReconnect, canDelete: session.canWrite,
        deleting: $deleting, showingHistory: $showingHistory,
        showingInfo: $showingInfo, showingDiagnostics: $showingDiagnostics
      ).equatable()
    }
  }
}
