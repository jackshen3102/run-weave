import SwiftUI

struct ConversationReaderButton: View {
  @Binding var expectedTarget: TerminalConversation.Target?
  @Binding var isPresented: Bool

  var body: some View {
    Button {
      expectedTarget = nil
      isPresented = true
    } label: {
      Image(systemName: "book").frame(width: 44, height: 48).contentShape(Rectangle())
    }
    .accessibilityLabel("会话阅读").accessibilityIdentifier("terminal-conversation-open")
  }
}
