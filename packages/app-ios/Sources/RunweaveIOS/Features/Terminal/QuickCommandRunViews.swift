import Clarity
import MarkdownUI
import SwiftUI

extension ScheduledRun {
  var quickCommandProjectLabel: String {
    if let origin = snapshot.origin {
      return "\(origin.projectName) / \(origin.worktreeName ?? "主项目")"
    }
    return cwd
  }
}

struct QuickCommandRunRow: View {
  let run: ScheduledRun
  private var statusColor: Color { run.needsAttention || run.status == "queued" ? .orange : TerminalAppearance.accent }
  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: run.needsAttention ? "exclamationmark.triangle.fill" : run.status == "queued" ? "clock" : "play")
        .font(.system(size: 12)).frame(width: 28, height: 28)
        .foregroundColor(statusColor)
        .background(statusColor.opacity(0.08)).cornerRadius(8)
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
          Text(run.snapshot.name).font(.system(size: 14, weight: .medium)).foregroundColor(.primary).lineLimit(1)
          Spacer(minLength: 0)
          HStack(spacing: 3) {
            Text(run.statusLabel)
            if run.status == "running", let start = run.startedAt.flatMap(scheduledParseDate) {
              Text("·")
              Text(start, style: .relative)
            }
          }.font(.system(size: 11, weight: run.needsAttention ? .semibold : .regular)).foregroundColor(statusColor).lineLimit(1)
        }
        Text(run.quickCommandProjectLabel).font(.caption2).foregroundColor(.secondary).lineLimit(1)
        if run.needsAttention {
          Text(run.error?.message ?? "点按查看原因与输出")
            .font(.caption2).foregroundColor(.orange).lineLimit(1)
        }
      }
      Image(systemName: "chevron.right").font(.system(size: 10)).foregroundColor(.secondary)
    }.frame(minHeight: 70).padding(.horizontal, 8).padding(.vertical, run.needsAttention ? 4 : 0)
      .background(run.needsAttention ? Color.orange.opacity(0.08) : .clear).cornerRadius(10)
      .overlay(RoundedRectangle(cornerRadius: 10).stroke(run.needsAttention ? Color.orange.opacity(0.35) : .clear))
      .contentShape(Rectangle())
  }
}

struct QuickCommandRunsView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  @ObservedObject var model: BackendQuickInputModel
  let onOpenTerminal: () -> Void
  @State private var selectedRun: ScheduledRun?
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        Text("\(session.connection?.name ?? "当前电脑") · 所有项目").font(.caption).foregroundColor(.secondary)
        if let error = model.runFailure { Text(error).font(.caption).foregroundColor(.red) }
        if model.dashboardRuns.isEmpty { Text("暂无后台任务").font(.subheadline).foregroundColor(.secondary) }
        runList(model.dashboardRuns)
        if !model.recentRuns.isEmpty {
          Text("最近结果").font(.caption).foregroundColor(.secondary).padding(.top, 12)
          runList(model.recentRuns)
        }
      }.padding(16)
    }
    .background(TerminalAppearance.background)
    .navigationTitle("后台任务").navigationBarTitleDisplayMode(.inline)
    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("返回") { dismiss() } } }
    .refreshable { await model.refreshRuns(session) }
    .sheet(item: $selectedRun) { run in
      NavigationView {
        QuickCommandRunDetail(session: session, initial: run) {
          selectedRun = nil
          onOpenTerminal()
        }
      }
        .navigationViewStyle(.stack).tint(TerminalAppearance.accent)
    }
    .clarityMask().mobileAnalyticsScreen(.quickReplies)
  }

  private func runList(_ runs: [ScheduledRun]) -> some View {
    LazyVStack(spacing: 0) {
      ForEach(Array(runs.enumerated()), id: \.element.id) { index, run in
        if index > 0 { Divider() }
        Button { selectedRun = run } label: { QuickCommandRunRow(run: run) }
      }
    }.padding(.horizontal, runs.isEmpty ? 0 : 12)
      .background(TerminalAppearance.panel).cornerRadius(14).buttonStyle(.plain)
  }
}

