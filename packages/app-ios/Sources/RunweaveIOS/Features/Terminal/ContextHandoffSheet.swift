import SwiftUI

struct ContextHandoffSheet: View {
  @ObservedObject var session: AppSession
  let terminalID: String
  @Environment(\.dismiss) private var dismiss
  @State private var preview: ContextHandoffPreview?
  @State private var agent = "codex"
  @State private var project = ""
  @State private var prompt = ""
  @State private var error = ""
  @State private var operationID = UUID().uuidString
  @State private var submit = true
  @State private var busy = false
  @State private var unknown = false
  @State private var epoch: Int?

  private var path: String { "/api/terminal/session/\(APIClient.pathComponent(terminalID))/agent/" }
  private var native: Bool { preview?.canNativeCodexFork == true && agent == "codex" && project == preview?.sourceProjectId }

  var body: some View {
    NavigationView {
      Form {
        if let preview {
          Section {
            Text("\(preview.sourceProvider) · \(preview.totalMessages) 条消息 · 保留 \(preview.includedTurns) 轮，部分保留 \(preview.partialTurns) 轮，省略 \(preview.omittedTurns) 轮")
            ProgressView(value: Double(preview.handoffBytes), total: Double(preview.budgetBytes))
            Text("\(preview.handoffBytes) / \(preview.budgetBytes) 字节")
          }
          Section {
            HandoffChoiceField(title: "目标 Agent", selection: $agent,
              options: ["codex", "claude", "pi", "traex", "agy"].map { .init(id: $0, name: $0) })
            HandoffChoiceField(title: "目标工作区", selection: $project,
              options: preview.targetProjects.map { .init(id: $0.projectId, name: $0.name) })
            Text("附加指令")
            TextEditor(text: $prompt).frame(minHeight: 80)
            Toggle("自动提交首轮", isOn: $submit)
            if native { Text("将使用 Codex 原生 Fork 保留完整会话。") }
          }.disabled(unknown || busy)
          if prompt.utf8.count > 32768 { Text("附加指令超过 32 KiB。") }
          Button("交接") { Task { await send(preview) } }
            .disabled(busy || unknown || prompt.utf8.count > 32768 || !session.canWrite)
        } else if error.isEmpty { ProgressView("正在读取来源会话…") }
        if !error.isEmpty {
          Text(error)
          if preview == nil { Button("刷新预览") { Task { await load() } } }
        }
      }
      .navigationTitle("交接到新终端")
      .toolbar { Button("关闭") { dismiss() }.disabled(busy) }
    }
    .navigationViewStyle(.stack)
    .task { epoch = session.generation; await load() }
    .onChange(of: session.generation) { _ in dismiss() }
    .interactiveDismissDisabled(busy)
  }

  private func load() async {
    guard let api = session.api, epoch == session.generation else { return }
    do {
      let value: ContextHandoffPreview = try await api.authorized(path + "handoff-preview")
      guard epoch == session.generation, !Task.isCancelled else { return }
      preview = value
      if !value.targetProjects.contains(where: { $0.projectId == project }) { project = value.sourceProjectId }
      operationID = UUID().uuidString
      error = ""
    } catch { self.error = displayError(error) }
  }

  private func send(_ source: ContextHandoffPreview) async {
    guard !busy, !unknown, epoch == session.generation, session.canEditTerminal(terminalID), let api = session.api else { return }
    busy = true
    defer { busy = false }
    var created: String?
    do {
      let result: ContextHandoffResult = try await api.authorized(path + "handoff", method: "POST", body: [
        "operationId": operationID, "panelId": source.sourcePanelId, "expectedThreadId": source.sourceThreadId,
        "expectedSourceRevision": source.sourceRevision, "targetAgent": agent, "targetProjectId": project,
        "mode": native ? "native_fork" : "portable_handoff", "prompt": prompt, "submitPrompt": submit
      ], retryUnauthorized: false, requestTimeout: 100, decodeError: { status, data in
        guard status < 500 else { return nil }
        return try? JSONDecoder().decode(TerminalAgentForkFailure.self, from: data)
      })
      created = result.terminalSessionId
    } catch let failure as TerminalAgentForkFailure {
      created = failure.details?.terminalSessionId
      error = failure.message
      if created == nil { preview = nil }
    } catch {
      unknown = true
      self.error = "交接结果未确认，请关闭此窗口并核对终端列表。"
    }
    guard let created, epoch == session.generation, session.foreground else { return }
    if !error.isEmpty { session.error = error }
    dismiss()
    await session.reload()
    guard epoch == session.generation, session.foreground else { return }
    await session.openTerminal(created)
  }
}

private struct HandoffChoiceField: View {
  struct Option: Identifiable { let id, name: String }

  let title: String
  @Binding var selection: String
  let options: [Option]
  @State private var expanded = false

  var body: some View {
    Button {
      expanded.toggle()
    } label: {
      HStack {
        Text(title)
        Spacer()
        Text(options.first { $0.id == selection }?.name ?? "").foregroundColor(.secondary)
        Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    if expanded {
      ForEach(options) { option in
        Button {
          selection = option.id
          expanded = false
        } label: {
          HStack {
            Text(option.name)
            Spacer()
            if selection == option.id { Image(systemName: "checkmark") }
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selection == option.id ? .isSelected : [])
      }
    }
  }
}
