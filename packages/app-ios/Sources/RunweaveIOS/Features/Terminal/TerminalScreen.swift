import SwiftUI

struct TerminalScreen: View {
  @ObservedObject var session: AppSession
  @ObservedObject var controller: SessionController
  let details: TerminalDetails
  @State private var deleting = false
  @State private var showingHistory = false
  @State private var showingDiagnostics = false
  @State private var tab = "Chat"
  @State private var requestedChange: SelectedFile?
  @State private var changesCount = 0
  @AppStorage("native.theme") private var theme = "dark"

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
          requested: $requestedChange, count: $changesCount
        )
        .opacity(tab == "Changes" ? 1 : 0).allowsHitTesting(tab == "Changes").accessibilityHidden(
          tab != "Changes")
        FilesView(session: session, projectID: details.projectId, active: tab == "Files") {
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
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { terminalToolbar }
    .sheet(isPresented: $showingHistory) { HistoryView(session: session, terminalID: details.id) }
    .sheet(isPresented: $showingDiagnostics) { DiagnosticsView(session: session) }
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
          Text("\(changesCount)").font(.caption2)
            .padding(.horizontal, 5).padding(.vertical, 2)
            .background(TerminalAppearance.panel).cornerRadius(5)
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
      if let notice = controller.notice { Text(notice).font(.caption).foregroundColor(.orange) }
      TerminalHostView(surface: controller.surface).frame(minHeight: 24)
        .padding(.horizontal, 12).padding(.top, 10)
        .overlay(alignment: .bottomTrailing) {
          if controller.scrolledBack {
            Button("回到底部") { controller.returnToBottom() }
              .font(.caption).padding(8).background(.regularMaterial).cornerRadius(12).padding(8)
              .disabled(!session.canWrite || !controller.canSend)
          }
        }
      ComposerView(
        session: session, controller: controller, terminalID: details.id, active: tab == "Chat")
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
      Menu {
        Text(cwd)
        Button("收起键盘") { controller.surface.view.window?.endEditing(true) }
        Button("终端历史") { showingHistory = true }
        Button("诊断") { showingDiagnostics = true }
        Button("回到底部") { controller.returnToBottom() }.disabled(
          !session.canWrite || !controller.canSend)
        Button("重连") { Task { await session.reconnectTerminal() } }.disabled(
          !session.canReconnect)
        Button("删除终端", role: .destructive) { deleting = true }.disabled(!session.canWrite)
      } label: {
        Image(systemName: "ellipsis")
      }.accessibilityLabel("终端操作")
    }
  }
}
