import SwiftUI

struct TerminalComposerButton: View {
  let hasDraft: Bool
  var unconfirmedInput = false
  let open: () -> Void

  var body: some View {
    Button(action: open) {
      Image(systemName: "square.and.pencil")
        .font(.system(size: 26, weight: .medium))
        .frame(width: 44, height: 48).contentShape(Rectangle())
        .overlay(alignment: .topTrailing) {
          if hasDraft {
            Circle().fill(Color.orange).frame(width: 7, height: 7)
              .padding(.top, 6).padding(.trailing, 2)
          }
        }
    }
    .accessibilityLabel("打开终端输入")
    .accessibilityValue(unconfirmedInput ? "草稿的发送结果未确认" : (hasDraft ? "有未发送草稿" : "无草稿"))
    .accessibilityIdentifier("terminal-composer-open")
  }
}
