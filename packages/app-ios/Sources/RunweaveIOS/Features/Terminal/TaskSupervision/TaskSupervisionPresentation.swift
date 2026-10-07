import SwiftUI

extension TaskWatch {
  var currentDecisions: [SupervisionDecision] {
    decisions.filter { $0.contextRevision == contextRevision && ($0.threadId == nil || $0.threadId == target.threadId) }
  }
  var awaitingTask: Bool { taskStartMessageId.hasPrefix("pending:") }
  var goalPreview: String { supervisionGoalPreview(goal) }
  var statusTitle: String {
    if !enabled { return "监控已关闭" }
    if status == "watching", let waitingFor {
      return waitingFor == "permission" ? "等待你在原终端批准权限" : "等待你在原终端回答问题"
    }
    if pauseReason == "continuation_limit" { return "已达续接上限" }
    if pauseReason == "delivery_unknown" { return "续接待确认" }
    if status == "error" { return "监听异常 / 上下文待补充" }
    if status == "paused" { return "监控已暂停" }
    if status == "classifying" { return "正在判断任务状态" }
    if awaitingTask { return "等待新任务" }
    if outcome == .completed { return "本轮任务已完成" }
    if outcome == .blocked { return "需要你处理" }
    return "正在监听"
  }
  var statusSummary: String {
    if !enabled { return "关闭后停止处理最终回复；已有判断记录保留。" }
    if status == "watching", waitingFor != nil { return "请回到原终端处理，监控仍保持开启。" }
    if pauseReason == "continuation_limit" { return "任务仍未完成。本任务已续接 \(continuationLimit) 次，监控保持开启。" }
    if pauseReason == "delivery_unknown" { return "已保留本次额度，尚未确认原会话接收，不会重复发送。" }
    if status == "error" { return "当前轮没有有效判断，监控开关保持开启。" }
    if status == "paused" { return "本轮自动处理已暂停，终端监控开关仍保持开启。" }
    if status == "classifying" { return "已收到最终回复，正在核对任务与计划。" }
    if awaitingTask { return "终端监听已开启，收到新会话的用户任务后自动读取目标。" }
    if outcome == .completed { return "继续监听此终端，下一次任务无需重新开启。" }
    if outcome == .blocked { return "本轮任务有阻塞，监控仍保持开启。" }
    return "等待 Agent 的最终回复，需要继续时自动问询进展。"
  }
  var needsAttention: Bool {
    enabled && (waitingFor != nil || pauseReason == "continuation_limit"
      || pauseReason == "delivery_unknown" || status == "error" || status == "paused" || outcome == .blocked)
  }
  var statusColor: Color { !enabled ? .secondary : needsAttention ? .orange : TerminalAppearance.accent }
  var statusSymbol: String {
    !enabled ? "eye.slash" : needsAttention ? "exclamationmark.triangle" : status == "classifying"
      ? "clock" : outcome == .completed ? "checkmark.circle" : "eye"
  }
  var stripLabel: String {
    if !enabled { return "监控已关闭" }
    if waitingFor != nil { return "等待你处理" }
    if pauseReason == "continuation_limit" { return "续接已暂停" }
    if pauseReason == "delivery_unknown" { return "续接待确认" }
    if status == "error" { return "监听异常" }
    if status == "paused" { return "监控已暂停" }
    if status == "classifying" { return "判断中" }
    if awaitingTask { return "等待新任务" }
    if outcome == .completed { return "本轮已完成" }
    if outcome == .blocked { return "需要处理" }
    return "监控中"
  }
  var returnLabel: String {
    if waitingFor != nil || outcome == .blocked { return "回到终端处理" }
    if pauseReason == "continuation_limit" { return "回到终端继续" }
    return "回到终端"
  }
}

func supervisionGoalPreview(_ goal: String) -> String {
  let prose = goal.components(separatedBy: .newlines)
    .prefix { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("{") && !$0.trimmingCharacters(in: .whitespaces).hasPrefix("```") }
    .joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
  let preview = String((prose.isEmpty ? goal.trimmingCharacters(in: .whitespacesAndNewlines) : prose).prefix(240))
  return preview.count < goal.trimmingCharacters(in: .whitespacesAndNewlines).count ? preview + "…" : preview
}

func supervisionTime(_ value: String) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  guard let date = formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value) else { return value }
  return date.formatted(date: .omitted, time: .shortened)
}

struct TaskSupervisionStrip: View {
  let watch: TaskWatch
  let stale: Bool
  let open: () -> Void

  var body: some View {
    Button(action: open) {
      HStack(spacing: 9) {
        Image(systemName: watch.statusSymbol)
        Text(stale ? "上次状态 · \(watch.stripLabel)" : watch.stripLabel)
          .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
        Text("\(watch.continuationCount)/\(watch.continuationLimit) 次续接").font(.caption2)
        Image(systemName: "chevron.right").font(.caption2)
      }.font(.caption).foregroundColor(watch.statusColor)
        .padding(.horizontal, 16).frame(minHeight: 46)
        .background(watch.statusColor.opacity(0.05))
        .overlay(alignment: .bottom) { Rectangle().fill(TerminalAppearance.border).frame(height: 0.5) }
    }.buttonStyle(.plain)
      .accessibilityLabel("长任务监控，\(stale ? "上次状态，" : "")\(watch.statusTitle)，已续接 \(watch.continuationCount) 次")
      .accessibilityIdentifier("terminal-task-supervision-open")
  }
}
