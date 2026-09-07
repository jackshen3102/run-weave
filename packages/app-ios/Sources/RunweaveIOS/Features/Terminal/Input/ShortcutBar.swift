import SwiftUI

struct ShortcutBar: View {
  @ObservedObject var controller: SessionController
  let enabled: Bool
  private let keys = [
    ("Ctrl-C", "\u{03}"), ("Tab", "\t"), ("Esc", "\u{1b}"),
    ("↑", "\u{1b}[A"), ("↓", "\u{1b}[B"), ("Enter", "\r"),
  ]

  var body: some View {
    HStack {
      ForEach(keys, id: \.0) { key in
        Button(key.0) { controller.sendRaw(key.1) }.frame(maxWidth: .infinity)
      }
    }.disabled(!enabled || !controller.canSend).padding(.horizontal)
  }
}
