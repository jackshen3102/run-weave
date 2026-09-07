import SwiftUI

struct ShortcutBar: View {
  @ObservedObject var controller: SessionController
  let enabled: Bool
  private let keys = [
    ("Ctrl-C", "\u{03}"), ("Tab", "\t"), ("Esc", "\u{1b}"),
    ("↑", "\u{1b}[A"), ("↓", "\u{1b}[B"), ("Enter", "\r"),
  ]

  var body: some View {
    HStack(spacing: 6) {
      ForEach(keys, id: \.0) { key in
        Button(key.0 == "Ctrl-C" ? "^C" : key.0 == "Enter" ? "↵" : key.0) {
          controller.sendRaw(key.1)
        }
        .font(.system(.caption, design: .monospaced))
        .frame(maxWidth: .infinity, minHeight: 44)
        .background(TerminalAppearance.panel)
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(TerminalAppearance.border))
        .accessibilityLabel(key.0)
      }
    }.buttonStyle(.plain).foregroundColor(.secondary)
      .disabled(!enabled || !controller.canSend)
  }
}