struct QuickCommandRunDetail: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  @State private var run: ScheduledRun
  @State private var output = ""
  @State private var cursor: String?
  @State private var failure: String?
  @State private var stopping = false
  @State private var confirmStop = false
  @State private var opening = false
  @State private var openFailure: String?
  @State private var confirmReplace = false
  @State private var operation: Task<Void, Never>?
  private let onOpenTerminal: () -> Void
  private let generation: Int

  init(session: AppSession, initial: ScheduledRun, onOpenTerminal: @escaping () -> Void) {
    self.session = session
    self.onOpenTerminal = onOpenTerminal
    generation = session.generation
    _run = State(initialValue: initial)
  }
  private var polling: Bool {
    generation == session.generation && session.foreground && session.authenticated && session.health.status == .online
  }
  private var ownerUnresolved: Bool { run.status == "waiting" && run.error?.code == "owner_unresolved" }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Text(run.snapshot.name).font(.title2.weight(.semibold))
        Text("\(run.quickCommandProjectLabel)\n\(session.connection?.name ?? "当前电脑")")
          .font(.caption).foregroundColor(.secondary)
        HStack {
          Label(run.statusLabel, systemImage: run.needsAttention ? "exclamationmark.triangle.fill" : "clock")
            .foregroundColor(run.needsAttention ? .orange : TerminalAppearance.accent)
          Spacer()
          if run.status == "running", let start = run.startedAt.flatMap(scheduledParseDate) {
            Text(start, style: .relative).foregroundColor(.secondary)
          }
        }.font(.caption).padding(14).background(TerminalAppearance.panel).cornerRadius(12)
        if let summary = run.summary { Markdown(summary).markdownTheme(.gitHub).textSelection(.enabled) }
        if let error = run.error { Text(error.message).font(.caption).foregroundColor(.orange) }
        if run.active || ownerUnresolved {
          Text(ownerUnresolved ? "原执行进程尚未确认退出，暂时不能恢复对话。" : "运行结束后可打开对话；运行期间可在下方查看输出。")
            .font(.caption).foregroundColor(.secondary)
        } else {
          if !run.canOpen {
            Text("本次运行没有可恢复的对话。可在相同项目和工作区新建终端查看问题，运行输出仍保留在此处。")
              .font(.caption).foregroundColor(.secondary)
          }
          Button(opening ? (run.canOpen ? "正在恢复对话…" : "正在新建终端…") : (run.canOpen ? "打开对话并继续追问" : "新建项目终端")) { openTerminal() }
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(TerminalAppearance.accent.opacity(0.08)).cornerRadius(10)
            .disabled(opening || !polling || !session.canWrite)
            .accessibilityIdentifier("quick-command-run-open-terminal")
        }
        if let openFailure { Text(openFailure).font(.caption).foregroundColor(.red) }
        Text("运行输出").font(.caption).foregroundColor(.secondary)
        ScrollView {
          Text(output.isEmpty ? "暂无输出" : output)
            .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading).padding(14)
        }
        .frame(height: output.isEmpty ? 60 : 240)
        .background(TerminalAppearance.panel).cornerRadius(12)
        .accessibilityIdentifier("quick-command-run-output")
        DisclosureGroup("本次执行配置") {
          VStack(alignment: .leading, spacing: 8) {
            Text("\(run.snapshot.model ?? "默认模型") · \(TerminalAgentSettingsModel.effortLabel(run.snapshot.effort)) · \(run.snapshot.executionPolicyLabel)")
            Text(run.snapshot.prompt).textSelection(.enabled)
          }.font(.caption).padding(.top, 8)
        }.font(.caption).foregroundColor(.secondary)
        if run.active {
          Button(stopping || run.status == "stopping" ? "正在停止…" : "停止本次运行", role: .destructive) { confirmStop = true }
            .frame(maxWidth: .infinity, minHeight: 44)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.red.opacity(0.25)))
            .disabled(!session.canWrite || !polling || stopping || run.status == "stopping")
            .accessibilityIdentifier("quick-command-run-stop")
        }
        if let failure { Text(failure).font(.caption).foregroundColor(.red) }
      }.padding(20)
    }
    .background(TerminalAppearance.background)
    .navigationTitle("运行详情").navigationBarTitleDisplayMode(.inline)
    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
    .task(id: polling) {
      guard polling else { return }
      while !Task.isCancelled {
        await refresh()
        guard run.active else { return }
        do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
      }
    }
    .confirmationDialog("停止本次运行？", isPresented: $confirmStop, titleVisibility: .visible) {
      Button("停止运行", role: .destructive) { stop() }
      Button("取消", role: .cancel) {}
    } message: { Text("已经发生的文件或外部操作不会回滚。") }
    .confirmationDialog("原终端已用于另一个对话", isPresented: $confirmReplace, titleVisibility: .visible) {
      Button("为本次运行另开终端") { openTerminal(replace: true) }
      Button("取消", role: .cancel) {}
    } message: { Text("保留原终端，为此历史记录恢复一个新终端。") }
    .onDisappear { operation?.cancel() }
    .onChange(of: polling) { if !$0 { operation?.cancel(); confirmReplace = false } }
    .clarityMask().mobileAnalyticsScreen(.quickReplies)
  }

  private func openTerminal(replace: Bool = false) {
    guard polling, session.canWrite, !opening, !run.active, !ownerUnresolved else { return }
    let selected = run
    opening = true; openFailure = nil
    operation = Task {
      defer { opening = false }
      do {
        let terminalID = try await session.withConnection(reportFailure: false) { api in
          let service = ScheduledTasksService(api: api)
          if selected.canOpen {
            return try await service.restoreTerminal(selected.id, replace: replace).terminalSessionId
          }
          let contexts = try await service.contexts(HomeOverview.parentProjectID(selected.executionProjectId))
          guard contexts.contains(where: { $0.projectId == selected.executionProjectId && $0.path == selected.cwd && $0.availability == "available" }) else {
            throw ScheduledFailure(code: "context_unavailable", message: "本次运行的项目或工作区已不可用，无法新建终端。")
          }
          try Task.checkCancellation()
          let created = try await api.createTerminal(projectID: selected.executionProjectId)
          let details = try await api.details(id: created.terminalSessionId)
          guard details.projectId == selected.executionProjectId, details.cwd == selected.cwd else {
            throw ScheduledFailure(code: "context_changed", message: "项目执行位置已变化，请重新确认后再打开终端。")
          }
          return created.terminalSessionId
        }
        guard polling, !Task.isCancelled else { return }
        await session.openTerminal(terminalID)
        // Navigation can dismiss this view and cancel its task after the terminal is selected.
        guard generation == session.generation else { return }
        if session.terminal?.id == terminalID { onOpenTerminal() }
        else if !Task.isCancelled { openFailure = session.error ?? "未能打开终端，请重试。" }
      } catch let error as ScheduledFailure where error.code == "terminal_repurposed" {
        if polling, !Task.isCancelled { confirmReplace = true }
      } catch {
        if polling, !Task.isCancelled, !(error is CancellationError) { openFailure = displayError(error) }
      }
    }
  }

  private func refresh() async {
    do {
      let updated = try await session.withConnection(reportFailure: false) { try await ScheduledTasksService(api: $0).run(run.id) }
      guard polling, !Task.isCancelled else { return }
      run = updated
      var more = true
      while more && !Task.isCancelled {
        let next = cursor
        let page = try await session.withConnection(reportFailure: false) {
          try await ScheduledTasksService(api: $0).output(run.id, cursor: next)
        }
        guard polling, !Task.isCancelled else { return }
        if page.nextCursor != cursor { output = String((output + page.text).suffix(262144)); cursor = page.nextCursor }
        more = page.hasMore
      }
      failure = nil
    } catch {
      if polling, !Task.isCancelled, !(error is CancellationError) { failure = displayError(error) }
    }
  }

  private func stop() {
    guard polling, session.canWrite, !stopping else { return }
    stopping = true; failure = nil
    Task {
      defer { stopping = false }
      do {
        let updated = try await session.withConnection(reportFailure: false) { try await ScheduledTasksService(api: $0).stop(run.id) }
        guard polling else { return }
        run = updated
      } catch {
        if polling, !(error is CancellationError) { failure = displayError(error) }
      }
    }
  }
}
