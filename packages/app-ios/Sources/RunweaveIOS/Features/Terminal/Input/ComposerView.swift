import SwiftUI

struct ComposerView: View {
  @ObservedObject var session: AppSession
  @ObservedObject var controller: SessionController
  @ObservedObject private var imageDrafts: TerminalImageDrafts
  let terminalID: String
  var active = true
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @State private var failure: String?
  @State private var stopping = false
  @State private var showingShortcuts = false
  @State private var editing = false
  @ScaledMetric(relativeTo: .body) private var inputHeight = 60.0

  init(session: AppSession, controller: SessionController, terminalID: String, active: Bool = true)
  {
    self.session = session
    self.controller = controller
    self.terminalID = terminalID
    self.active = active
    self.imageDrafts = session.imageDrafts
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
      if editing && showingShortcuts {
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
    .padding(.horizontal, 12).padding(.vertical, 8)
    .background(TerminalAppearance.background)
    .overlay(alignment: .top) { Rectangle().fill(TerminalAppearance.border).frame(height: 0.5) }
  }

  private var inputCard: some View {
    MediaControls(session: session, terminalID: terminalID, visible: active) { attachment, voice in
      if #available(iOS 16.0, *) {
        ComposerLayout(expanded: editing) {
          editor
          attachment
          controls(voice: voice)
        }
      } else {
        VStack(spacing: 2) {
          editor
          HStack(spacing: 2) {
            attachment
            controls(voice: voice)
          }
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
    .frame(height: editing && verticalSizeClass != .compact ? inputHeight : 36)
    .overlay(alignment: .topLeading) {
      if (session.terminalDrafts[terminalID] ?? "").isEmpty {
        Text(editing ? "输入命令或告诉 Agent 要做什么…" : "输入命令…")
          .lineLimit(editing ? nil : 1)
          .font(.body).foregroundColor(.secondary)
          .padding(.horizontal, 5).padding(.top, 8)
          .allowsHitTesting(false).accessibilityHidden(true)
      }
    }
  }

  private func controls(voice: AnyView) -> some View {
    HStack(spacing: 2) {
      if editing {
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
      }
      if editing { Spacer(minLength: 0) }
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
      } catch {
        if !(error is CancellationError) {
          failure = stop ? displayError(error) : displayInputError(error)
        }
      }
    }
  }
}

/// Keeps the text view mounted while the editor moves between one and two rows.
@available(iOS 16.0, *)
private struct ComposerLayout: Layout {
  let expanded: Bool
  private let gap = 4.0

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? 320
    let controls = subviews[2].sizeThatFits(.unspecified)
    let editorWidth = expanded ? width : max(0, width - 44 - controls.width - gap * 2)
    let editor = subviews[0].sizeThatFits(ProposedViewSize(width: editorWidth, height: nil))
    return CGSize(
      width: width, height: expanded ? editor.height + gap + 44 : max(editor.height, 44))
  }

  func placeSubviews(
    in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) {
    let controlsWidth =
      expanded
      ? bounds.width - 44 - gap
      : subviews[2].sizeThatFits(.unspecified).width
    let editorWidth = expanded ? bounds.width : max(0, bounds.width - 44 - controlsWidth - gap * 2)
    let editorSize = subviews[0].sizeThatFits(ProposedViewSize(width: editorWidth, height: nil))
    subviews[0].place(
      at: CGPoint(
        x: expanded ? bounds.minX : bounds.minX + 44 + gap,
        y: expanded ? bounds.minY : bounds.midY - editorSize.height / 2),
      proposal: ProposedViewSize(width: editorWidth, height: editorSize.height))
    let controlsY = expanded ? bounds.maxY - 44 : bounds.midY - 22
    subviews[1].place(
      at: CGPoint(x: bounds.minX, y: controlsY), proposal: ProposedViewSize(width: 44, height: 44))
    subviews[2].place(
      at: CGPoint(x: bounds.maxX - controlsWidth, y: controlsY),
      proposal: ProposedViewSize(width: controlsWidth, height: 44))
  }
}
