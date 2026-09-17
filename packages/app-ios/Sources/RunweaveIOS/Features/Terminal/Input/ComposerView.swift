import SwiftUI

struct TerminalComposerSheet: View {
  @EnvironmentObject private var quickReplies: LocalQuickReplyStore
  let session: AppSession
  let controller: SessionController
  let terminalID: String
  @Binding var preventsDismissal: Bool
  let onDismiss: () -> Void

  private var busy: Bool { preventsDismissal || quickReplies.saving }

  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .bottom) {
        Color.clear.contentShape(Rectangle())
          .onTapGesture { if !busy { onDismiss() } }
          .accessibilityHidden(true)
        ComposerView(
          session: session, controller: controller, terminalID: terminalID,
          availableHeight: geometry.size.height, preventsDismissal: $preventsDismissal,
          onActionSucceeded: onDismiss, onClose: onDismiss, closeDisabled: busy
        )
        .id(ObjectIdentifier(controller))
      }
    }
  }
}

struct ComposerView: View {
  @EnvironmentObject private var quickReplies: LocalQuickReplyStore
  let session: AppSession
  let controller: SessionController
  @StateObject private var state: TerminalComposerState
  @ObservedObject private var imageDrafts: TerminalImageDrafts
  let terminalID: String
  var active = true
  let availableHeight: CGFloat
  let onClose: () -> Void
  let closeDisabled: Bool
  @Binding var preventsDismissal: Bool
  let onActionSucceeded: () -> Void
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @State private var failure: String?
  @State private var stopping = false
  @State private var showingShortcuts = false
  @State private var editing = true
  @State private var showingReplies = false
  @State private var savingReply = false
  @State private var replySnapshot = ""
  @State private var pendingReply: LocalQuickReply?
  @State private var confirmingInsertion = false
  @State private var inputHeight: CGFloat = 60
  @State private var chromeHeight: CGFloat = 124
  @State private var showingFailure = false
  @State private var accessoryHeight: CGFloat = 0
  @ScaledMetric private var minimumVisibleInput: CGFloat = 32

  private var hasAccessories: Bool {
    state.snapshot.inputBusy || showingShortcuts || failure != nil || !images.isEmpty
  }
  private var visibleAccessoryHeight: CGFloat {
    hasAccessories ? min(accessoryHeight, max(0, availableHeight - chromeHeight - minimumVisibleInput)) : 0
  }
  private var maximumInputHeight: CGFloat { max(1, availableHeight - chromeHeight - visibleAccessoryHeight) }
  private var visibleInputHeight: CGFloat { min(inputHeight, maximumInputHeight) }

  init(
    session: AppSession, controller: SessionController, terminalID: String, active: Bool = true,
    availableHeight: CGFloat, preventsDismissal: Binding<Bool>,
    onActionSucceeded: @escaping () -> Void, onClose: @escaping () -> Void, closeDisabled: Bool
  ) {
    self.session = session
    self.controller = controller
    self.terminalID = terminalID
    self.active = active
    self.availableHeight = availableHeight
    self.onClose = onClose
    self.closeDisabled = closeDisabled
    self.imageDrafts = session.imageDrafts
    _state = StateObject(wrappedValue: TerminalComposerState(
      session: session, controller: controller, terminalID: terminalID))
    _preventsDismissal = preventsDismissal
    self.onActionSucceeded = onActionSucceeded
  }

