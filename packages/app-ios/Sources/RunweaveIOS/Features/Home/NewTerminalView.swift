import SwiftUI

struct NewTerminalView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  let project: TerminalProject
  let create: (String) -> Void
  @State private var contexts: [TerminalProjectContext] = []
  @State private var selection = ""
  @State private var loading = true
  @State private var loadedGeneration: Int?
  @State private var failure: String?

  private var selected: TerminalProjectContext? { contexts.first { $0.id == selection } }

  var body: some View {
    NavigationView {
      List {
        Section {
          Text(project.name).font(.headline)
        } footer: {
          Text("选择新终端的工作目录。")
        }
        if loading { ProgressView("正在读取工作目录…") }
        if let failure {
          Section {
            Text(failure).foregroundColor(.red)
            Button("重新加载") { Task { await load() } }.disabled(loading)
          }
        }
        if !contexts.isEmpty {
          Section("工作目录") {
            ForEach(contexts.filter(\.isPrimary) + contexts.filter { !$0.isPrimary }) { context in
              Button { selection = context.id } label: {
                HStack {
                  VStack(alignment: .leading, spacing: 4) {
                    Text(context.isPrimary ? "主项目" : context.name).foregroundColor(.primary)
                    if let branch = context.branch {
                      Label(branch, systemImage: "arrow.triangle.branch")
                        .font(.caption).foregroundColor(.secondary)
                    }
                    Text(context.path ?? "默认主目录").font(.caption2).foregroundColor(.secondary)
                    if !context.canCreateTerminal {
                      Text(context.availability == "missing" ? "Worktree 已移除" : "工作目录不可用")
                        .font(.caption).foregroundColor(.orange)
                    }
                  }
                  Spacer()
                  if selection == context.id { Image(systemName: "checkmark").foregroundColor(.accentColor) }
                }.contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .disabled(!context.canCreateTerminal || loading)
              .accessibilityIdentifier("new-terminal-context-" + context.id)
              .accessibilityAddTraits(selection == context.id ? .isSelected : [])
            }
          }
        }
      }
      .navigationTitle("新建终端").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("创建") {
            guard loadedGeneration == session.generation, session.canWrite,
              let selected, selected.canCreateTerminal else { return }
            create(selected.id)
          }.disabled(loading || failure != nil || loadedGeneration != session.generation
            || !session.canWrite || selected?.canCreateTerminal != true)
        }
      }
      .task(id: session.generation) { await load() }
    }.navigationViewStyle(.stack)
  }

  private func load() async {
    let epoch = session.generation
    contexts = []
    loadedGeneration = nil
    loading = true
    failure = nil
    defer { if epoch == session.generation { loading = false } }
    do {
      guard let api = session.api else { throw APIError.offline }
      let values = try await api.projectContexts(parentProjectID: project.id)
      guard epoch == session.generation, !Task.isCancelled else { return }
      contexts = values
      selection = values.first { $0.id == selection && $0.canCreateTerminal }?.id
        ?? values.first { $0.isPrimary && $0.canCreateTerminal }?.id ?? ""
      loadedGeneration = epoch
    } catch {
      guard epoch == session.generation, !Task.isCancelled else { return }
      failure = displayError(error)
    }
  }
}
