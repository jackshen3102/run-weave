import SwiftUI

struct TerminalComposerSheet: View {
  @EnvironmentObject private var quickReplies: LocalQuickReplyStore
  @ObservedObject var session: AppSession
  @ObservedObject var controller: SessionController
  let terminalID: String
  @Binding var preventsDismissal: Bool
  @Environment(\.dismiss) private var dismiss

  private var busy: Bool { preventsDismissal || quickReplies.saving }

  var body: some View {
    NavigationView {
      ComposerView(
        session: session, controller: controller, terminalID: terminalID, active: true,
        preventsDismissal: $preventsDismissal, onActionSucceeded: { dismiss() })
        .navigationTitle("输入终端")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("关闭") { dismiss() }.disabled(busy)
          }
        }
    }
    .navigationViewStyle(.stack)
    .interactiveDismissDisabled(busy)
    .modifier(TerminalComposerPresentation())
  }
}

private struct TerminalComposerPresentation: ViewModifier {
  @ViewBuilder func body(content: Content) -> some View {
    if #available(iOS 16.0, *) {
      content
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    } else {
      content
    }
  }
}

struct ComposerView: View {
  @ObservedObject var session: AppSession
  @ObservedObject var controller: SessionController
  @ObservedObject private var imageDrafts: TerminalImageDrafts
  let terminalID: String
  var active = true
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
  @ScaledMetric(relativeTo: .body) private var inputHeight = 144.0

  init(
    session: AppSession, controller: SessionController, terminalID: String, active: Bool = true,
    preventsDismissal: Binding<Bool>, onActionSucceeded: @escaping () -> Void
  ) {
    self.session = session
    self.controller = controller
    self.terminalID = terminalID
    self.active = active
    self.imageDrafts = session.imageDrafts
    _preventsDismissal = preventsDismissal
    self.onActionSucceeded = onActionSucceeded
  }

  private var images: [TerminalDraftImage] { imageDrafts.images[terminalID] ?? [] }
  private var hasContent: Bool { hasText || !images.isEmpty }
  private var sendDisabled: Bool {
    !session.canWrite || !controller.canSend || stopping
      || (!showStop && (!hasContent || images.contains { $0.path == nil }))
  }
  private var hasText: Bool {
    !(session.terminalDrafts[terminalID] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      .isEmpty
  }
  private var showStop: Bool { session.isCommandActive(terminalID) && !hasContent }
  private var actionLabel: String {
    showStop ? (stopping ? "停止中…" : "停止") : (controller.inputBusy ? "发送中…" : "发送")
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
          }.font(.caption).disabled(!session.canWrite)
        }
      #endif
      Text(targetLabel).font(.caption).foregroundColor(.secondary).lineLimit(2)
      if controller.inputBusy {
        Text("正在等待电脑确认；关闭面板不会撤回已发送内容，也不会自动重发。")
          .font(.caption).foregroundColor(.secondary)
      }
      if showingShortcuts {
        ShortcutBar(controller: controller, enabled: session.canWrite)
      }
      if let failure { Text(failure).font(.caption).foregroundColor(.red) }
      VStack(alignment: .leading, spacing: 4) {
        ComposerImageAttachments(drafts: imageDrafts, session: session, terminalID: terminalID)
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
    .padding(16)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(TerminalAppearance.background.ignoresSafeArea())
    .background {
      NavigationLink(isActive: $showingReplies) {
        QuickReplyLibraryView(onSelect: selectReply)
      } label: { EmptyView() }.hidden()
      NavigationLink(isActive: $savingReply) {
        QuickReplyEditorView(initialBody: replySnapshot)
      } label: { EmptyView() }.hidden()
    }
    .onChange(of: showingReplies) { showing in
      if !showing {
        confirmingInsertion = pendingReply != nil
        if pendingReply == nil { editing = true }
      }
    }
    .onChange(of: savingReply) { showing in if !showing { editing = true } }
    .confirmationDialog("输入框已有文字", isPresented: $confirmingInsertion, titleVisibility: .visible) {
      Button("追加到末尾") { insertReply(append: true) }
      Button("替换文字", role: .destructive) { insertReply(append: false) }
      Button("取消", role: .cancel) { pendingReply = nil; editing = true }
    } message: {
      Text("只修改当前输入框，图片附件保留；不会直接发送。")
    }
  }

  private var targetLabel: String {
    let terminal = session.overview?.sessions.first { $0.id == terminalID }
    let project = session.overview?.projects.first {
      $0.id == HomeOverview.parentProjectID(session.terminal?.projectId ?? "")
    }
    return [session.connection?.name, project?.name, terminal?.title ?? terminalID]
      .compactMap { $0 }.joined(separator: " · ")
  }

  private var inputCard: some View {
    MediaControls(
      session: session, terminalID: terminalID, visible: active && !showingReplies && !savingReply,
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
      isFocused: $editing
    )
    .frame(height: verticalSizeClass == .compact ? 88 : inputHeight)
    .overlay(alignment: .topLeading) {
      if (session.terminalDrafts[terminalID] ?? "").isEmpty {
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
      .disabled(preventsDismissal || controller.inputBusy)
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
        if stopping || controller.inputBusy {
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
    if (session.terminalDrafts[terminalID] ?? "").isEmpty { insertReply(append: false) }
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
    failure = nil
    let stop = showStop
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
