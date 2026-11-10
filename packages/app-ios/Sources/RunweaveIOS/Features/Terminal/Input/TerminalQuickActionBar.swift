import SwiftUI

struct TerminalQuickActionBar: View {
  @Binding var mode: TerminalQuickActionMode
  @Binding var visible: Bool
  let enabled: Bool
  let sending: Bool
  let sendShortcut: (String) -> Void
  let sendReply: (String) -> Void

  var body: some View {
    HStack(spacing: 4) {
      if mode == .shortcuts {
        ShortcutBar(enabled: enabled, send: sendShortcut)
      } else {
        ScrollView(.horizontal, showsIndicators: false) {
          TerminalInstantReplyBar(enabled: enabled, sending: sending, send: sendReply)
        }
        .frame(height: 44)
      }
      Menu {
        Button {
          mode = mode == .shortcuts ? .replies : .shortcuts
        } label: {
          Label(mode == .shortcuts ? "切换到快捷回复" : "切换到快捷键",
            systemImage: mode == .shortcuts ? "bolt.fill" : "keyboard")
        }
        Button { visible = false } label: {
          Label("收起", systemImage: "chevron.down")
        }
      } label: {
        Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(Rectangle())
      }
      .accessibilityLabel("快捷操作")
      .accessibilityValue(mode == .shortcuts ? "快捷键" : "快捷回复")
      .accessibilityIdentifier("terminal-quick-actions-menu")
    }
    .padding(.horizontal, 8)
    .accessibilityIdentifier("terminal-quick-actions-bar")
  }

}

struct TerminalQuickActionsExpandButton: View {
  let mode: TerminalQuickActionMode
  let expand: () -> Void

  var body: some View {
    Button(action: expand) label: {
      Image(systemName: mode == .shortcuts ? "keyboard" : "bolt.fill")
        .frame(width: 44, height: 44)
    }
    .accessibilityLabel(mode == .shortcuts ? "展开快捷键" : "展开快捷回复")
    .accessibilityIdentifier("terminal-quick-actions-expand")
  }
}
