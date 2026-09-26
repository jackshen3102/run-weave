import SwiftUI

struct ScheduledTaskEditorView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  @ObservedObject var model: ScheduledTasksModel
  let task: ScheduledTaskRecord?
  let saved: (ScheduledTaskRecord) -> Void
  @State private var draft: ScheduledTaskConfig
  @State private var enabled: Bool
  @State private var revision: Int?
  @State private var baseline: ScheduledTaskConfig
  @State private var baselineEnabled: Bool
  @State private var contexts: [ScheduledProjectContext] = []
  @State private var catalogs: ScheduledModelSettings?
  @State private var optionsFailure: String?
  @State private var modelFailure: String?
  @State private var preview: ScheduledPreview?
  @State private var previewSchedule: ScheduledTaskSchedule?
  @State private var previewRetry = 0
  @State private var previewFailure: String?
  @State private var failure: String?
  @State private var saving = false
  @State private var loading = false
  @State private var discarding = false
  @State private var reloading = false
  @State private var conflict = false
  @State private var submittedBody: [String: Any]?
  @State private var submittedKey = UUID().uuidString
  @State private var uncertain = false
  @State private var saveOperation: Task<Void, Never>?
  init(session: AppSession, model: ScheduledTasksModel, task: ScheduledTaskRecord?, saved: @escaping (ScheduledTaskRecord) -> Void) {
    self.session = session; self.model = model; self.task = task; self.saved = saved
    let config = task?.config ?? ScheduledTaskConfig()
    _draft = State(initialValue: config); _baseline = State(initialValue: config)
    _enabled = State(initialValue: task?.enabled ?? true); _baselineEnabled = State(initialValue: task?.enabled ?? true)
    _revision = State(initialValue: task?.revision)
  }
  private var provider: ScheduledCapabilities.Provider? { model.capabilities?.providers.first { $0.provider == draft.provider } }
  private var models: [ScheduledModelSettings.Model] {
    let catalog = catalogs?.catalogs[draft.provider == "trae" ? "traex" : draft.provider]
    return catalog?.availability == "available" ? catalog?.models ?? [] : []
  }
  private var selectedModel: ScheduledModelSettings.Model? { models.first { $0.id == draft.model } }
  private var dirty: Bool { draft != baseline || enabled != baselineEnabled }
  private var timeZone: TimeZone { TimeZone(identifier: draft.schedule.timezone) ?? .current }
  private var time: Binding<Date> {
    Binding(get: {
      let formatter = DateFormatter(); formatter.timeZone = timeZone; formatter.dateFormat = "HH:mm"
      return formatter.date(from: draft.schedule.localTime ?? "09:00") ?? Date()
    }, set: { date in
      let formatter = DateFormatter(); formatter.timeZone = timeZone; formatter.dateFormat = "HH:mm"
      draft.schedule.localTime = formatter.string(from: date)
    })
  }
  private var once: Binding<Date> {
    Binding(get: { draft.schedule.runAt.flatMap(scheduledParseDate) ?? Date().addingTimeInterval(3600) },
      set: { draft.schedule.runAt = ISO8601DateFormatter().string(from: $0) })
  }
  private var validation: String? {
    if draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "请填写任务名称" }
    if draft.name.utf16.count > 80 { return "名称最多 80 个字符" }
    if draft.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "请填写提示词" }
    if draft.prompt.utf16.count > 12000 { return "提示词最多 12000 个字符" }
    if draft.projectId.isEmpty { return "请选择项目" }
    if contexts.first(where: { $0.id == draft.projectId })?.availability != "available" { return "请选择目录可用的项目，或重试加载项目" }
    if provider?.available != true { return provider?.reason ?? "此 Agent 暂不可用" }
    if TimeZone(identifier: draft.schedule.timezone) == nil { return "请选择有效时区" }
    if draft.schedule.kind == "weekly" && (draft.schedule.weekdays ?? []).isEmpty { return "请至少选择一周中的一天" }
    if draft.schedule.kind == "once", (draft.schedule.runAt.flatMap(scheduledParseDate) ?? .distantPast) <= Date() { return "仅一次的执行时间必须在未来" }
    if !draft.executionPolicyKnown { return "任务包含未知执行权限，请先选择受支持的权限" }
    if !(provider?.executionPolicies ?? ["sandbox"]).contains(draft.resolvedExecutionPolicy) { return "此 Agent 当前不支持所选执行权限" }
    if previewSchedule != draft.schedule || preview?.occurrences.isEmpty != false || previewFailure != nil { return "请等待时间预览通过" }
    return nil
  }
  var body: some View {
    NavigationView {
      Form {
        basicFields
        Section("提示词") {
          TextEditor(text: $draft.prompt).frame(minHeight: 140)
            .accessibilityLabel("任务提示词").disabled(uncertain)
        }
        scheduleFields
        Section {
          DisclosureGroup("高级设置") { advancedFields }
        }
        if let message = validation { Section { Text(message).font(.caption).foregroundColor(.secondary) } }
        if let failure { Section { Text(failure).foregroundColor(.red) } }
        if conflict { Section { Button("加载最新配置，放弃当前草稿") { reloading = true }.disabled(saving) } }
        if uncertain {
          Section {
            Text("提交结果尚未确认。表单暂时锁定，重试将使用同一请求，避免重复创建。")
            Button("重试确认本次提交") { submit(retry: true) }.disabled(saving || !session.canWrite)
          }
        }
      }
      .disabled(saving)
      .navigationTitle(task == nil ? "新建定时任务" : "编辑任务")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("取消") { if dirty || uncertain { discarding = true } else { dismiss() } }.disabled(saving) }
        ToolbarItem(placement: .confirmationAction) {
          Button(saving ? "保存中…" : "保存") { submit() }
            .disabled(saving || loading || uncertain || conflict || validation != nil || !model.canWrite)
        }
      }
      .task { await loadOptions() }
      .task(id: "\(draft.schedule.hashValue):\(session.foreground):\(previewRetry)") {
        guard session.foreground else { return }
        preview = nil; previewSchedule = nil; previewFailure = nil
        let schedule = draft.schedule
        do {
          try await Task.sleep(nanoseconds: 350_000_000)
          let value = try await model.call { try await $0.preview(schedule) }
          try Task.checkCancellation(); preview = value; previewSchedule = schedule
        } catch { if !Task.isCancelled { previewFailure = displayError(error) } }
      }
      .confirmationDialog("放弃未保存修改？", isPresented: $discarding, titleVisibility: .visible) {
        Button("关闭编辑", role: .destructive) { dismiss() }
      } message: { Text(uncertain ? "提交可能已经成功，请回到列表核对，不要重复新建。" : "当前修改将不会保存。") }
      .confirmationDialog("加载最新配置？", isPresented: $reloading, titleVisibility: .visible) {
        Button("放弃草稿并加载", role: .destructive) {
          saveOperation = Task {
            guard let task else { return }
            saving = true; defer { saving = false }
            do {
              let latest = try await model.call { try await $0.task(task.id) }
              try Task.checkCancellation()
              guard latest.deletedAt == nil else { throw ScheduledFailure(code: "deleted", message: "任务已删除，无法编辑。") }
              draft = latest.config; baseline = latest.config; enabled = latest.enabled; baselineEnabled = latest.enabled
              revision = latest.revision; conflict = false; failure = nil
            } catch { if !Task.isCancelled { failure = displayError(error) } }
          }
        }
      }
    }
    .navigationViewStyle(.stack)
    .interactiveDismissDisabled(dirty || saving || uncertain)
    .onDisappear { saveOperation?.cancel() }
    .onChange(of: session.foreground) { foreground in
      if !foreground, saving { uncertain = true; saveOperation?.cancel() }
    }
  }
  private var basicFields: some View {
    Section("任务") {
      TextField("名称", text: $draft.name).disabled(uncertain).accessibilityIdentifier("scheduled-name")
      Picker("项目", selection: $draft.projectId) {
        Text("选择项目").tag("")
        if !draft.projectId.isEmpty && !contexts.contains(where: { $0.id == draft.projectId }) { Text("\(draft.projectId)（待校验）").tag(draft.projectId) }
        ForEach(contexts) { context in
          Text(contextLabel(context) + (context.availability == "available" ? "" : "（目录不可用）"))
            .tag(context.id).disabled(context.availability != "available")
        }
      }
      .disabled(uncertain)
      if let optionsFailure { Text(optionsFailure).foregroundColor(.orange); Button("重试加载项目") { Task { await loadOptions() } } }
      Picker("Agent", selection: $draft.provider) {
        ForEach(model.capabilities?.providers ?? []) { item in
          Text(item.provider + (item.available ? "" : "（不可用）")).tag(item.provider).disabled(!item.available)
        }
      }.disabled(uncertain).onChange(of: draft.provider) { _ in draft.model = nil; draft.effort = nil; draft.executionPolicy = "sandbox" }
      Toggle("启用任务", isOn: $enabled).disabled(uncertain)
    }
  }
  private var scheduleFields: some View {
    Section("时间安排") {
      Picker("重复", selection: $draft.schedule.kind) {
        Text("每天").tag("daily"); Text("工作日").tag("weekdays"); Text("每周").tag("weekly"); Text("仅一次").tag("once")
      }.disabled(uncertain).onChange(of: draft.schedule.kind) { kind in
        if kind == "weekly", draft.schedule.weekdays == nil { draft.schedule.weekdays = [1] }
        if kind == "once", draft.schedule.runAt == nil { draft.schedule.runAt = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)) }
      }
      if draft.schedule.kind == "weekly" {
        ForEach([1, 2, 3, 4, 5, 6, 0], id: \.self) { day in
          Toggle("周" + ["日", "一", "二", "三", "四", "五", "六"][day], isOn: Binding(
            get: { draft.schedule.weekdays?.contains(day) == true },
            set: { selected in
              var days = Set(draft.schedule.weekdays ?? [])
              if selected { days.insert(day) } else { days.remove(day) }
              draft.schedule.weekdays = days.sorted()
            })).disabled(uncertain)
        }
      }
      if draft.schedule.kind == "once" { DatePicker("执行时间", selection: once).environment(\.timeZone, timeZone).disabled(uncertain) }
      else { DatePicker("时间", selection: time, displayedComponents: .hourAndMinute).environment(\.timeZone, timeZone).disabled(uncertain) }
      NavigationLink { ScheduledTimeZonePicker(selection: $draft.schedule.timezone) } label: {
        HStack { Text("时区"); Spacer(); Text(draft.schedule.timezone).foregroundColor(.secondary) }
      }
      .disabled(uncertain)
      if let preview {
        VStack(alignment: .leading, spacing: 4) {
          Text("接下来执行时间").font(.caption).foregroundColor(.secondary)
          ForEach(preview.occurrences.prefix(3), id: \.self) { Text(scheduledDate($0, timezone: draft.schedule.timezone)).font(.caption) }
        }
      }
      if let previewFailure { Text(previewFailure).font(.caption).foregroundColor(.orange); Button("重试时间预览") { previewRetry += 1 } }
      else if preview == nil { ProgressView("正在预览执行时间…") }
    }
  }
  private var advancedFields: some View {
    Group {
      Picker("模型", selection: Binding(get: { draft.model ?? "" }, set: { id in
        draft.model = id.isEmpty ? nil : id
        draft.effort = models.first { $0.id == id }?.defaultReasoningEffort
      })) {
        Text("Agent 默认配置").tag("")
        if let id = draft.model, !id.isEmpty, !models.contains(where: { $0.id == id }) { Text("\(id)（已保存）").tag(id) }
        ForEach(models) { Text($0.label).tag($0.id) }
      }
      Picker("推理强度", selection: Binding(get: { draft.effort ?? "" }, set: { draft.effort = $0.isEmpty ? nil : $0 })) {
        Text("默认").tag("")
        if let effort = draft.effort, !(selectedModel?.reasoningEfforts ?? []).contains(effort) { Text("\(effort)（已保存）").tag(effort) }
        ForEach(selectedModel?.reasoningEfforts ?? [], id: \.self) { Text($0).tag($0) }
      }
      if let modelFailure { Text(modelFailure).font(.caption).foregroundColor(.orange); Button("重试加载模型") { Task { await loadModels() } } }
      Picker("执行权限", selection: Binding(get: { draft.resolvedExecutionPolicy }, set: { draft.executionPolicy = $0 })) {
        if !draft.executionPolicyKnown { Text("未知权限").tag(draft.resolvedExecutionPolicy).disabled(true) }
        Text("仅沙箱").tag("sandbox")
        if provider?.executionPolicies?.contains("auto-review") == true || draft.executionPolicy == "auto-review" {
          Text("自动审批").tag("auto-review").disabled(provider?.executionPolicies?.contains("auto-review") != true)
        }
        if provider?.executionPolicies?.contains("full-access") == true || draft.executionPolicy == "full-access" {
          Text("完全访问").tag("full-access").disabled(provider?.executionPolicies?.contains("full-access") != true)
        }
      }
      if draft.resolvedExecutionPolicy == "full-access" {
        Text("无沙箱且不等待交互审批，可联网、操作 Browser、模拟器及本机文件；仅用于可信任务与提示词。")
          .font(.caption).foregroundColor(.orange)
      } else if !draft.executionPolicyKnown {
        Text("未知权限：请选择受支持的权限后再保存。").font(.caption).foregroundColor(.orange)
      }
      Picker("错过执行时间", selection: $draft.misfirePolicy.mode) {
        Text("恢复后补最近一次").tag("catch-up-latest"); Text("错过就跳过").tag("skip")
      }
      if draft.misfirePolicy.mode == "catch-up-latest" {
        Stepper("允许延迟 \((draft.misfirePolicy.maxDelaySeconds ?? 86400) / 3600) 小时", value: Binding(
          get: { (draft.misfirePolicy.maxDelaySeconds ?? 86400) / 3600 }, set: { draft.misfirePolicy.maxDelaySeconds = $0 * 3600 }), in: 1...168)
      }
    }.disabled(uncertain)
  }
  private func contextLabel(_ context: ScheduledProjectContext) -> String {
    let parent = session.overview?.projects.first { $0.id == context.parentProjectId }?.name ?? context.parentProjectId
    return context.isPrimary ? parent : "\(parent) / \(context.name)"
  }
  private func loadModels() async {
    do { let value = try await model.call { try await $0.models() }; try Task.checkCancellation(); catalogs = value; modelFailure = nil }
    catch { if !Task.isCancelled { modelFailure = "模型目录暂不可用，已有配置仍会保留。" } }
  }
  private func loadOptions() async {
    loading = true; defer { loading = false }
    do {
      var values: [ScheduledProjectContext] = []
      for project in session.overview?.projects ?? [] {
        values += try await model.call { try await $0.contexts(project.id) }
      }
      try Task.checkCancellation(); contexts = values; optionsFailure = nil
    } catch { if !Task.isCancelled { optionsFailure = displayError(error) } }
    await loadModels()
  }
  private func submit(retry: Bool = false) {
    guard !saving, model.current, session.canWrite else { return }
    if !retry {
      guard validation == nil else { return }
      var body = draft.body(editing: task != nil); body["enabled"] = enabled
      if let revision { body["expectedRevision"] = revision }
      submittedBody = body; submittedKey = UUID().uuidString
    }
    guard let body = submittedBody else { return }
    saving = true; failure = nil
    saveOperation = Task {
      defer { saving = false }
      do {
        let result = try await model.call { try await $0.save(body, id: task?.id, key: submittedKey) }
        try Task.checkCancellation(); uncertain = false; saved(result)
      } catch {
        guard !Task.isCancelled, model.current else { return }
        failure = displayError(error)
        if let error = error as? ScheduledFailure {
          conflict = error.code == "revision_conflict"
          uncertain = false
        } else if case APIError.writeRequiresRetry = error { uncertain = true }
        else if error is URLError || (error as? APIError).map({ if case .invalidResponse = $0 { return true }; if case .http(let status) = $0 { return status >= 500 }; return false }) == true { uncertain = true }
      }
    }
  }
}
private struct ScheduledTimeZonePicker: View {
  @Environment(\.dismiss) private var dismiss
  @Binding var selection: String
  @State private var query = ""
  var body: some View {
    List(TimeZone.knownTimeZoneIdentifiers.filter { query.isEmpty || $0.localizedCaseInsensitiveContains(query) }, id: \.self) { zone in
      Button { selection = zone; dismiss() } label: {
        HStack { Text(zone); Spacer(); if zone == selection { Image(systemName: "checkmark") } }
      }
    }.searchable(text: $query, prompt: "搜索时区").navigationTitle("时区")
  }
}
