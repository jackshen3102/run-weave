import SwiftUI

private let executePlanPrompt =
  "请先完整阅读上述计划文件，按计划在当前项目目录开始实施并完成验证。"

private struct HandoffPromptPreset: Identifiable {
  let id: String
  let label: String
  let prompt: String
}

private let handoffPromptPresets: [HandoffPromptPreset] = [
  .init(id: "plan", label: "按计划开始实施", prompt: executePlanPrompt),
  .init(id: "fix", label: "继续排查并修复", prompt: "请基于交接上下文在当前项目目录继续排查问题、完成修复并验证。"),
  .init(id: "wait", label: "先读上下文等我确认", prompt: ""),
]

struct ContextHandoffSheet: View {
  @ObservedObject var session: AppSession
  let terminalID: String
  @Environment(\.dismiss) private var dismiss
  @State private var preview: ContextHandoffPreview?
  @State private var agent = "codex"
  @State private var placement = "in_place"
  @State private var project = ""
  @State private var contextScope = "full_conversation"
  @State private var selectedPlanPaths: [String] = []
  @State private var prompt = ""
  @State private var error = ""
  @State private var operationID = UUID().uuidString
  @State private var submit = true
  @State private var busy = false
  @State private var unknown = false
  @State private var epoch: Int?
  @State private var agentTouched = false
  @State private var placementTouched = false
  @State private var promptTouched = false

  private var path: String { "/api/terminal/session/\(APIClient.pathComponent(terminalID))/agent/" }
  private var sameWorkspace: Bool { preview.map { project == $0.sourceProjectId } ?? true }
  private var canInPlace: Bool { (preview?.canInPlaceHandoff ?? false) && sameWorkspace }
  private var effectivePlacement: String { canInPlace ? placement : "new_terminal" }
  private var native: Bool {
    effectivePlacement == "new_terminal"
      && preview?.canNativeCodexFork == true
      && agent == "codex"
      && sameWorkspace
  }
  private var effectivePlanPaths: [String] { native ? [] : selectedPlanPaths }
  private var effectiveContextScope: String {
    !native && !effectivePlanPaths.isEmpty && contextScope == "plan_focused"
      ? "plan_focused"
      : "full_conversation"
  }
  private var inPlaceReason: String? {
    if let preview, !sameWorkspace { return "跨工作区交接仅支持交接到新终端" }
    if preview?.canInPlaceHandoff == false {
      return preview?.inPlaceUnavailableReason ?? "当前面板暂不支持原位切换，请改用交接到新终端"
    }
    return nil
  }

