import Clarity
import SwiftUI

struct TaskSupervisionSheet: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  @ObservedObject var model: TaskSupervisionModel
  let terminalTitle: String

  var body: some View {
    NavigationView {
      VStack(spacing: 0) {
        ScrollView {
          VStack(alignment: .leading, spacing: 23) {
            notices
            Toggle(isOn: Binding(get: { model.watch?.enabled ?? false }, set: model.setEnabled)) {
              VStack(alignment: .leading, spacing: 5) {
                Text("监听此终端").font(.subheadline.weight(.medium))
                Text("切换会话保留监听，重置当前任务").font(.caption2).foregroundColor(.secondary)
              }
            }.tint(TerminalAppearance.accent).disabled(!model.canToggle)
              .accessibilityIdentifier("terminal-task-supervision-switch")
            if let watch = model.watch {
              watchContent(watch)
            } else if model.loading {
              ProgressView("正在读取终端监控…").frame(maxWidth: .infinity).padding(.vertical, 30)
            } else {
              emptyContent
            }
          }.padding(20)
        }.refreshable { await model.refresh() }
        footer
      }
      .background(TerminalAppearance.panel.ignoresSafeArea())
      .navigationTitle("长任务监控")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .principal) {
          VStack(spacing: 3) {
            Text("长任务监控").font(.headline)
            Text("\(terminalTitle) · \(session.connection?.name ?? "电脑")")
              .font(.caption2).foregroundColor(.secondary).lineLimit(1)
          }
        }
        ToolbarItem(placement: .navigationBarTrailing) {
          Button { dismiss() } label: { Image(systemName: "xmark.circle.fill").foregroundColor(.secondary) }
            .accessibilityLabel("关闭监控面板")
        }
      }
      .clarityMask()
    }.navigationViewStyle(.stack).tint(TerminalAppearance.accent)
      .modifier(TaskSupervisionDetents())
      .mobileAnalyticsScreen(.taskSupervision)
  }

  @ViewBuilder private var notices: some View {
    if !session.foreground || session.health.status != .online {
      Text("电脑暂时离线，显示上次同步的状态。连接恢复后将更新；当前无法修改监控。")
        .font(.caption).foregroundColor(.orange)
    }
    if let failure = model.failure {
      Text(failure).font(.caption).foregroundColor(.orange).textSelection(.enabled)
      Button("重新读取") { Task { await model.refresh() } }.font(.caption).disabled(!model.canRead || model.loading)
    }
    if let failure = model.actionFailure { Text(failure).font(.caption).foregroundColor(.orange) }
    if let error = model.watch?.error { Text(error).font(.caption).foregroundColor(.orange).textSelection(.enabled) }
    if model.watch?.enabled != true, let capability = model.discovery?.capability, !capability.supported {
      Text(capability.reason ?? "当前终端没有 Agent，启动 Agent 后即可开启监控。")
        .font(.caption).foregroundColor(.orange)
    }
  }

  private var emptyContent: some View {
    VStack(spacing: 14) {
      Image(systemName: "eye").font(.largeTitle).foregroundColor(TerminalAppearance.accent)
      Text("让任务持续推进").font(.headline)
      Text("最终回复到达后判断任务状态，\n需要继续时，自动向原会话问询进展。")
        .font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
      Text("从原会话自动读取用户任务，无需手工填写目标。")
        .font(.caption).foregroundColor(.secondary).multilineTextAlignment(.center)
    }.frame(maxWidth: .infinity).padding(.vertical, 24)
  }

  @ViewBuilder private func watchContent(_ watch: TaskWatch) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: watch.statusSymbol)
      VStack(alignment: .leading, spacing: 6) {
        Text(model.writing ? "正在同步…" : watch.statusTitle).font(.subheadline.weight(.semibold))
          .accessibilityIdentifier("task-supervision-status")
        Text(watch.statusSummary).font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
      }
    }.foregroundColor(watch.statusColor).frame(maxWidth: .infinity, alignment: .leading)
      .padding(14).background(watch.statusColor.opacity(0.06)).cornerRadius(13)
      .overlay(RoundedRectangle(cornerRadius: 13).stroke(watch.statusColor.opacity(0.15)))

    section("当前目标") {
      Text(watch.goal.isEmpty ? "等待新会话的用户任务，目标将自动读取。" : watch.goalPreview)
        .font(.subheadline).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("task-supervision-goal")
      if !watch.goal.isEmpty {
        NavigationLink("查看原始任务") { TaskSupervisionGoalView(goal: watch.goal) }.font(.caption)
          .accessibilityIdentifier("task-supervision-original-task-open")
      }
    }
    VStack(alignment: .leading, spacing: 9) {
      HStack {
        Text("本任务自动续接").font(.caption).foregroundColor(.secondary)
        Spacer()
        Text("\(watch.continuationCount) / \(watch.continuationLimit) 次").font(.caption)
          .accessibilityIdentifier("task-supervision-quota")
      }
      HStack(spacing: 5) {
        ForEach(0..<watch.continuationLimit, id: \.self) { index in
          Capsule().fill(index < watch.continuationCount ? watch.statusColor : Color.secondary.opacity(0.15)).frame(height: 4)
        }
      }.accessibilityHidden(true)
      Text("新会话重置任务；同会话的新输入更新要求并重置本轮额度。").font(.caption2).foregroundColor(.secondary)
      if watch.currentDecisions.contains(where: { ["offered", "unknown"].contains($0.delivery) }) {
        Text("有续接尚未确认接收，已保留额度，不会重复发送。").font(.caption2).foregroundColor(.orange)
      }
    }
    if let decision = watch.currentDecisions.last {
      section(watch.status == "error" || watch.status == "classifying" ? "上次判断（当前轮尚无有效结果）" : "最新判断") {
        HStack {
          Text(decision.outcome.label).font(.subheadline.weight(.semibold))
          Spacer()
          Text(supervisionTime(decision.createdAt)).font(.caption2).foregroundColor(.secondary)
        }
        Text(decision.reason).font(.subheadline).foregroundColor(.secondary).textSelection(.enabled)
        NavigationLink { TaskSupervisionDecisionView(decision: decision) } label: {
          Label("查看判断依据", systemImage: "chevron.right").font(.caption)
        }.accessibilityIdentifier("task-supervision-decision-open")
      }
    }
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("最近活动").font(.caption).foregroundColor(.secondary)
        Spacer()
        NavigationLink("全部") { TaskSupervisionActivityView(watch: watch) }.font(.caption)
          .accessibilityIdentifier("task-supervision-activity-open")
      }
      if let decision = watch.currentDecisions.last {
        activity(decision.deliveryLabel, time: decision.createdAt)
      }
      activity(watch.enabled ? "已开启终端监控" : "监控已关闭", time: watch.enabled ? watch.enabledAt : watch.updatedAt)
    }
  }

  private var footer: some View {
    VStack(spacing: 8) {
      if model.watch?.enabled == true {
        Button { dismiss() } label: { Label(model.watch?.returnLabel ?? "回到终端", systemImage: "arrow.right")
          .frame(maxWidth: .infinity).frame(minHeight: 36) }
          .buttonStyle(.borderedProminent).tint(TerminalAppearance.accent).foregroundColor(TerminalAppearance.background)
          .accessibilityIdentifier("task-supervision-return")
        Text("返回终端不会关闭监控").font(.caption2).foregroundColor(.secondary)
      } else {
        Button { model.setEnabled(true) } label: {
          Label(model.writing ? "正在同步…" : "开启监控", systemImage: "eye")
            .frame(maxWidth: .infinity).frame(minHeight: 36)
        }.buttonStyle(.borderedProminent).tint(TerminalAppearance.accent).foregroundColor(TerminalAppearance.background)
          .disabled(!model.canToggle).accessibilityIdentifier("task-supervision-enable")
      }
    }.padding(16).frame(maxWidth: .infinity).background(TerminalAppearance.panel)
      .overlay(alignment: .top) { Rectangle().fill(TerminalAppearance.border).frame(height: 0.5) }
  }

  private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(title).font(.caption).foregroundColor(.secondary)
      content()
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
  private func activity(_ label: String, time: String) -> some View {
    HStack(spacing: 9) {
      Circle().fill(Color.secondary).frame(width: 4, height: 4)
      Text(label).font(.caption)
      Spacer()
      Text(supervisionTime(time)).font(.caption2).foregroundColor(.secondary)
    }
  }
}

private struct TaskSupervisionDetents: ViewModifier {
  func body(content: Content) -> some View {
    if #available(iOS 16.0, *) {
      content.presentationDetents([.fraction(0.87), .large]).presentationDragIndicator(.visible)
    } else { content }
  }
}
