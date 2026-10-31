import SwiftUI

struct TerminalSideChatButton: View {
  @ObservedObject var sideChat: SideChatModel

  var body: some View {
    Button { Task { await sideChat.open() } } label: {
      Image(systemName: "bubble.left.and.bubble.right")
        .frame(width: 44, height: 48).contentShape(Rectangle())
        .overlay(alignment: .topTrailing) {
          if sideChat.unread {
            Circle().fill(TerminalAppearance.accent).frame(width: 7, height: 7)
              .padding(.top, 6).padding(.trailing, 2)
          }
        }
    }
    .accessibilityLabel(sideChat.unread ? "旁聊 · 新回复" : "旁聊")
    .accessibilityIdentifier("side-chat-open").disabled(sideChat.loading)
  }
}
