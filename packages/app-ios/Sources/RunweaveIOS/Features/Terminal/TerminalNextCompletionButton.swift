import SwiftUI

struct TerminalNextCompletionButton: View {
  @ObservedObject var session: AppSession

  private var count: Int { session.nextCompletionTerminals.count }

  var body: some View {
    if count > 0 {
      Rectangle().fill(TerminalAppearance.border)
        .frame(width: 0.5, height: 20).padding(.horizontal, 4)
        .accessibilityHidden(true)
      Button {
        Task { await session.openNextCompletion() }
      } label: {
        Text(String(count)).font(.system(size: 20, weight: .semibold)).monospacedDigit()
          .padding(.horizontal, 8).frame(minWidth: 44, minHeight: 48)
          .contentShape(Rectangle())
      }
      .accessibilityLabel("下一个待接管终端")
      .accessibilityValue("剩余 \(count) 个")
      .accessibilityIdentifier("terminal-next-completion")
      .disabled(!session.canWrite || session.openingNextCompletion)
    }
  }
}
