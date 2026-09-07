import SwiftUI

struct RenameTerminalView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  let terminal: HomeTerminal
  @State private var name: String
  @State private var failure: String?
  @State private var busy = false

  init(session: AppSession, terminal: HomeTerminal) {
    self.session = session
    self.terminal = terminal
    _name = State(initialValue: terminal.alias ?? "")
  }

  var body: some View {
    NavigationView {
      Form {
        Section {
          TextField("自定义名称", text: $name)
          Text("留空保存可恢复自动名称，最多 80 个字符，部分符号占两个字符。")
            .font(.caption).foregroundColor(.secondary)
        }
        if let failure { Text(failure).foregroundColor(.red) }
      }
      .disabled(busy)
      .navigationTitle("重命名终端").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("取消") { dismiss() }.disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(busy ? "保存中…" : "保存") {
            let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard value.utf16.count <= 80 else {
              failure = "名称过长，请缩短后重试（最多 80 个字符，部分符号占两个字符）。"
              return
            }
            busy = true
            Task {
              do {
                try await session.updateTerminal(terminal.id, change: .alias(value.isEmpty ? nil : value))
                dismiss()
              } catch { failure = displayError(error) }
              busy = false
            }
          }.disabled(busy || !session.canEditTerminal(terminal.id))
        }
      }
    }.navigationViewStyle(.stack).interactiveDismissDisabled(busy)
  }
}
