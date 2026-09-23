import SwiftUI

struct ScheduledRunView: View {
  @ObservedObject var session: AppSession
  @ObservedObject var model: ScheduledTasksModel
  let run: ScheduledRun
  let highlighted: Bool
  @State private var expanded = false
  @State private var text = ""
  @State private var cursor: String?
  @State private var failure: String?
  @State private var opening = false
  @State private var stopping = false
  @State private var confirmStop = false
  @State private var confirmReplace = false
  @State private var operation: Task<Void, Never>?
  @State private var visible = false
  private var active: Bool { visible && session.foreground && session.health.status == .online && session.terminal == nil }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(scheduledDate(run.startedAt ?? run.scheduledFor, timezone: run.snapshot.schedule.timezone)).font(.headline)
        Spacer()
        Text(run.statusLabel).font(.caption).foregroundColor(run.outcome == "blocked" || run.status == "failed" ? .orange : .secondary)
      }
      Text("\(run.trigger == "manual" ? "手动运行" : "定时触发") · 配置版本 \(run.taskRevision)").font(.caption).foregroundColor(.secondary)
      if let summary = run.summary { Text(summary).font(.subheadline).textSelection(.enabled) }
      if run.status == "completed" && run.outcome == nil { Text("此历史记录未记录任务结果，请根据摘要确认。").font(.caption) }
      if let error = run.error { Text(error.code == "missed" ? "超过允许的延迟，已跳过" : error.message).font(.caption).foregroundColor(.orange) }
      if run.trigger == "scheduled" {
        Text("计划：\(scheduledDate(run.scheduledFor, timezone: run.snapshot.schedule.timezone))\n开始：\(scheduledDate(run.startedAt, timezone: run.snapshot.schedule.timezone))").font(.caption)
        if let dispatch = run.dispatch {
          Text("\(dispatch.catchUp ? "延迟执行 · " : "")调度延迟 \(Int(dispatch.latenessMs / 1000)) 秒").font(.caption)
          if let start = run.startedAt.flatMap(scheduledParseDate), let admitted = scheduledParseDate(dispatch.evaluatedAt) {
            Text("排队等待 \(max(0, Int(start.timeIntervalSince(admitted)))) 秒").font(.caption)
          }
          if let from = dispatch.coalescedFrom { Text("更早安排已合并忽略（从 \(scheduledDate(from)) 起）").font(.caption) }
        }
      }
      ForEach(Array(run.artifacts.enumerated()), id: \.offset) { _, artifact in
        if let raw = artifact.url, let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
          Link(artifact.label, destination: url)
        } else { Text(artifact.label + (artifact.text.map { "：" + $0 } ?? artifact.fileRef.map { "：" + $0 } ?? "")).font(.caption).textSelection(.enabled) }
      }
      DisclosureGroup("本次配置快照") {
        VStack(alignment: .leading, spacing: 8) {
          Text("\(run.snapshot.name) · \(run.snapshot.provider) · \(run.executionProjectId)")
          Text(run.snapshot.schedule.label)
          Text(run.snapshot.misfirePolicy.label)
          Text("模型：\(run.snapshot.model ?? "默认") · 推理：\(run.snapshot.effort ?? "默认") · \(run.snapshot.executionPolicy == "auto-review" ? "自动审批" : "仅沙箱")")
          Text(run.snapshot.prompt).textSelection(.enabled)
        }.font(.caption)
      }
      Button(expanded ? "收起输出" : run.active ? "查看运行进度" : "查看输出") { expanded.toggle() }.buttonStyle(.borderless)
      if expanded {
        ScrollView {
          Text(text.isEmpty ? "暂无输出" : text).font(.system(.caption, design: .monospaced))
            .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
        }.frame(maxHeight: 280).padding(8).background(Color.secondary.opacity(0.1)).cornerRadius(8)
      }
      if run.active {
        Button(stopping || run.status == "stopping" ? "等待执行进程退出…" : "停止本次运行", role: .destructive) { confirmStop = true }
          .buttonStyle(.borderless).disabled(!model.canWrite || stopping || run.status == "stopping")
      }
      if run.canOpen {
        Button(opening ? "正在恢复对话…" : "打开对话并继续追问") { open() }
          .buttonStyle(.borderless).disabled(opening || !active || !session.canWrite)
      }
      if run.terminalBinding?.attachmentState == "failed" { Text(run.terminalBinding?.error ?? "恢复失败，请重试").font(.caption).foregroundColor(.red) }
      if let failure { Text(failure).font(.caption).foregroundColor(.red) }
    }
    .padding(.vertical, 8)
    .listRowBackground(highlighted ? Color.accentColor.opacity(0.08) : Color.clear)
    .onAppear { visible = true }
    .onDisappear { visible = false; operation?.cancel() }
    .onChange(of: session.foreground) { if !$0 { operation?.cancel() } }
    .task(id: "\(active):\(expanded):\(run.status)") {
      guard active, expanded else { return }
      do {
        repeat {
          let page = try await model.call { try await $0.output(run.id, cursor: cursor) }
          try Task.checkCancellation()
          if page.nextCursor != cursor {
            text = String((text + page.text).suffix(262144)); cursor = page.nextCursor
          }
          if page.hasMore { continue }
          if !run.active { break }
          try await Task.sleep(nanoseconds: 3_000_000_000)
        } while !Task.isCancelled
      } catch { if !Task.isCancelled { failure = displayError(error) } }
    }
    .confirmationDialog("停止本次运行？", isPresented: $confirmStop, titleVisibility: .visible) {
      Button("停止运行", role: .destructive) {
        operation = Task {
          stopping = true; failure = nil
          defer { stopping = false }
          do { let _ = try await model.call { try await $0.stop(run.id) }; await model.refresh() }
          catch { if !Task.isCancelled { failure = displayError(error) } }
        }
      }
    } message: { Text("已经发生的文件或外部操作不会回滚。") }
    .confirmationDialog("原终端已用于另一个对话", isPresented: $confirmReplace, titleVisibility: .visible) {
      Button("为本次运行另开终端") { open(replace: true) }
    } message: { Text("保留原终端，为此历史记录恢复一个新终端。") }
  }
  private func open(replace: Bool = false) {
    guard !opening, active else { return }
    operation = Task {
      opening = true; failure = nil
      defer { opening = false }
      do {
        let opened = try await model.call { try await $0.open(run.id, replace: replace) }
        var state = opened.attachmentState
        var error = opened.error
        let deadline = Date().addingTimeInterval(90)
        while state != "ready" {
          if state == "failed" { throw ScheduledFailure(code: "restore_failed", message: error ?? "对话恢复失败，请重试。") }
          guard Date() < deadline else { throw ScheduledFailure(code: "restore_timeout", message: "对话尚未确认恢复，请稍后重试打开同一记录。") }
          try await Task.sleep(nanoseconds: 3_000_000_000)
          let latest = try await model.call { try await $0.run(run.id) }
          guard let binding = latest.terminalBinding, binding.terminalSessionId == opened.terminalSessionId, binding.panelId == opened.panelId else {
            throw ScheduledFailure(code: "binding_changed", message: "终端绑定已变化，请重新打开此记录。")
          }
          state = binding.attachmentState; error = binding.error
        }
        try Task.checkCancellation()
        guard active, model.current else { return }
        await session.openTerminal(opened.terminalSessionId)
        if session.terminal?.id != opened.terminalSessionId { failure = session.error ?? "未能打开终端，请重试。" }
      } catch let error as ScheduledFailure where error.code == "terminal_repurposed" {
        if active, !Task.isCancelled { confirmReplace = true }
      } catch { if !Task.isCancelled { failure = displayError(error) } }
    }
  }
}
