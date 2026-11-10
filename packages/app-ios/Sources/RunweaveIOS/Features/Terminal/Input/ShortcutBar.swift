import SwiftUI

struct ShortcutBar: View {
  let enabled: Bool
  let send: (String) -> Void
  private let keys = [
    ("Ctrl-C", "\u{03}"), ("Tab", "\t"), ("Esc", "\u{1b}"),
    ("↑", "\u{1b}[A"), ("↓", "\u{1b}[B"), ("Enter", "\r"),
  ]

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ForEach(keys, id: \.0) { key in
          Button(key.0 == "Ctrl-C" ? "^C" : key.0 == "Enter" ? "↵" : key.0) {
            send(key.1)
          }
          .font(.system(.caption, design: .monospaced))
          .frame(minWidth: 44, minHeight: 44)
          .background(TerminalAppearance.panel)
          .clipShape(RoundedRectangle(cornerRadius: 9))
          .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(TerminalAppearance.border))
          .accessibilityLabel(key.0)
          .accessibilityIdentifier("terminal-shortcut-\(key.0)")
        }
      }
    }
      .frame(height: 44)
      .buttonStyle(.plain).foregroundColor(.secondary)
      .disabled(!enabled)
  }
}