  private var images: [TerminalDraftImage] { imageDrafts.images[terminalID] ?? [] }
  private var hasContent: Bool { hasText || !images.isEmpty }
  private var sendDisabled: Bool {
    !state.snapshot.canWrite || !state.snapshot.canSend || stopping
      || (!showStop && (!hasContent || images.contains { $0.path == nil }))
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
      HStack(spacing: 8) {
        VStack(alignment: .leading, spacing: 2) {
          Text("输入终端").font(.subheadline.weight(.semibold))
          Text(state.snapshot.targetLabel).font(.caption2).foregroundColor(.secondary).lineLimit(1)
        }
        Spacer(minLength: 0)
        Button(action: onClose) {
          Text("关闭").font(.subheadline).frame(minWidth: 44, minHeight: 44)
        }.disabled(closeDisabled)
      }
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
            ComposerImageAttachments(drafts: imageDrafts, session: session, terminalID: terminalID)
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
    .background(composerMeasurement("panel"))
    .onPreferenceChange(ComposerMeasurements.self) { sizes in
      guard let panel = sizes["panel"], let editor = sizes["editor"] else { return }
      if let height = sizes["accessories"], abs(accessoryHeight - height) > 0.5 { accessoryHeight = height }
      let next = ceil(panel - editor - (sizes["accessoryViewport"] ?? 0))
      if abs(chromeHeight - next) > 0.5 { chromeHeight = next }
    }
    .alert("操作失败", isPresented: $showingFailure) {
      Button("关闭", role: .cancel) {}
    } message: { Text(failure ?? "") }
    .sheet(isPresented: $showingReplies, onDismiss: {
      if pendingReply != nil {
        if (session.terminalDrafts[terminalID] ?? "").isEmpty { insertReply(append: false) }
        else { confirmingInsertion = true }
      } else { editing = true }
    }) {
      NavigationView {
        QuickReplyLibraryView(onSelect: selectReply)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("返回") { showingReplies = false }.disabled(quickReplies.saving)
            }
          }
      }.navigationViewStyle(.stack).interactiveDismissDisabled(quickReplies.saving)
    }
    .sheet(isPresented: $savingReply, onDismiss: { editing = true }) {
      NavigationView {
        QuickReplyEditorView(initialBody: replySnapshot)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("返回") { savingReply = false }.disabled(quickReplies.saving)
            }
          }
      }.navigationViewStyle(.stack).interactiveDismissDisabled(quickReplies.saving)
    }
    .confirmationDialog("输入框已有文字", isPresented: $confirmingInsertion, titleVisibility: .visible) {
      Button("追加到末尾") { insertReply(append: true) }
      Button("替换文字", role: .destructive) { insertReply(append: false) }
      Button("取消", role: .cancel) { pendingReply = nil; editing = true }
    } message: {
      Text("只修改当前输入框，图片附件保留；不会直接发送。")
    }
  }

  private var inputCard: some View {
    MediaControls(
      session: session, terminalID: terminalID, canWrite: state.snapshot.canWrite,
      visible: active && !showingReplies && !savingReply,
      preventsDismissal: $preventsDismissal
    ) { attachment, voice in
      VStack(spacing: 8) {
        editor
        HStack(spacing: 2) {
          attachment
          controls(voice: voice)
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
      maximumHeight: maximumInputHeight, onHeightChange: { inputHeight = $0 }
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

  private func controls(voice: AnyView) -> some View {
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
      Menu {
        Button("选择快捷回复") {
          editing = false
          pendingReply = nil
          showingReplies = true
        }.accessibilityIdentifier("quick-reply-open")
        Button("保存为快捷回复") {
          replySnapshot = session.terminalDrafts[terminalID] ?? ""
          editing = false
          savingReply = true
        }.disabled(!hasText)
      } label: {
        Image(systemName: "text.badge.plus").frame(width: 44, height: 44)
      }
      .accessibilityLabel("快捷回复")
      .accessibilityIdentifier("terminal-quick-replies")
      .disabled(preventsDismissal || state.snapshot.inputBusy)
      Spacer(minLength: 0)
      if editing {
        Button {
          editing = false
        } label: {
          Image(systemName: "keyboard.chevron.compact.down")
        }.accessibilityLabel("收起键盘")
      }
      voice
      sendButton
    }
    .buttonStyle(TerminalControlButtonStyle())
    .foregroundColor(.secondary)
  }

  private var sendButton: some View {
    Button(action: submit) {
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

  private func selectReply(_ item: LocalQuickReply) {
    guard session.terminal?.id == terminalID, session.terminalController === controller else { return }
    pendingReply = item
    showingReplies = false
  }

  private func insertReply(append: Bool) {
    defer { pendingReply = nil; editing = true }
    guard let item = pendingReply, session.terminal?.id == terminalID,
      session.terminalController === controller else { return }
    let previous = session.terminalDrafts[terminalID] ?? ""
    session.setDraft(
      append && !previous.isEmpty ? previous + "\n" + item.body : item.body,
      terminalID: terminalID, suppressQuickInputHistory: true)
  }

  private func submit() {
    guard session.terminal?.id == terminalID, session.terminalController === controller,
      session.canWrite, controller.canSend, !stopping else { return }
    failure = nil
    // Presentation is a deduplicated snapshot; actions always validate the current source state.
    let draft = session.terminalDrafts[terminalID] ?? ""
    let stop = session.isCommandActive(terminalID)
      && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty
    if !stop {
      editing = false
      showingShortcuts = false
    }
    session.recordUserAction(stop ? "composer.stop" : "composer.send", terminalID: terminalID)
    if stop { stopping = true }
    Task {
      defer { stopping = false }
      do {
        if stop {
          try await session.stopCommand(terminalID)
        } else {
          try await session.sendCommand(terminalID: terminalID)
        }
        onActionSucceeded()
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
