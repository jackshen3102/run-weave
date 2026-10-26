import SwiftUI

struct MoveTerminalView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  let terminal: HomeTerminal
  let moved: (String) -> Void
  @State private var target = ""
  @State private var busy = false
  @State private var failure: String?

  private var targets: [TerminalProject] {
    session.overview?.projects.filter { $0.id != terminal.projectId } ?? []
  }

  var body: some View {
    NavigationView {
      Form {
        Section {
          Picker("目标项目", selection: $target) {
            Text("选择项目").tag("")
            ForEach(targets) { project in Text(project.name).tag(project.id) }
          }
        } footer: {
          Text("仅改变终端所属项目，保留正在运行的进程、对话、分屏和当前目录。")
        }
        if let failure { Text(failure).foregroundColor(.red) }
      }
      .disabled(busy)
      .navigationTitle("移动终端").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("取消") { dismiss() }.disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(busy ? "移动中…" : "移动") {
            busy = true
            Task {
              do {
                try await session.updateTerminal(terminal.id, change: .project(target))
                moved(target)
                dismiss()
              } catch { failure = displayError(error) }
              busy = false
            }
          }.disabled(busy || !session.canEditTerminal(terminal.id) || !targets.contains { $0.id == target })
        }
      }
    }.navigationViewStyle(.stack).interactiveDismissDisabled(busy)
  }
}
