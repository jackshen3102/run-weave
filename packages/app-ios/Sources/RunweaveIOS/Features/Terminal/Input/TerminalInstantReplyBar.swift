import SwiftUI

private struct InstantReply: Identifiable {
  let id: String
  let text: String
}

struct TerminalInstantReplyBar: View {
  private let replies = [
    InstantReply(id: "yes", text: "可以"),
    InstantReply(id: "continue", text: "继续"),
    InstantReply(id: "decline", text: "不需要"),
  ]
  let enabled: Bool
  let sending: Bool
  let send: (String) -> Void
  let close: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      ForEach(replies) { reply in
        Button { send(reply.text) } label: {
          HStack(spacing: 8) {
            Text(reply.text).font(.subheadline.weight(.medium))
            Image(systemName: "return").font(.caption)
          }
          .frame(maxWidth: .infinity, minHeight: 44)
          .background(TerminalAppearance.accent.opacity(0.14))
          .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .accessibilityLabel("发送“\(reply.text)”")
        .accessibilityHint("立即发送并回车，保留输入草稿")
        .accessibilityIdentifier("terminal-instant-reply-\(reply.id)")
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
      }
      Button(action: close) {
        Image(systemName: "chevron.down").frame(width: 44, height: 44)
      }
      .foregroundColor(.secondary)
      .accessibilityLabel("收起一键回复")
      .accessibilityIdentifier("terminal-instant-replies-close")
    }
    .buttonStyle(.plain)
    .foregroundColor(TerminalAppearance.accent)
    .padding(.horizontal, 16).padding(.vertical, 8)
    .background(TerminalAppearance.background)
    .overlay(alignment: .top) {
      Rectangle().fill(TerminalAppearance.border).frame(height: 0.5)
    }
    .accessibilityValue(sending ? "发送中" : "")
  }
}
