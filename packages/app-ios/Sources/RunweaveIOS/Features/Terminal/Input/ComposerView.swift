import SwiftUI

struct TerminalComposerSheet: View {
  @EnvironmentObject private var quickInputs: BackendQuickInputModel
  let session: AppSession
  let controller: SessionController
  let terminalID: String
  @Binding var preventsDismissal: Bool
  @Binding var showingInstantReplies: Bool
  let onDismiss: () -> Void

  private var busy: Bool { preventsDismissal || quickInputs.saving }

  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .bottom) {
        Color.clear.contentShape(Rectangle())
          .onTapGesture { if !busy { onDismiss() } }
          .accessibilityHidden(true)
        ComposerView(
          session: session, controller: controller, terminalID: terminalID,
          availableHeight: geometry.size.height, preventsDismissal: $preventsDismissal,
          showingInstantReplies: $showingInstantReplies,
          onActionSucceeded: onDismiss, onClose: onDismiss, closeDisabled: busy
        )
        .id(ObjectIdentifier(controller))
      }
    }
  }
}

struct ComposerView: View {
  let session: AppSession
  let controller: SessionController
  @StateObject private var state: TerminalComposerState
  @StateObject private var modelSettings = TerminalAgentSettingsModel()
  @StateObject private var textEditor = CommandTextEditor()
  @ObservedObject private var attachmentDrafts: TerminalAttachmentDrafts
  let terminalID: String
  var active = true
  let availableHeight: CGFloat
  let onClose: () -> Void
  let closeDisabled: Bool
  @Binding var preventsDismissal: Bool
  @Binding var showingInstantReplies: Bool
  let onActionSucceeded: () -> Void
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @State private var failure: String?
  @State private var stopping = false
  @State private var submitting = false
  @State private var showingShortcuts = false
  @State private var editing = true
  @State private var inputHeight: CGFloat = 37
  @State private var chromeHeight: CGFloat = 124
  @State private var showingFailure = false
  @State private var accessoryHeight: CGFloat = 0
  @ScaledMetric private var minimumVisibleInput: CGFloat = 32

  private var hasAccessories: Bool {
    state.snapshot.inputBusy || showingShortcuts || failure != nil || !attachments.isEmpty
  }
  private var visibleAccessoryHeight: CGFloat {
    hasAccessories ? min(accessoryHeight, max(0, availableHeight - chromeHeight - minimumVisibleInput)) : 0
  }
  private var maximumInputHeight: CGFloat { max(1, availableHeight - chromeHeight - visibleAccessoryHeight) }
  private var visibleInputHeight: CGFloat { min(inputHeight, maximumInputHeight) }

  init(
    session: AppSession, controller: SessionController, terminalID: String, active: Bool = true,
    availableHeight: CGFloat, preventsDismissal: Binding<Bool>,
    showingInstantReplies: Binding<Bool>,
    onActionSucceeded: @escaping () -> Void, onClose: @escaping () -> Void, closeDisabled: Bool
  ) {
    self.session = session
    self.controller = controller
    self.terminalID = terminalID
    self.active = active
    self.availableHeight = availableHeight
    self.onClose = onClose
    self.closeDisabled = closeDisabled
    self.attachmentDrafts = session.attachmentDrafts
    _state = StateObject(wrappedValue: TerminalComposerState(
      session: session, controller: controller, terminalID: terminalID))
    _preventsDismissal = preventsDismissal
    _showingInstantReplies = showingInstantReplies
    self.onActionSucceeded = onActionSucceeded
  }

