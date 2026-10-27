import SwiftUI

struct TerminalStopButton: View {
  let stopping: Bool
  let canWrite: Bool
  let stop: () -> Void

  var body: some View {
    Button(action: stop) {
      Group {
        if stopping { ProgressView().tint(.red) }
        else { Image(systemName: "stop.fill") }
      }
      .frame(width: 64, height: 48).foregroundColor(.red).contentShape(Rectangle())
    }
    .accessibilityLabel(stopping ? "停止中…" : "停止执行")
    .accessibilityIdentifier("terminal-floating-stop")
    .disabled(stopping || !canWrite)
  }
}
