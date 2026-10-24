import SwiftUI
struct WorkRecordEditor: View {
  @ObservedObject var model: WorkRecordModel
  let id: String
  @FocusState private var focused: Bool
  private var draft: WorkDraft? { model.local.drafts[id] }
  private var fields: Binding<WorkFactInput> { Binding(get: { draft?.fields ?? WorkFactInput(date: WorkRecordModel.today()) }, set: { model.update($0) }) }
  var body: some View {
    VStack(spacing: 0) {
      HStack { Button("返回") { focused = false; model.editorID = nil }.disabled(model.busy); Spacer(); Text(draft?.base == nil ? "补记事实" : "编辑事实").font(.headline); Spacer(); Button(draft?.pending == nil ? "保存" : "手动确认原请求") { focused = false; Task { await model.save() } }.disabled(model.busy) }.padding()
      Form {
        if !model.message.isEmpty { Text(model.message).foregroundStyle(.orange) }
        if draft?.pending != nil { Text("保存结果待确认。原请求已保存在本机，重启不会自动发送。") }
        Section("工作事实") {
          DatePicker("工作日期", selection: Binding(get: { WorkDateCodec.date(fields.wrappedValue.workDate) }, set: { fields.wrappedValue.workDate = WorkDateCodec.string($0) }), displayedComponents: .date)
          TextField("标题", text: fields.title).accessibilityLabel("事实标题").focused($focused)
          TextField("只记录事实", text: fields.statement, axis: .vertical).lineLimit(8...20).accessibilityLabel("事实正文").focused($focused)
          Picker("实际状态", selection: fields.status) { ForEach(WorkStatus.allCases, id: \.self) { Text($0.label).tag($0) } }
          TextField("项目（可选，默认未归类）", text: Binding(get: { fields.wrappedValue.project ?? "" }, set: { fields.wrappedValue.project = $0.isEmpty ? nil : $0 })).accessibilityLabel("事实项目").focused($focused)
        }.disabled(model.busy || draft?.pending != nil)
        if draft?.base != nil, draft?.pending == nil {
          Section { Button("读取最新版本并保留草稿") { Task { await model.refreshVersion() } }.disabled(model.busy)
            if let detail = model.detail, detail.id == id { Text("服务当前 v\(detail.version) · \(detail.workDate) · \(detail.project ?? "未归类")").font(.caption); Text(detail.title).bold(); Text(detail.statement) }
          }
        }
        Button("丢弃未保存草稿", role: .destructive) { Task { await model.discard() } }.disabled(model.busy || draft?.pending != nil)
      }.scrollDismissesKeyboard(.interactively)
    }.toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("收起键盘") { focused = false } } }.environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!)
  }
}
enum WorkDateCodec {
  static func formatter() -> DateFormatter { let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "yyyy-MM-dd"; return f }
  static func date(_ value: String) -> Date { formatter().date(from: value) ?? Date() }
  static func string(_ value: Date) -> String { formatter().string(from: value) }
}
