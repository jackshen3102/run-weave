import Clarity
import RunweaveBrowser
import SwiftUI

struct TerminalScreen: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var quickInputs: BackendQuickInputModel
  @EnvironmentObject private var remoteDesktop: RemoteDesktopCoordinator
  @ObservedObject var session: AppSession
  @ObservedObject var controller: SessionController
  @ObservedObject private var browser: BrowserSession
  let details: TerminalDetails
  let sourceIsParent: Bool
  @State private var scheduledSourceName: String?
  @State private var fileTap: TerminalFileTap?
  @State private var deleting = false
  @State private var showingBranchUpdates = false
  @State private var showingHistory = false
  @State private var showingConversation = false
  @State private var showingInfo = false
  @State private var showingSupervision = false
  @StateObject private var sideChat: SideChatModel
  @StateObject private var composerEditor = CommandTextEditor()
  @StateObject private var supervision: TaskSupervisionModel
  @State private var replyContext: CodexReplyContext?
  @State private var showingDiagnostics = false
  @State private var snapshotShare: TerminalSnapshotShare?
  @State private var shareOperation: Task<Void, Never>?
  @State private var sharing = false
  @State private var shareFailure: String?
  @State private var showingComposer = false
  @State private var composerViewportCovered = false
  @AppStorage(DevicePreferences.instantRepliesVisibleKey, store: DevicePreferences.store) private var showingInstantReplies = false
  @State private var sendingInstantReply = false
  @AccessibilityFocusState private var composerTriggerFocused: Bool
  @State private var browserPresentationID = UUID()
  @State private var composerPreventsDismissal = false
  @State private var stoppingCommand = false
  @State private var actionFailure: String?
  @State private var tab = "Chat"
  @StateObject private var changes: ProjectChangesModel
  @ObservedObject private var attachmentDrafts: TerminalAttachmentDrafts
  @AppStorage(DevicePreferences.themeKey, store: DevicePreferences.store) private var theme = "dark"

  init(session: AppSession, controller: SessionController, details: TerminalDetails, sourceIsParent: Bool = false) {
    self.session = session
    self.controller = controller
    self.browser = session.browser
    self.details = details
    _sideChat = StateObject(wrappedValue: SideChatModel(session: session, terminalID: details.id))
    _supervision = StateObject(wrappedValue: TaskSupervisionModel(session: session, controller: controller, terminalID: details.id))
    self.sourceIsParent = sourceIsParent
    _changes = StateObject(wrappedValue: ProjectChangesModel(session: session, terminal: details))
    self.attachmentDrafts = session.attachmentDrafts
  }

  private var canReadChanges: Bool {
    session.foreground && session.authenticated && session.health.status == .online
  }

  private var currentTerminal: HomeTerminal? {
    session.overview?.sessions.first { $0.id == details.id }
  }
  private var projectID: String { currentTerminal?.projectId ?? details.projectId }
  private var canReportCompletionViewed: Bool {
    session.foreground && session.canWrite && session.terminal?.id == details.id
      && controller.canSend && !controller.scrolledBack && tab == "Chat"
      && !showingBranchUpdates && !sideChat.visible && browser.state != .presented && !showingHistory && !showingConversation
      && !showingInfo && !showingSupervision && !showingDiagnostics && !showingComposer && fileTap == nil
      && replyContext == nil && snapshotShare == nil && !deleting
  }
  private var completionViewKey: String {
    "\(details.id):\(currentTerminal?.completionRevision ?? 0):\(canReportCompletionViewed)"
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
      $0.id == HomeOverview.parentProjectID(projectID)
    }?.name ?? (cwd as NSString).lastPathComponent
  }

  var body: some View {
    VStack(spacing: 0) {
      if let error = session.error {
        Text(error).font(.caption).foregroundColor(.red).padding(.horizontal)
      }
      if let source = details.source, source.type == "scheduled-task" {
        Button {
          // Pop the nested destination before disposing its terminal controller.
          // Home owns an in-place destination replacement and must not pop.
          if sourceIsParent { dismiss() }
          session.openScheduledSource(source)
        } label: {
          Label("来源：\(scheduledSourceName ?? "定时任务")", systemImage: "calendar.badge.clock").font(.caption).lineLimit(1)
        }.padding(.vertical, 5).accessibilityIdentifier("scheduled-task-source")
      }
      tabs
      if let watch = supervision.watch, watch.enabled {
        TaskSupervisionStrip(watch: watch, stale: !supervision.canRead || supervision.failure != nil) {
          controller.surface.view.window?.endEditing(true)
          showingSupervision = true
        }
      }
      ZStack {
        chat.opacity(tab == "Chat" ? 1 : 0).allowsHitTesting(tab == "Chat").accessibilityHidden(
          tab != "Chat")
        ChangesView(
          session: session, projectID: projectID, active: tab == "Changes",
          model: changes
        )
        .id(projectID).opacity(tab == "Changes" ? 1 : 0).allowsHitTesting(tab == "Changes").accessibilityHidden(
          tab != "Changes")
        FilesView(
          session: session, projectID: projectID, active: tab == "Files", model: changes
        ).id(projectID).opacity(tab == "Files" ? 1 : 0).allowsHitTesting(tab == "Files").accessibilityHidden(
          tab != "Files")
        TerminalQuickCommandsView(
          session: session, controller: controller, projectId: projectID,
          projectLabel: quickCommandProjectLabel, active: tab == "Commands",
          send: sendQuickCommand, insert: insertQuickCommand, onOpenTerminal: { tab = "Chat" }
        ).opacity(tab == "Commands" ? 1 : 0).allowsHitTesting(tab == "Commands")
          .accessibilityHidden(tab != "Commands")
      }
    }
    // A search keyboard inside the composer sheet must not resize the terminal behind it.
    .ignoresSafeArea(.keyboard, edges: .bottom)
    .background(TerminalAppearance.background.ignoresSafeArea())
    .tint(TerminalAppearance.accent)
    .modifier(TerminalNavigationBackground())
    .onAppear {
      controller.surface.applyTheme(dark: theme != "light")
      connectBrowserIntents()
      controller.openFileRequested = { tap in
        guard session.terminalController === controller, session.terminal?.id == details.id else { return }
        fileTap = tap
      }
    }
    .task(id: completionViewKey) {
      guard canReportCompletionViewed, let revision = currentTerminal?.completionRevision, revision > 0,
        let api = session.api else { return }
      do {
        try await Task.sleep(nanoseconds: 1_000_000_000)
        try Task.checkCancellation()
        try await api.reportCompletionViewed(id: details.id, revision: revision)
      } catch { /* A missing view receipt must not suppress the reminder. */ }
    }
    .onChange(of: theme) { controller.surface.applyTheme(dark: $0 != "light") }
    .task(id: "\(canReadChanges):\(projectID)") {
      changes.selectProject(projectID)
      if canReadChanges { await changes.refresh() }
      else { changes.cancel() }
    }
    .onChange(of: controller.connectionStatus) { status in
      if status == "已连接" { Task { await changes.refresh() } }
    }
    .onDisappear {
      if !sideChat.visible { sideChat.suspend() }
      supervision.suspend()
      shareOperation?.cancel()
      controller.openFileRequested = nil
      changes.cancel()
      browser.unregisterHostPresentation(id: browserPresentationID, hostID: ObjectIdentifier(controller))
    }
    .task(id: details.source?.taskId) {
      guard let source = details.source, source.type == "scheduled-task" else { return }
      do {
        let task = try await session.withConnection(reportFailure: false) { try await ScheduledTasksService(api: $0).task(source.taskId) }
        try Task.checkCancellation()
        scheduledSourceName = task.config.name
      } catch {}
    }
    .task(id: "\(session.generation):\(session.foreground):\(session.authenticated):\(session.health.status):\(browser.state == .presented)") {
      if supervision.canRead && browser.state != .presented { await supervision.poll() }
      else { supervision.suspend() }
    }
    .task(id: "side-chat:\(session.generation):\(session.foreground):\(session.authenticated):\(session.health.status)") {
      if sideChat.canRead { sideChat.startPolling() } else { sideChat.suspend() }
    }
    .fullScreenCover(isPresented: $sideChat.visible) {
      SideChatView(model: sideChat, session: session, title: title, terminalID: details.id)
        .mobileAnalyticsScreen(.sideChat)
    }
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { terminalToolbar }
    .overlay(alignment: .top) {
      if let status = browser.dataStatus {
        HStack(spacing: 12) {
          if browser.openingTarget != nil { ProgressView() }
          VStack(alignment: .leading, spacing: 3) {
            Text(status).font(.subheadline)
            if let target = browser.openingTarget {
              Text(URLComponents(string: target)?.host ?? target)
                .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
          }
          Spacer(minLength: 0)
        }
        .padding(14).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.horizontal, 16).padding(.top, 8)
        .allowsHitTesting(false).accessibilityIdentifier("browser-data-status")
      }
    }
    .fullScreenCover(isPresented: Binding(
      get: { browser.state == .presented && !showingConversation },
      set: { if !$0 && !showingConversation { browser.collapse() } }
    )) { BrowserScreen(browser: browser).clarityMask().mobileAnalyticsScreen(.browser) }
    .modifier(BrowserPromptPresenter(browser: browser, active: browser.state != .presented && !showingConversation))
    .sheet(item: $fileTap) { tap in
      TerminalFilePreview(session: session, terminalID: details.id, projectID: projectID,
        tap: tap, close: { fileTap = nil }, model: changes)
        .clarityMask().mobileAnalyticsScreen(.filePreview)
    }
    .sheet(isPresented: $showingHistory) { HistoryView(session: session, terminalID: details.id).mobileAnalyticsScreen(.history) }
    .fullScreenCover(isPresented: $showingConversation, onDismiss: connectBrowserIntents) {
      ConversationReaderView(session: session, controller: controller, terminalID: details.id, title: title)
        .mobileAnalyticsScreen(.conversationReader)
    }
    .sheet(item: $replyContext) { context in
      CodexReplyAssistant(session: session, controller: controller, questions: session.terminalQuestions,
        terminalID: details.id,
        context: context, returnToTerminal: {
          guard session.generation == context.generation,
            session.terminal?.id == details.id, session.terminalController === controller,
            currentTerminal?.conversationKey == context.conversationKey,
            (session.terminalQuestions.response?.capability == "available"
              || (currentTerminal?.conversationRevision == context.conversationRevision
                && currentTerminal?.conversationPreview?.turnId == context.turnID)) else { return }
          replyContext = nil
          tab = "Chat"
          controller.returnToBottom()
        }).clarityMask()
    }
    .sheet(isPresented: $showingSupervision) {
      TaskSupervisionSheet(session: session, model: supervision, terminalTitle: title)
    }
    .sheet(isPresented: $showingInfo) { TerminalInfoView(terminalID: details.id).mobileAnalyticsScreen(.terminalInfo) }
    .sheet(isPresented: $showingDiagnostics) { DiagnosticsView(session: session).mobileAnalyticsScreen(.diagnostics) }
    .sheet(item: $snapshotShare) { TerminalSnapshotShareSheet(url: $0.url).mobileAnalyticsScreen(.share) }
    .onChange(of: session.generation) { _ in
      shareOperation?.cancel()
      snapshotShare = nil
      shareFailure = nil
      replyContext = nil
      showingConversation = false
      if !sideChat.current { sideChat.visible = false }
      sideChat.suspend()
    }
    .alert("分享失败", isPresented: Binding(
      get: { shareFailure != nil }, set: { if !$0 { shareFailure = nil } }
    )) {
      Button("好", role: .cancel) { shareFailure = nil }
    } message: { Text(shareFailure ?? "") }
    .background {
      TerminalComposerPresentation(
        session: session, controller: controller, terminalID: details.id,
        editor: composerEditor,
        isPresented: $showingComposer, preventsDismissal: $composerPreventsDismissal,
        showingInstantReplies: $showingInstantReplies,
        sideChatAvailable: sideChat.capabilities != nil,
        sideChat: sideChat,
        onSideChat: { Task { await sideChat.open() } },
        onDismiss: {
          composerViewportCovered = false
          composerTriggerFocused = true
        })
    }
    .confirmationDialog("删除终端？", isPresented: $deleting, titleVisibility: .visible) {
      Button("删除", role: .destructive) { Task { await session.deleteTerminal(details.id) } }
      Button("取消", role: .cancel) {}
    } message: {
      Text("删除后将结束该远端终端会话及其活跃旁聊，旁聊记录保留。")
    }
    .mobileAnalyticsScreen(tab == "Commands" ? .quickReplies : tab == "Files" ? .terminalFiles : tab == "Changes" ? .terminalChanges : .terminalChat)
  }

  private func connectBrowserIntents() {
    guard let source = session.browserSource, session.terminal?.id == details.id,
      session.terminalController === controller else { return }
    let composer = $showingComposer
    let history = $showingHistory
    let conversation = $showingConversation
    let info = $showingInfo
    let reply = $replyContext
    let diagnostics = $showingDiagnostics
    let deletion = $deleting
    let share = $snapshotShare
    let sharePending = $sharing
    let browser = browser
    let registrationID = browserPresentationID
    // Bindings read current SwiftUI storage; capturing this View's Bool values would go stale.
    browser.registerHostPresentation(id: registrationID, source: source, hostID: ObjectIdentifier(controller)) { [weak session, weak controller, weak browser] in
      guard let session, let controller, let browser, session.browserSource == source,
        session.terminalController === controller, let window = controller.surface.view.window else { return false }
      let systemBusy = window.rootViewController?.presentedViewController != nil
      return !composer.wrappedValue && !history.wrappedValue && !conversation.wrappedValue && !info.wrappedValue
        && !diagnostics.wrappedValue && !deletion.wrappedValue && reply.wrappedValue == nil && !systemBusy
        && share.wrappedValue == nil && !sharePending.wrappedValue
        && browser.state != .presented && !browser.hasPrompt
    }
    controller.openLinkRequested = { intent in
      browser.open(intent, source: source, presentationAvailable:
        browser.hostPresentationAvailable(source: source, registrationID: registrationID))
    }
  }

  private func shareSnapshot() {
    guard session.canWrite, !sharing, session.terminalController === controller else { return }
    sharing = true
    shareFailure = nil
    let epoch = session.generation
    shareOperation = Task { @MainActor in
      defer { sharing = false }
      do {
        let result = try await session.withConnection(reportFailure: false) {
          try await $0.createTerminalSnapshotShare(id: details.id)
        }
        guard !Task.isCancelled, session.generation == epoch,
          session.terminalController === controller, session.terminal?.id == details.id else { return }
        snapshotShare = result
      } catch {
        guard !Task.isCancelled, !(error is CancellationError), session.generation == epoch,
          session.terminalController === controller else { return }
        shareFailure = displayError(error)
      }
    }
  }

  private var tabs: some View {
    HStack(spacing: 20) {
      ForEach(["Chat", "Changes", "Files", "Commands"], id: \.self) { value in tabButton(value) }
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
        Text(value == "Chat" ? "终端" : value == "Changes" ? "变更" : value == "Files" ? "文件" : "快捷指令")
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
    .accessibilityIdentifier("terminal-tab-\(value)")
  }

  private var chat: some View {
    VStack(spacing: 0) {
      if session.health.status == .offline { Text("本地电脑暂时不可用").foregroundColor(.orange) }
      if let failure = actionFailure ?? controller.failure {
        Text(failure).font(.caption).foregroundColor(.red)
      }
      if let notice = controller.notice { Text(notice).font(.caption).foregroundColor(.orange) }
      TerminalHostView(surface: controller.surface, covered: composerViewportCovered || sideChat.visible).frame(minHeight: 24)
        .padding(.horizontal, 12).padding(.top, 8)
        .ignoresSafeArea(.container, edges: .bottom)
    }
    .overlay(alignment: .bottom) { terminalDock }
  }

  private var hasComposerDraft: Bool {
    let text = session.terminalDrafts[details.id] ?? ""
    return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || !(attachmentDrafts.attachments[details.id] ?? []).isEmpty
  }

  private var terminalDock: some View {
    VStack(spacing: 8) {
      if let failure = sideChat.failure, !sideChat.visible {
        Text(failure).font(.caption).foregroundColor(.red).frame(maxWidth: .infinity, alignment: .leading)
      }
      if showingInstantReplies {
        TerminalInstantReplyBar(
          enabled: session.canWrite && controller.canSend && !sendingInstantReply && !stoppingCommand,
          sending: sendingInstantReply,
          send: sendInstantReply, close: { showingInstantReplies = false })
          .fixedSize(horizontal: true, vertical: false)
      }
      HStack(spacing: 0) {
        if sideChat.capabilities != nil {
          TerminalSideChatButton(sideChat: sideChat)
        }
        if session.isCommandActive(details.id) {
          TerminalStopButton(stopping: stoppingCommand, canWrite: session.canWrite, stop: stopActiveCommand)
        }
        Button(action: openComposer) {
          Image(systemName: "square.and.pencil")
            .font(.system(size: 26, weight: .medium))
            .frame(width: 64, height: 48).contentShape(Rectangle())
            .overlay(alignment: .topTrailing) {
              if hasComposerDraft {
                Circle().fill(Color.orange).frame(width: 7, height: 7)
                  .padding(.top, 6).padding(.trailing, 10)
              }
            }
        }
        .accessibilityLabel("打开终端输入")
        .accessibilityValue(hasComposerDraft ? "有未发送草稿" : "无草稿")
        .accessibilityIdentifier("terminal-composer-open").accessibilityFocused($composerTriggerFocused)
      }
      .font(.system(size: 20, weight: .medium))
      .foregroundColor(TerminalAppearance.accent)
      .padding(4).terminalGlass(in: Capsule())
      .frame(maxWidth: .infinity)
      .overlay(alignment: .trailing) {
        if controller.scrolledBack {
          Button { controller.returnToBottom() } label: {
            Image(systemName: "arrow.down").frame(width: 44, height: 44)
              .terminalGlass(in: Circle()).contentShape(Circle())
          }
          .accessibilityLabel("回到底部").accessibilityIdentifier("terminal-return-to-bottom")
          .disabled(!session.canWrite || !controller.canSend)
        }
      }
    }
    .frame(maxWidth: .infinity)
    .buttonStyle(.plain).padding(.horizontal, 16).padding(.vertical, 8)
  }

  private func openComposer() {
    actionFailure = nil
    composerPreventsDismissal = false
    // Full-screen content can receive transient safe-area sizes until UIKit finishes dismissing.
    composerViewportCovered = true
    showingComposer = true
  }

  private func openReplyAssistant() {
    guard replyContext == nil, session.terminal?.id == details.id,
      session.terminalController === controller else { return }
    let preview = currentTerminal?.conversationPreview
    replyContext = CodexReplyContext(generation: session.generation,
      conversationKey: currentTerminal?.conversationKey,
      conversationRevision: currentTerminal?.conversationRevision,
      agentText: preview?.available == true && preview?.provider == "codex" ? preview?.agentText : nil,
      turnID: preview?.turnId)
  }

  private var quickCommandProjectLabel: String {
    let label = scheduledProjectLabel(projectID, session: session)
    return projectID.hasPrefix("wt:") ? label : label + " / 主项目"
  }

  private func sendQuickCommand(_ item: BackendQuickInput) async throws {
    guard session.terminal?.id == details.id, session.terminalController === controller else { throw CancellationError() }
    let epoch = session.generation
    let agent = currentTerminal?.terminalState.agent
    let isSlash = item.data.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/")
    let mode = agent == "codex" && isSlash ? "codex_slash_command" : "line"
    try await session.sendInstantReply(item.data, terminalID: details.id, controller: controller, mode: mode)
    guard session.generation == epoch, session.terminal?.id == details.id,
      session.terminalController === controller else { throw CancellationError() }
    tab = "Chat"
  }

  private func insertQuickCommand(_ item: BackendQuickInput) {
    guard session.canWrite, session.terminal?.id == details.id,
      session.terminalController === controller else { return }
    let previous = session.terminalDrafts[details.id] ?? ""
    session.setDraft(previous + (previous.isEmpty || previous.hasSuffix("\n") ? "" : "\n") + item.data,
      terminalID: details.id, suppressQuickInputHistory: true)
    Task { await quickInputs.markUsed(session, id: item.id) }
    tab = "Chat"
    openComposer()
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

  private func sendInstantReply(_ text: String) {
    guard session.terminal?.id == details.id, session.terminalController === controller,
      session.canWrite, controller.canSend, !sendingInstantReply, !stoppingCommand else { return }
    // Reserve synchronously so a second tap cannot enqueue another Task before inputBusy changes.
    sendingInstantReply = true
    actionFailure = nil
    let epoch = session.generation
    session.recordUserAction("instant-reply.send", terminalID: details.id)
    Task { @MainActor in
      defer { sendingInstantReply = false }
      do {
        try await session.sendInstantReply(text, terminalID: details.id, controller: controller)
      } catch {
        guard !(error is CancellationError), session.generation == epoch,
          session.terminalController === controller, session.terminal?.id == details.id else { return }
        actionFailure = "一键回复发送未确认，请先核对终端结果；不会自动重发。\n" + displayError(error)
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
      Button { tab = "Files" } label: { Image(systemName: "folder") }
        .accessibilityLabel("终端文件").accessibilityIdentifier("terminal-files-open")
      if let title = browser.pageTitle {
        Button {
          guard let source = session.browserSource,
            browser.hostPresentationAvailable(source: source, registrationID: browserPresentationID) else { return }
          browser.resume()
        } label: { Image(systemName: "globe") }
        .accessibilityLabel("恢复网页：\(title)")
        .accessibilityIdentifier("terminal-browser-resume")
        .disabled(browser.clearing)
      }
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
        canShare: session.canWrite, sharing: sharing, share: shareSnapshot,
        readConversation: { showingConversation = true },
        canReply: currentTerminal?.terminalState.agent == "codex", reply: openReplyAssistant,
        openDesktop: { remoteDesktop.requestOpen(backendConnectionID: session.connection?.id) },
        supervisionEnabled: supervision.watch?.enabled == true,
        canFork: session.canWrite && currentTerminal?.terminalState.agent == "codex"
          && currentTerminal?.terminalState.state == "agent_idle",
        showingBranchUpdates: $showingBranchUpdates, showingSupervision: $showingSupervision,
        deleting: $deleting, showingHistory: $showingHistory,
        showingInfo: $showingInfo, showingDiagnostics: $showingDiagnostics
      ).equatable()
    }
  }
}
