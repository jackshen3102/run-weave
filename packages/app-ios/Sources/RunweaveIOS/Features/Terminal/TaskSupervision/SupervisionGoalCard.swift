import SwiftUI

struct SupervisionGoalCard: View {
  let watch: TaskWatch
  @ObservedObject var model: TaskSupervisionModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("当前目标").font(.caption).foregroundColor(.secondary)
        Spacer()
        Text(watch.goalDefinition.map { "\($0.originLabel) · v\($0.version)" } ?? "待核对")
          .font(.caption2).foregroundColor(.secondary)
      }
      Text(watch.goalDefinition?.objective ?? (watch.goal.isEmpty ? "等待新会话的用户任务，目标将自动读取。" : watch.goalPreview))
        .font(.subheadline).textSelection(.enabled).accessibilityIdentifier("task-supervision-goal")
      if let goal = watch.goalDefinition {
        goalText("完成条件", goal.completionCriteria)
        if !goal.constraints.isEmpty {
          DisclosureGroup("范围与约束") { Text(goal.constraints).textSelection(.enabled).padding(.top, 8) }.font(.caption)
        }
      }
      if watch.goalState == "needs_review" || (watch.goalDefinition == nil && !watch.awaitingTask) {
        Text(watch.goalReason ?? "当前目标尚未明确完成条件和范围，请核对后再自动续接。")
          .font(.caption).foregroundColor(.orange)
      } else if watch.goalState == "checking" {
        Text("收到新要求，将在最终回复时核对目标；核对前不自动续接。").font(.caption).foregroundColor(.secondary)
      }
      HStack(spacing: 18) {
        NavigationLink("编辑") { SupervisionGoalEditor(model: model, watch: watch, regenerate: false) }
          .accessibilityIdentifier("task-supervision-goal-edit")
        NavigationLink("重新生成") { SupervisionGoalEditor(model: model, watch: watch, regenerate: true) }
          .accessibilityIdentifier("task-supervision-goal-regenerate")
      }.font(.subheadline).disabled(!model.canRead || model.writing)
      if let goal = watch.goalDefinition {
        NavigationLink("查看依据") { SupervisionGoalDetailView(model: model, watchID: watch.watchId, revisionID: goal.revisionId) }
          .font(.caption).disabled(!model.canRead).accessibilityIdentifier("task-supervision-goal-sources")
      }
      NavigationLink("目标版本历史") { SupervisionGoalHistoryView(model: model, watchID: watch.watchId) }
        .font(.caption).disabled(!model.canRead).accessibilityIdentifier("task-supervision-goal-history")
      if watch.goalState == "ready", let reason = watch.goalReason {
        Text(reason).font(.caption2).foregroundColor(.secondary)
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}

func goalText(_ label: String, _ text: String) -> some View {
  VStack(alignment: .leading, spacing: 6) {
    Text(label).font(.caption).foregroundColor(.secondary)
    Text(text.isEmpty ? "未明确" : text).font(.subheadline).textSelection(.enabled)
      .fixedSize(horizontal: false, vertical: true)
  }.frame(maxWidth: .infinity, alignment: .leading)
}

func goalFailure(_ error: Error) -> String {
  if case APIError.http(404) = error { return "当前服务不支持目标修订，或该目标记录已不存在。" }
  if case APIError.http(409) = error { return "任务状态、对话或预览已变化，请基于最新状态重新核对。" }
  return error.localizedDescription
}