  var body: some View {
    NavigationView {
      Form {
        if let preview {
          Section {
            Text("\(preview.sourceProvider) · \(preview.totalMessages) 条消息 · 保留 \(preview.includedTurns) 轮，部分保留 \(preview.partialTurns) 轮，省略 \(preview.omittedTurns) 轮")
            ProgressView(value: Double(preview.handoffBytes), total: Double(preview.budgetBytes))
            Text("\(preview.handoffBytes) / \(preview.budgetBytes) 字节")
          }
          Section("切换方式") {
            let allowInPlace = preview.canInPlaceHandoff == true
            Picker("切换方式", selection: Binding(
              get: { effectivePlacement },
              set: { next in
                placementTouched = true
                placement = next
                if next == "in_place" { project = preview.sourceProjectId }
              }
            )) {
              Text("原位替换").tag("in_place")
              Text("交接到新终端").tag("new_terminal")
            }
            .pickerStyle(.segmented)
            .disabled(!allowInPlace)
            .accessibilityIdentifier("handoff-placement-picker")

            if effectivePlacement == "in_place" {
              Text("将在当前面板结束原 Agent 进程并在原项目目录启动目标 CLI，原会话仍保留在本地历史中；当前终端保持不变。")
                .font(.footnote)
                .foregroundColor(.secondary)
            } else if let reason = inPlaceReason {
              Text(reason)
                .font(.footnote)
                .foregroundColor(.orange)
            }
          }.disabled(unknown || busy)

          Section("目标") {
            HandoffChoiceField(
              title: "目标 Agent",
              selection: Binding(
                get: { agent },
                set: { next in
                  agentTouched = true
                  agent = next
                }
              ),
              options: ["codex", "claude", "pi", "traex", "agy"].map { .init(id: $0, name: $0) }
            )
            if effectivePlacement == "new_terminal", preview.targetProjects.count > 1 {
              HandoffChoiceField(
                title: "目标工作区",
                selection: Binding(
                  get: { project },
                  set: { next in
                    project = next
                    if next != preview.sourceProjectId {
                      placementTouched = true
                      placement = "new_terminal"
                    }
                  }
                ),
                options: preview.targetProjects.map { .init(id: $0.projectId, name: $0.name) }
              )
            }
            if native {
              Text("将使用 Codex 原生 Fork 保留完整会话。")
                .font(.footnote)
                .foregroundColor(.secondary)
            }
          }.disabled(unknown || busy)

          let detectedPlans = preview.detectedPlanFiles ?? []
          if !native, !detectedPlans.isEmpty {
            Section("原目录计划文件") {
              ForEach(detectedPlans) { file in
                let checked = selectedPlanPaths.contains(file.relativePath)
                Button {
                  togglePlanFile(file.relativePath)
                } label: {
                  HStack(spacing: 8) {
                    Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                      .foregroundColor(checked ? .accentColor : .secondary)
                    VStack(alignment: .leading, spacing: 2) {
                      Text(file.relativePath)
                        .font(.footnote.monospaced())
                        .lineLimit(2)
                      Text("\(file.source == "mentioned" ? "对话提及" : "最近计划") · \(formatBytes(file.sizeBytes))")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    }
                    Spacer()
                  }
                  .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("handoff-plan-\(file.relativePath)")
              }
              if !selectedPlanPaths.isEmpty {
                Picker("上下文范围", selection: $contextScope) {
                  Text("仅带计划与目标").tag("plan_focused")
                  Text("完整对话 + 计划").tag("full_conversation")
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("handoff-scope-picker")
              }
            }.disabled(unknown || busy)
          }

          Section("附加指令") {
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 8) {
                ForEach(handoffPromptPresets) { preset in
                  Button(preset.label) {
                    promptTouched = true
                    prompt = preset.prompt
                  }
                  .buttonStyle(.bordered)
                  .controlSize(.small)
                }
              }
              .padding(.vertical, 2)
            }
            TextEditor(text: Binding(
              get: { prompt },
              set: { next in
                promptTouched = true
                prompt = next
              }
            )).frame(minHeight: 80)
            Toggle("自动提交首轮", isOn: $submit)
            if prompt.utf8.count > 32768 {
              Text("附加指令超过 32 KiB。").foregroundColor(.red)
            }
          }.disabled(unknown || busy)

          Section {
            Button(busy
              ? (effectivePlacement == "in_place" ? "正在原位切换…" : "正在交接…")
              : (effectivePlacement == "in_place" ? "原位切换" : "交接到新终端")) {
              Task { await send(preview) }
            }
            .disabled(busy || unknown || prompt.utf8.count > 32768 || !session.canWrite)
            .accessibilityIdentifier("handoff-submit-button")
          }
        } else if error.isEmpty {
          ProgressView("正在读取来源会话…")
        }
        if !error.isEmpty {
          Text(error).foregroundColor(.red)
          if preview == nil { Button("刷新预览") { Task { await load() } } }
        }
      }
      .navigationTitle("换 Agent / 交接执行")
      .toolbar { Button("关闭") { dismiss() }.disabled(busy) }
    }
    .navigationViewStyle(.stack)
    .task { epoch = session.generation; await load() }
    .onChange(of: session.generation) { _ in dismiss() }
    .interactiveDismissDisabled(busy)
  }

