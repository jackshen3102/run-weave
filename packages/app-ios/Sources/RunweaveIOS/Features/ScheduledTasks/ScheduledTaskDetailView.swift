import SwiftUI

struct ScheduledTaskDetailView: View {
  @ObservedObject var session: AppSession
  @ObservedObject var model: ScheduledTasksModel
  let edit: (ScheduledTaskRecord) -> Void
  @State private var positionedRun: String?
  var body: some View {
    ScrollViewReader { proxy in
      List {
        ScheduledStatusView(session: session, model: model)
        if let task = model.detail {
          Section {
            HStack {
              Text(task.config.name).font(.title2.bold())
              Spacer()
              ScheduledTaskActions(model: model, task: task, edit: { edit(task) })
            }
            Text("\(scheduledProjectLabel(task.config.projectId, session: session)) · \(task.config.provider)").font(.subheadline)
            Text(task.config.schedule.label)
            Text(task.config.misfirePolicy.label).font(.caption).foregroundColor(.secondary)
            Text(task.enabled ? "下次运行：\(scheduledDate(task.nextRunAt, timezone: task.config.schedule.timezone))" : "已暂停后续安排")
            if task.deletedAt != nil { Text("此任务已删除，历史仍可查看和打开。").foregroundColor(.secondary) }
            DisclosureGroup("任务提示词") { Text(task.config.prompt).textSelection(.enabled) }
            Text("模型：\(task.config.model ?? "默认") · 推理：\(task.config.effort ?? "默认") · \(task.config.executionPolicy == "auto-review" ? "自动审批" : "仅沙箱")")
              .font(.caption).foregroundColor(.secondary)
          }
        }
        Section("运行历史") {
          ForEach(model.runs) { run in
            ScheduledRunView(session: session, model: model, run: run, highlighted: model.highlightedRun == run.id)
              .id(run.id)
          }
          if model.loading { ProgressView("正在加载…") }
          if !model.loading && model.runs.isEmpty && model.failure == nil { Text("还没有运行记录").foregroundColor(.secondary) }
          if model.runsCursor != nil {
            Button("加载更多记录") { Task { await model.refresh(more: true) } }.disabled(model.loading)
          }
        }
      }
      .refreshable { await model.refresh() }
      .onChange(of: model.runs.map(\.id)) { _ in
        if let id = model.highlightedRun, positionedRun != id, model.runs.contains(where: { $0.id == id }) {
          proxy.scrollTo(id, anchor: .center); positionedRun = id
        }
      }
    }
  }
}
