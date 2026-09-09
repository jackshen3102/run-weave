import SwiftUI

struct TerminalComposerSheet: View {
  @ObservedObject var session: AppSession
  @ObservedObject var controller: SessionController
  let terminalID: String
  @Binding var preventsDismissal: Bool
  @Environment(\.dismiss) private var dismiss

  private var busy: Bool { preventsDismissal || controller.inputBusy }

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
  }

  private var inputCard: some View {
    MediaControls(
      session: session, terminalID: terminalID, visible: active,
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
        }
      }
    }
  }
}
