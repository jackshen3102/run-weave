import SwiftUI

/// Only the entry label observes polling, keeping the open main editor and UIKit menus intact.
struct SideChatComposerLabel: View {
  @ObservedObject var model: SideChatModel
  var body: some View {
    Label(model.unread ? "旁聊 · 新回复" : "旁聊", systemImage: "bubble.left.and.bubble.right")
      .font(.caption)
  }
}
