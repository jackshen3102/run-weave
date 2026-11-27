import SwiftUI

struct NewWorktreeView: View {
  @ObservedObject var session: AppSession
  let parent: String
  let opened: (WorktreeCreation) -> Void
  @State private var preview: WorktreeCreatePreview?
  @State private var name = ""
  @State private var branch = ""
  @State private var base = ""
  @State private var agent = "none"
  @State private var existing = false
  @State private var approved = false
  @State private var busy = false
  @State private var failure: String?
  @State private var loadedGeneration: Int?
  @State private var operation = UUID()
  @State private var lastFields: [String] = []

  var body: some View {
    Form {
      if let preview {
        Section("工作目录") {
          TextField("目录名", text: $name)
          TextField("分支（默认与目录同名）", text: $branch)
          Toggle("检出现有本地分支", isOn: $existing)
          if !existing { TextField("基准引用", text: $base) }
        }.textInputAutocapitalization(.never).autocorrectionDisabled()
        Picker("创建后启动", selection: $agent) {
          Text("Shell").tag("none")
          ForEach(["codex", "claude", "pi", "traex", "agy"], id: \.self) { Text($0).tag($0) }
        }
        if let setup = preview.setup {
          Section("初始化命令 · " + setup.cwd) {
            Text(setup.command).font(.body.monospaced()).textSelection(.enabled)
            Text("SHA-256 " + setup.revision).font(.caption.monospaced()).textSelection(.enabled)
            Toggle("信任并运行此版本", isOn: $approved)
          }
        }
        Button(busy ? "创建中…" : "创建 Worktree") { Task { await submit() } }
          .disabled(name.isEmpty || (!existing && base.isEmpty) || !session.canWrite || loadedGeneration != session.generation)
      } else if failure == nil { ProgressView("正在读取配置…") }
      if let failure {
        Text(failure).foregroundColor(.red)
        if preview == nil { Button("重新加载") { Task { await load() } } }
      }
    }.disabled(busy)
      .navigationTitle("新建 Worktree")
      .navigationBarBackButtonHidden(busy)
      .interactiveDismissDisabled(busy)
      .task(id: session.generation) { await load() }
  }

  private func load() async {
    let epoch = session.generation
    preview = nil
    loadedGeneration = nil
    approved = false
    failure = nil
    do {
      guard let api = session.api else { throw APIError.offline }
      let value = try await api.previewWorktree(parent: parent)
      guard epoch == session.generation, !Task.isCancelled else { return }
      preview = value
      base = value.defaultBaseRef
      approved = value.setup?.approved ?? false
      loadedGeneration = epoch
    } catch { if epoch == session.generation { failure = displayError(error) } }
  }

  private func submit() async {
    let epoch = session.generation
    guard epoch == loadedGeneration, !busy, session.canWrite, let api = session.api else { return }
    let fields = [name, branch, base, agent, String(existing), approved ? preview?.setup?.revision ?? "" : ""]
    if fields != lastFields { operation = UUID(); lastFields = fields }
    busy = true
    failure = nil
    defer { busy = false }
    do {
      let value = try await api.createWorktree(parent: parent, operation: operation, name: name,
        branch: branch.isEmpty ? name : branch, base: base, existing: existing, agent: agent,
        approvedRevision: approved ? preview?.setup?.revision : nil)
      guard epoch == session.generation else { return }
      opened(value)
    } catch { if epoch == session.generation { failure = displayError(error) } }
  }
}
