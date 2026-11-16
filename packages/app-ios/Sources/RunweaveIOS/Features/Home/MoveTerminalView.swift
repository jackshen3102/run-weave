import SwiftUI

struct MoveTerminalView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  @ObservedObject private var projects: HomeState.Projects
  @StateObject private var state: StateProjection<TerminalPresentationSnapshot>
  private let connectionScope: String?
  let terminal: HomeTerminal
  let moved: (String) -> Void
  @State private var target = ""
  @State private var busy = false
  @State private var failure: String?

  private var targets: [TerminalProject] {
    projects.values.filter { $0.id != state.value.projectID }
  }

  init(session: AppSession, terminal: HomeTerminal, moved: @escaping (String) -> Void) {
    self.session = session; self.terminal = terminal; self.moved = moved
    connectionScope = session.connection?.scope
    projects = session.home.projects
    _state = StateObject(wrappedValue: terminalPresentationState(session: session, terminalID: terminal.id))
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
            guard session.connection?.scope == connectionScope,
              session.home.terminal(terminal.id) != nil else { return }
            busy = true
            Task {
              do {
                try await session.updateTerminal(terminal.id, change: .project(target))
                moved(target)
                dismiss()
              } catch { failure = displayError(error) }
              busy = false
            }
          }.disabled(busy || (!session.canWrite || session.connection?.scope != connectionScope || state.value.metadataWriting || state.value.projectID == nil) || !targets.contains { $0.id == target })
        }
      }
    }.navigationViewStyle(.stack).interactiveDismissDisabled(busy)
  }
}