  private var attachments: [TerminalDraftAttachment] { attachmentDrafts.attachments[terminalID] ?? [] }
  private var hasContent: Bool { hasText || !attachments.isEmpty }
  private var sendDisabled: Bool {
    !state.snapshot.canWrite || !state.snapshot.canSend || stopping || submitting
      || (!showStop && (!hasContent || attachments.contains { $0.path == nil }))
  }
  private var hasText: Bool {
    !state.snapshot.draft.trimmingCharacters(in: .whitespacesAndNewlines)
      .isEmpty
  }
  private var showStop: Bool { state.snapshot.commandActive && !hasContent }
  private var actionLabel: String {
    showStop ? (stopping ? "停止中…" : "停止") : (state.snapshot.inputBusy ? "发送中…" : "发送")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--native-auth-validation"),
          verticalSizeClass != .compact,
          session.api?.baseURL.host == "127.0.0.1" || session.api?.baseURL.host == "localhost"
        {
          Button("调试：撤销远端登录") {
            Task {
              do {
                try await session.withConnection { try await $0.revokeRemoteLoginForValidation() }
                failure = "远端登录已撤销；发送草稿可验证认证失败处理"
              } catch { failure = displayError(error) }
            }
          }.font(.caption).disabled(!state.snapshot.canWrite)
        }
      #endif
      if hasAccessories {
        // On cramped keyboards/landscape, secondary content yields space to the editor and toolbar.
        ScrollView(.vertical) {
          VStack(alignment: .leading, spacing: 8) {
            if state.snapshot.inputBusy {
              Text("正在等待电脑确认；关闭面板不会撤回已发送内容，也不会自动重发。")
                .font(.caption).foregroundColor(.secondary).lineLimit(2)
            }
            if showingShortcuts {
              ShortcutBar(controller: controller, enabled: state.snapshot.canWrite && state.snapshot.canSend)
            }
            if let failure {
              Button { showingFailure = true } label: {
                Text(failure).font(.caption).foregroundColor(.red).lineLimit(2)
              }.buttonStyle(.plain).accessibilityHint("查看完整错误")
            }
            ComposerAttachments(drafts: attachmentDrafts, session: session, terminalID: terminalID)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(composerMeasurement("accessories"))
        }
        .frame(height: visibleAccessoryHeight)
        .background(composerMeasurement("accessoryViewport"))
      }
      VStack(alignment: .leading, spacing: 4) {
        inputCard
      }
      .padding(.horizontal, 10).padding(.top, 6).padding(.bottom, 4)
      .background(TerminalAppearance.panel)
      .clipShape(RoundedRectangle(cornerRadius: 16))
      .overlay(
        RoundedRectangle(cornerRadius: 16).strokeBorder(
          editing ? TerminalAppearance.accent.opacity(0.6) : TerminalAppearance.border,
          lineWidth: 1
        ))
    }
    .padding(.horizontal, 16).padding(.vertical, 8)
    .frame(maxWidth: .infinity)
    .background(TerminalAppearance.background)
    .clipShape(RoundedRectangle(cornerRadius: 20))
    .accessibilityAction(.escape) {
      if !closeDisabled { onClose() }
    }
    .background(composerMeasurement("panel"))
    .onPreferenceChange(ComposerMeasurements.self) { sizes in
      guard let panel = sizes["panel"], let editor = sizes["editor"] else { return }
      if let height = sizes["accessories"], abs(accessoryHeight - height) > 0.5 { accessoryHeight = height }
      let next = ceil(panel - editor - (sizes["accessoryViewport"] ?? 0))
      if abs(chromeHeight - next) > 0.5 { chromeHeight = next }
    }
    .task {
      await modelSettings.refresh(session: session, terminalID: terminalID)
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 10_000_000_000)
        if !Task.isCancelled && modelSettings.page == .input {
          await modelSettings.refresh(session: session, terminalID: terminalID)
        }
      }
    }
    .onChange(of: modelSettings.page) { page in
      editing = page == .input
    }
    .alert("操作失败", isPresented: $showingFailure) {
      Button("关闭", role: .cancel) {}
    } message: { Text(failure ?? "") }
  }

  private var inputCard: some View {
    MediaControls(
      session: session, terminalID: terminalID, canWrite: state.snapshot.canWrite,
      visible: active,
      preventsDismissal: $preventsDismissal
    ) { attachment, _ in
      VStack(spacing: 8) {
        if modelSettings.page == .input {
          editor
        } else {
          TerminalAgentSettingsView(
            model: modelSettings, session: session, terminalID: terminalID,
            height: min(200, max(70, maximumInputHeight))
          )
          .background(composerMeasurement("editor"))
        }
        HStack(spacing: 2) {
          actionsMenu(attachment: attachment)
            .layoutPriority(1)
          if let summary = modelSettings.summary {
            Button {
              editing = false
              modelSettings.showModels()
            } label: {
              Text(summary).font(.caption.weight(.medium)).lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }
            .accessibilityLabel("当前终端模型与推理强度：\(summary)")
            .accessibilityIdentifier("terminal-agent-settings-open")
            .disabled(modelSettings.saving)
          }
          Spacer(minLength: 0)
          controls.layoutPriority(1)
        }
      }
    }
    .buttonStyle(TerminalControlButtonStyle())
    .foregroundColor(.secondary)
  }

  private var editor: some View {
    CommandTextView(
      text: Binding(
        get: { session.terminalDrafts[terminalID] ?? "" },
        set: { session.setDraft($0, terminalID: terminalID) }),
      isFocused: $editing, collapsesWhenUnfocused: false,
      maximumHeight: maximumInputHeight, onHeightChange: { inputHeight = $0 }, editor: textEditor
    )
    .frame(height: visibleInputHeight)
    .background(composerMeasurement("editor"))
    .overlay(alignment: .topLeading) {
      if state.snapshot.draft.isEmpty {
        Text("输入命令或告诉 Agent 要做什么…")
          .font(.body).foregroundColor(.secondary)
          .padding(.horizontal, 5).padding(.top, 8)
          .allowsHitTesting(false).accessibilityHidden(true)
      }
    }
  }

  private func actionsMenu(attachment: AnyView) -> some View {
    Menu {
      attachment
      if let key = state.snapshot.queueKey {
        Button { submit(queue: true) } label: {
          Label("排队", systemImage: "text.badge.plus")
        }
        .accessibilityIdentifier("terminal-composer-queue")
        .accessibilityHint(key == .tab ? "使用 Tab 加入 Agent 原生队列" : "使用 Alt+Enter 加入 Agent 原生队列")
        .disabled(sendDisabled || !hasContent || state.snapshot.inputBusy)
      }
      Button {
        showingInstantReplies.toggle()
        if showingInstantReplies {
          editing = false
          onClose()
        }
      } label: {
        Label(showingInstantReplies ? "收起一键回复" : "展开一键回复", systemImage: "bolt.fill")
      }
      .accessibilityLabel(showingInstantReplies ? "收起一键回复" : "展开一键回复")
      .accessibilityValue(showingInstantReplies ? "已展开" : "已收起")
      .accessibilityHint("在终端底部显示可以和继续，点击立即发送")
      .accessibilityIdentifier("terminal-instant-replies-toggle")
      .disabled(closeDisabled || state.snapshot.inputBusy)
    } label: {
      Image(systemName: "plus")
        .foregroundColor(TerminalAppearance.accent)
        .frame(width: 44, height: 44)
    }
    .accessibilityLabel("更多输入操作")
    .accessibilityIdentifier("terminal-composer-actions")
  }

  private var controls: some View {
    HStack(spacing: 2) {
      Button {
        showingShortcuts.toggle()
      } label: {
        Image(systemName: "keyboard")
          .foregroundColor(showingShortcuts ? TerminalAppearance.accent : .secondary)
          .frame(width: 44, height: 44)
          .background(showingShortcuts ? TerminalAppearance.accent.opacity(0.14) : .clear)
          .clipShape(RoundedRectangle(cornerRadius: 12))
      }
      .accessibilityLabel(showingShortcuts ? "收起快捷键" : "展开快捷键")
      .accessibilityValue(showingShortcuts ? "已展开" : "已收起")
      .accessibilityIdentifier("terminal-shortcuts-toggle")
      sendButton
    }
    .buttonStyle(TerminalControlButtonStyle())
    .foregroundColor(.secondary)
  }

  private var sendButton: some View {
    Button { submit() } label: {
      Group {
        if stopping || state.snapshot.inputBusy {
          ProgressView().tint(TerminalAppearance.background)
        } else {
          Image(systemName: showStop ? "stop.fill" : "arrow.up")
        }
      }
      .frame(width: 44, height: 44)
      .foregroundColor(TerminalAppearance.background)
      .background(TerminalAppearance.accent)
      .clipShape(RoundedRectangle(cornerRadius: 12))
    }
    .accessibilityLabel(actionLabel)
    .accessibilityIdentifier("terminal-composer-submit")
    .disabled(sendDisabled)
    .opacity(sendDisabled ? 0.4 : 1)
  }

  private func submit(queue: Bool = false) {
    guard session.terminal?.id == terminalID, session.terminalController === controller,
      session.canWrite, controller.canSend, !stopping, !submitting else { return }
    if queue, let committed = textEditor.commitComposition() {
      session.setDraft(committed, terminalID: terminalID)
    }
    failure = nil
    // Presentation is a deduplicated snapshot; actions always validate the current source state.
    let draft = session.terminalDrafts[terminalID] ?? ""
    guard !queue || (session.composerQueueKey(terminalID: terminalID) != nil
      && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)) else { return }
    let stop = !queue && session.isCommandActive(terminalID)
      && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty
    if !stop && !queue {
      editing = false
      showingShortcuts = false
    }
    session.recordUserAction(stop ? "composer.stop" : (queue ? "composer.queue" : "composer.send"), terminalID: terminalID)
    if stop { stopping = true }
    submitting = true
    Task {
      defer { stopping = false; submitting = false }
      do {
        if stop {
          try await session.stopCommand(terminalID)
        } else {
          try await session.sendCommand(terminalID: terminalID, queue: queue)
        }
        if queue { editing = true } else { onActionSucceeded() }
      } catch {
        if !(error is CancellationError) {
          failure = stop ? displayError(error) : displayInputError(error)
          if !stop && session.suppressedQuickInputDrafts.contains(terminalID) {
            failure = "快捷回复发送未确认，请确认电脑端支持本地快捷回复。不会自动重发或改为记录历史。\n"
              + displayInputError(error)
          }
        }
      }
    }
  }
}

private struct ComposerMeasurements: PreferenceKey {
  static var defaultValue: [String: CGFloat] = [:]
  static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) {
    value.merge(nextValue()) { _, next in next }
  }
}

private func composerMeasurement(_ key: String) -> some View {
  GeometryReader { geometry in
    Color.clear.preference(key: ComposerMeasurements.self, value: [key: geometry.size.height])
  }
}
