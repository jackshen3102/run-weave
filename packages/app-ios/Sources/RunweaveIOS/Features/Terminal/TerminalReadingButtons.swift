import SwiftUI

struct TerminalReadingButtons: View {
  @ObservedObject var sideChat: SideChatModel
  @Binding var expectedTarget: TerminalConversation.Target?
  @Binding var isPresented: Bool

  var body: some View {
    if sideChat.capabilities != nil {
      TerminalSideChatButton(sideChat: sideChat)
    }
    Button {
      expectedTarget = nil
      isPresented = true
    } label: {
      Image(systemName: "book").frame(width: 44, height: 48).contentShape(Rectangle())
    }
    .accessibilityLabel("会话阅读").accessibilityIdentifier("terminal-conversation-open")
  }
}
