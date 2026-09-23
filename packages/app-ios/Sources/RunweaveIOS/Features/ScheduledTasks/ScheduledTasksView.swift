import SwiftUI

struct ScheduledTasksView: View {
  @ObservedObject var session: AppSession
  let manageConnections: () -> Void
  @StateObject private var model: ScheduledTasksModel
  @State private var editor: ScheduledEditorSelection?
  @State private var visible = false
  @State private var listAnchor: String?
  init(session: AppSession, manageConnections: @escaping () -> Void) {
    self.session = session
    self.manageConnections = manageConnections
    _model = StateObject(wrappedValue: ScheduledTasksModel(session: session))
  }
  private var polling: Bool { visible && session.foreground && session.health.status == .online && session.terminal == nil && editor == nil }
  var body: some View {
    Group {
      if model.targetID != nil {
        ScheduledTaskDetailView(session: session, model: model, edit: { editor = ScheduledEditorSelection(task: $0) })
      } else {
        ScrollViewReader { proxy in
          taskList.onAppear { if let id = listAnchor { proxy.scrollTo(id, anchor: .center) } }
        }
      }
    }
    .navigationBarBackButtonHidden(model.targetID != nil)
    .navigationTitle("定时任务")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .navigationBarLeading) {
        if model.targetID != nil {
          Button { model.select(nil) } label: { Label("任务列表", systemImage: "chevron.left") }
        }
      }
      ToolbarItem(placement: .bottomBar) {
        Button(action: manageConnections) {
          Label(session.connection?.name ?? "当前电脑", systemImage: "desktopcomputer")
        }.accessibilityLabel("定时任务连接管理")
      }
      ToolbarItem(placement: .navigationBarTrailing) {
        HStack {
          Button { editor = ScheduledEditorSelection(task: nil) } label: { Image(systemName: "plus") }
            .accessibilityLabel("新建定时任务").disabled(!model.canWrite)
          Menu {
            Button(model.archived ? "当前任务" : "已删除任务") { model.select(nil); model.archived.toggle() }
          } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("任务列表更多")
        }
      }
    }
    .modifier(ScheduledTerminalDestination(session: session, ownsRoute: true))
    .sheet(item: $editor) { selection in
      ScheduledTaskEditorView(session: session, model: model, task: selection.task) { task in
        model.select(task.id); editor = nil
      }
    }
    .onAppear { visible = true; consumeSource() }
    .onDisappear { visible = false }
    .onChange(of: session.scheduledSource) { _ in consumeSource() }
    .task(id: "\(polling):\(model.filterID):\(model.targetID ?? "")") {
      guard polling else { return }
      do {
        try await Task.sleep(nanoseconds: 250_000_000)
        while !Task.isCancelled {
          await model.refresh()
          try await Task.sleep(nanoseconds: 5_000_000_000)
        }
      } catch {}
    }
  }
  private func consumeSource() {
    if let source = session.scheduledSource {
      model.select(source.taskId, run: source.runId)
      session.scheduledSource = nil
    }
  }
  private var taskList: some View {
    List {
      Section {
        Text(session.connection?.name ?? "当前电脑").font(.caption).foregroundColor(.secondary)
        TextField("搜索任务", text: $model.query).accessibilityIdentifier("scheduled-search")
        Picker("项目", selection: $model.project) {
          Text("所有项目").tag("")
          ForEach(session.overview?.projects ?? []) { Text($0.name).tag($0.id) }
        }
      }
      ScheduledStatusView(session: session, model: model)
      Section(model.archived ? "已删除任务" : "我的任务") {
        ForEach(model.items) { task in
          VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
              Button { listAnchor = task.id; model.select(task.id) } label: {
                VStack(alignment: .leading, spacing: 8) {
                  Text(task.config.name).font(.headline).foregroundColor(.primary)
                  Text(task.config.prompt).font(.subheadline).foregroundColor(.secondary).lineLimit(2)
                  Text("\(scheduledProjectLabel(task.config.projectId, session: session)) · \(task.config.provider)")
                    .font(.caption).foregroundColor(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
              }.buttonStyle(.plain)
              if task.deletedAt == nil {
                Toggle("启用 \(task.config.name)", isOn: Binding(get: { task.enabled }, set: { _ in Task { await model.action("toggle", task: task) } }))
                  .labelsHidden().disabled(!model.canWrite)
              }
            }
            HStack {
              VStack(alignment: .leading, spacing: 4) {
                Text(task.config.schedule.label)
                Text(task.enabled ? "下次：\(scheduledDate(task.nextRunAt, timezone: task.config.schedule.timezone))" : "已暂停后续安排")
              }.font(.caption).foregroundColor(.secondary)
              Spacer()
              ScheduledTaskActions(model: model, task: task, edit: { editor = ScheduledEditorSelection(task: task) })
            }
          }.padding(.vertical, 8).id(task.id)
        }
        if model.loading { ProgressView("正在加载…") }
        if !model.loading && model.items.isEmpty && model.failure == nil && model.capabilities != nil {
          Text(model.archived ? "没有已删除的任务" : "还没有符合条件的任务").foregroundColor(.secondary)
        }
        if model.nextCursor != nil {
          Button("加载更多任务") { Task { await model.refresh(more: true) } }.disabled(model.loading)
        }
      }
    }.refreshable { await model.refresh() }
  }
}
struct ScheduledEditorSelection: Identifiable { let id = UUID(); let task: ScheduledTaskRecord? }
struct ScheduledStatusView: View {
  @ObservedObject var session: AppSession
  @ObservedObject var model: ScheduledTasksModel
  var body: some View {
    Section {
      if session.health.status != .online {
        Text("电脑暂时不可用，显示上次加载的数据。").foregroundColor(.orange)
        Button("重新连接") { Task { await session.refresh(); await model.refresh() } }
      }
      if let caps = model.capabilities, !caps.enabled { Text(caps.reason ?? "调度已关闭，当前为只读。").foregroundColor(.orange) }
      if let error = model.failure {
        Text(error).foregroundColor(.red)
        Button("重试加载") { Task { await session.refresh(); await model.refresh() } }
      }
      if let error = model.actionFailure { Text(error).foregroundColor(.red) }
    }
  }
}
struct ScheduledTaskActions: View {
  @ObservedObject var model: ScheduledTasksModel
  let task: ScheduledTaskRecord
  let edit: () -> Void
  @State private var deleting = false
  var body: some View {
    Group {
      if task.deletedAt != nil { Text("已删除 · 只读").font(.caption).foregroundColor(.secondary) }
      else {
        Menu {
          Button("立即运行") { Task { await model.action("run", task: task) } }
            .disabled(model.runs.contains { $0.taskId == task.id && $0.active })
          Button("编辑任务", action: edit)
          Button(task.enabled ? "暂停后续安排" : "启用任务") { Task { await model.action("toggle", task: task) } }
          Button("删除任务", role: .destructive) { deleting = true }
        } label: { Image(systemName: "ellipsis").padding(8) }
          .accessibilityLabel("\(task.config.name) 更多操作").disabled(!model.canWrite)
      }
    }
    .confirmationDialog("删除任务？", isPresented: $deleting, titleVisibility: .visible) {
      Button("删除任务", role: .destructive) { Task { await model.action("delete", task: task) } }
    } message: { Text("关闭后续安排，保留历史和已打开终端，不停止正在执行的运行。") }
  }
}
@MainActor
func scheduledProjectLabel(_ id: String, session: AppSession) -> String {
  let parent = HomeOverview.parentProjectID(id)
  let name = session.overview?.projects.first { $0.id == parent }?.name ?? parent
  guard parent != id else { return name }
  let parts = id.split(separator: ":")
  guard parts.count == 3 else { return name }
  let encoded = String(parts[2]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  let padded = encoded + String(repeating: "=", count: (4 - encoded.count % 4) % 4)
  let worktree = Data(base64Encoded: padded).flatMap { String(data: $0, encoding: .utf8) } ?? "Worktree"
  return "\(name) / \(worktree)"
}

// Only the visible route host owns the existing terminal destination.
struct ScheduledTerminalDestination: ViewModifier {
  @ObservedObject var session: AppSession
  let ownsRoute: Bool
  func body(content: Content) -> some View {
    content.background {
      NavigationLink(isActive: Binding(
        get: { ownsRoute && session.terminal != nil },
        set: { if !$0 && ownsRoute { session.closeTerminal() } }
      )) {
        if let details = session.terminal, let controller = session.terminalController {
          TerminalScreen(session: session, controller: controller, details: details, sourceIsParent: true)
            .id("\(session.generation):\(details.id):\(details.projectId)")
        }
      } label: { EmptyView() }.hidden()
    }
  }
}