  private func togglePlanFile(_ relativePath: String) {
    if let index = selectedPlanPaths.firstIndex(of: relativePath) {
      selectedPlanPaths.remove(at: index)
      if selectedPlanPaths.isEmpty { contextScope = "full_conversation" }
    } else {
      selectedPlanPaths.append(relativePath)
    }
  }

  private func formatBytes(_ bytes: Int) -> String {
    if bytes < 1024 { return "\(bytes) B" }
    return String(format: "%.1f KiB", Double(bytes) / 1024.0)
  }

  private func load() async {
    guard let api = session.api, epoch == session.generation else { return }
    do {
      let value: ContextHandoffPreview = try await api.authorized(
        path + "handoff-preview",
        decodeError: { status, data in
          guard status < 500 else { return nil }
          return try? JSONDecoder().decode(TerminalAgentForkFailure.self, from: data)
        }
      )
      guard epoch == session.generation, !Task.isCancelled else { return }
      preview = value
      if !agentTouched {
        agent = value.sourceProvider == "claude" ? "codex" : "claude"
      }
      if !value.targetProjects.contains(where: { $0.projectId == project }) {
        project = value.sourceProjectId
      }
      let allowInPlace = value.canInPlaceHandoff == true && project == value.sourceProjectId
      if !placementTouched {
        placement = allowInPlace ? "in_place" : "new_terminal"
      } else if !allowInPlace {
        placement = "new_terminal"
      }
      let detected = value.detectedPlanFiles ?? []
      let validExisting = selectedPlanPaths.filter { rel in
        detected.contains(where: { $0.relativePath == rel })
      }
      if !validExisting.isEmpty {
        selectedPlanPaths = validExisting
      } else if let first = detected.first {
        selectedPlanPaths = [first.relativePath]
      } else {
        selectedPlanPaths = []
      }
      contextScope = selectedPlanPaths.isEmpty ? "full_conversation" : "plan_focused"
      if !promptTouched, !selectedPlanPaths.isEmpty {
        prompt = executePlanPrompt
      }
      operationID = UUID().uuidString
      error = ""
    } catch { self.error = displayError(error) }
  }

  private func send(_ source: ContextHandoffPreview) async {
    guard !busy, !unknown, epoch == session.generation, session.canEditTerminal(terminalID), let api = session.api else { return }
    busy = true
    defer { busy = false }
    var created: String?
    var completedPlacement: String?
    do {
      let targetProjectID = effectivePlacement == "in_place" ? source.sourceProjectId : project
      let result: ContextHandoffResult = try await api.authorized(path + "handoff", method: "POST", body: [
        "operationId": operationID,
        "panelId": source.sourcePanelId,
        "expectedThreadId": source.sourceThreadId,
        "expectedSourceRevision": source.sourceRevision,
        "targetAgent": agent,
        "targetProjectId": targetProjectID,
        "mode": native ? "native_fork" : "portable_handoff",
        "placement": effectivePlacement,
        "contextScope": effectiveContextScope,
        "planFilePaths": effectivePlanPaths,
        "prompt": prompt,
        "submitPrompt": submit,
      ], retryUnauthorized: false, requestTimeout: 100, decodeError: { status, data in
        guard status < 500 else { return nil }
        return try? JSONDecoder().decode(TerminalAgentForkFailure.self, from: data)
      })
      created = result.terminalSessionId
      completedPlacement = result.placement ?? effectivePlacement
    } catch let failure as TerminalAgentForkFailure {
      created = failure.details?.terminalSessionId
      completedPlacement = failure.details?.placement ?? effectivePlacement
      error = failure.message
      if created == nil { preview = nil }
    } catch {
      unknown = true
      self.error = "交接结果未确认，请关闭此窗口并核对终端状态。"
    }
    guard let created, epoch == session.generation, session.foreground else { return }
    if !error.isEmpty { session.error = error }
    dismiss()
    await session.reload()
    guard epoch == session.generation, session.foreground else { return }
    if completedPlacement == "in_place" {
      await session.openTerminal(terminalID)
    } else {
      await session.openTerminal(created)
    }
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
