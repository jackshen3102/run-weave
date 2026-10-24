import Clarity
import SwiftUI
struct WorkRecordsView: View {
  @ObservedObject var model: WorkRecordModel
  let onReview: () -> Void
  @State private var filtering = false
  var body: some View {
    Group {
      if let id = model.editorID { WorkRecordEditor(model: model, id: id) }
      else if model.local.batch != nil { WorkReclassificationView(model: model) }
      else if let fact = model.detail {
        ScrollView { VStack(alignment: .leading, spacing: 20) {
          Button("返回工作") { model.detail = nil }
          Text("\(fact.workDate) · \(fact.project ?? "未归类") · \(fact.status.label)").font(.caption).foregroundStyle(.secondary)
          Text(fact.title).font(.title2.bold()); Text(fact.statement).textSelection(.enabled)
          HStack { Button("编辑事实") { Task { await model.edit(fact) } }; Spacer(); Button("重新归类这条") { Task { await model.beginBatch([fact]) } } }
          if !model.message.isEmpty { Text(model.message).foregroundStyle(.orange) }
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading) }
      } else { feed }
    }.background(SuijiTheme.background).navigationTitle("工作").navigationBarTitleDisplayMode(.inline)
      .toolbar { if model.editorID == nil, model.detail == nil, model.local.batch == nil {
        ToolbarItemGroup(placement: .topBarTrailing) {
          Button("日期") { filtering = true }
          Menu { Button("刷新工作") { Task { await model.load() } }; Button("重新归类") { Task { await model.beginBatch([]) } }; if model.local.undo != nil { Button("撤销上次归类") { Task { await model.beginBatch([], undo: true) } } }; Button("AI 回顾", action: onReview) } label: { Image(systemName: "ellipsis").accessibilityLabel("工作更多") }
        }
      } }
      .sheet(isPresented: $filtering) { WorkDateFilter(model: model) }
      .task { await model.initialize() }
      .clarityMask()
  }
  private var dates: [String] { Array(Set(model.items.map(\.workDate))).sorted(by: >) }
  private var feed: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 14) {
        if !model.local.from.isEmpty || !model.local.to.isEmpty { Text("\(model.local.from.isEmpty ? "最早" : model.local.from) 至 \(model.local.to.isEmpty ? "最近" : model.local.to)").font(.caption).foregroundStyle(.secondary) }
        if !model.message.isEmpty { Text(model.message).foregroundStyle(.orange); Button("重新读取") { Task { await model.load() } } }
        ForEach(dates, id: \.self) { date in
          Text(title(date) + " · \(model.days.first { $0.date == date }?.count ?? 0) 条").font(.subheadline).foregroundStyle(.secondary).padding(.top, 8)
          ForEach(model.items.filter { $0.workDate == date }) { fact in
            Button { Task { await model.open(fact.id) } } label: {
              VStack(alignment: .leading, spacing: 10) { Text("\(fact.project ?? "未归类") · \(fact.status.label)").font(.caption).foregroundStyle(.secondary); Text(fact.title).font(.headline); Text(fact.statement).font(.callout).lineSpacing(5) }.frame(maxWidth: .infinity, alignment: .leading).padding(16).background(SuijiTheme.surface, in: RoundedRectangle(cornerRadius: 16))
            }.buttonStyle(.plain).accessibilityLabel(fact.title + "，" + fact.statement)
          }
        }
        if model.loading { ProgressView("正在读取工作事实…").frame(maxWidth: .infinity).padding(30) }
        else if model.items.isEmpty { EmptyState(title: emptyMessage, detail: "仅说明已导入范围，不推断其他机器或渠道没有工作。") }
        if model.nextCursor != nil { Button("加载更多工作记录") { Task { await model.load(more: true) } }.disabled(model.loading).frame(maxWidth: .infinity).padding() }
      }.padding(.horizontal, 20).padding(.bottom, 90)
    }.refreshable { await model.load() }.overlay(alignment: .bottomTrailing) { Button { Task { await model.edit() } } label: { Image(systemName: "plus").font(.title2.bold()).frame(width: 54, height: 54).background(SuijiTheme.green, in: Circle()).foregroundStyle(SuijiTheme.onGreen) }.accessibilityLabel("补记工作事实").padding(20) }
  }
  private var emptyMessage: String {
    if !model.local.from.isEmpty, !model.local.to.isEmpty {
      let count = Int(WorkDateCodec.date(model.local.to).timeIntervalSince(WorkDateCodec.date(model.local.from)) / 86400) + 1
      if count > 0, model.days.count == count, model.days.allSatisfy({ $0.count == 0 && $0.coverage == "complete" }) { return "已导入范围内没有记录" }
    }
    return model.days.contains { $0.coverage == "partial" } ? "记录尚未完整导入" : "这个日期范围尚未导入工作记录"
  }
  private func title(_ date: String) -> String {
    let delta = Int(WorkDateCodec.date(WorkRecordModel.today()).timeIntervalSince(WorkDateCodec.date(date)) / 86400)
    return (delta == 0 ? "今天 · " : delta == 1 ? "昨天 · " : delta == 2 ? "前天 · " : "") + date
  }
}
private struct WorkDateFilter: View {
  @ObservedObject var model: WorkRecordModel
  @Environment(\.dismiss) private var dismiss
  @State private var start = Date()
  @State private var end = Date()
  @State private var hasStart = false
  @State private var hasEnd = false
  var body: some View {
    NavigationStack {
      Form {
        Toggle("开始日期", isOn: $hasStart); if hasStart { DatePicker("从", selection: $start, displayedComponents: .date) }
        Toggle("结束日期", isOn: $hasEnd); if hasEnd { DatePicker("至", selection: $end, displayedComponents: .date) }
        if hasStart && hasEnd && WorkDateCodec.string(start) > WorkDateCodec.string(end) { Text("开始日期不能晚于结束日期").foregroundStyle(.red) }
        Button("应用日期") { Task { await model.dates(from: hasStart ? WorkDateCodec.string(start) : "", to: hasEnd ? WorkDateCodec.string(end) : ""); dismiss() } }.disabled(hasStart && hasEnd && WorkDateCodec.string(start) > WorkDateCodec.string(end))
        Button("清空日期") { Task { await model.dates(from: "", to: ""); dismiss() } }
      }.navigationTitle("日期范围").toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
    }.environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!).onAppear { hasStart = !model.local.from.isEmpty; hasEnd = !model.local.to.isEmpty; start = WorkDateCodec.date(model.local.from); end = WorkDateCodec.date(model.local.to) }
  }
}
