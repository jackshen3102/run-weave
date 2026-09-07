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
  @Environment(\.verticalSizeClass) private var verticalSizeClass

  private var currentTerminal: HomeTerminal? {
    session.overview?.sessions.first { $0.id == details.id }
  }
  private var title: String {
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

  var body: some View {
    VStack(spacing: 6) {
      HStack(alignment: .top) {
        Text(cwd).lineLimit(1).truncationMode(.middle)
        Spacer()
        Text(status)
        if let terminal = currentTerminal { Text(terminal.relativeTime) }
      }.font(.caption).foregroundColor(.secondary).padding(.horizontal)
      if let error = session.error {
        Text(error).font(.caption).foregroundColor(.red).padding(.horizontal)
      }
      HStack {
        ForEach(["Chat", "Changes", "Files"], id: \.self) { value in
          Button(value == "Changes" ? "Changes (\(changesCount))" : value) {
            controller.surface.view.window?.endEditing(true)
            tab = value
          }.font(.body.weight(tab == value ? .bold : .regular)).frame(maxWidth: .infinity)
        }
      }.padding(.horizontal)
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

  private var chat: some View {
    VStack(spacing: verticalSizeClass == .compact ? 2 : 6) {
      if session.health.status == .offline { Text("本地电脑暂时不可用").foregroundColor(.orange) }
      if let failure = controller.failure { Text(failure).font(.caption).foregroundColor(.red) }
      TerminalHostView(surface: controller.surface).frame(minHeight: 24)
        .overlay(alignment: .bottomTrailing) {
          if controller.scrolledBack {
            Button("回到底部") { controller.returnToBottom() }
              .font(.caption).padding(8).background(.regularMaterial).cornerRadius(12).padding(8)
              .disabled(!session.canWrite || !controller.canSend)
          }
        }
      if verticalSizeClass != .compact {
        ShortcutBar(controller: controller, enabled: session.canWrite)
      }
      ComposerView(
        session: session, controller: controller, terminalID: details.id, active: tab == "Chat")
    }
  }

  @ToolbarContentBuilder private var terminalToolbar: some ToolbarContent {
    ToolbarItemGroup(placement: .navigationBarTrailing) {
      Button {
        controller.surface.view.window?.endEditing(true)
      } label: {
        Image(systemName: "keyboard.chevron.compact.down")
      }.accessibilityLabel("收起键盘")
      Menu {
        Button("终端历史") { showingHistory = true }
        Button("诊断") { showingDiagnostics = true }
        Button("回到底部") { controller.returnToBottom() }.disabled(
          !session.canWrite || !controller.canSend)
        Button("重连") { if session.canWrite { controller.connect() } }.disabled(
          !session.canWrite)
        Button("删除终端", role: .destructive) { deleting = true }.disabled(!session.canWrite)
      } label: {
        Image(systemName: "ellipsis.circle")
      }
    }
  }
}
