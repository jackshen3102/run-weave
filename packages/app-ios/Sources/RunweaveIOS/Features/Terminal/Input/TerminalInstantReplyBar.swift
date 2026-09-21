import SwiftUI

struct TerminalInstantReplyBar: View {
  let enabled: Bool
  let sending: Bool
  let send: (String) -> Void
  let close: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      ForEach(["可以", "继续"], id: \.self) { text in
        Button { send(text) } label: {
          HStack(spacing: 8) {
            Text(text).font(.subheadline.weight(.medium))
            Image(systemName: "return").font(.caption)
          }
          .frame(maxWidth: .infinity, minHeight: 44)
          .background(TerminalAppearance.accent.opacity(0.14))
          .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .accessibilityLabel("发送“\(text)”")
        .accessibilityHint("立即发送并回车，保留输入草稿")
        .accessibilityIdentifier(text == "可以" ? "terminal-instant-reply-yes" : "terminal-instant-reply-continue")
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
