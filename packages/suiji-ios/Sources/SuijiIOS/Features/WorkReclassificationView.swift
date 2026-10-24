import SwiftUI
struct WorkReclassificationView: View {
  @ObservedObject var model: WorkRecordModel
  @FocusState private var focused: Bool
  private var batch: WorkBatch? { model.local.batch }
  private var locked: Bool { model.busy || batch?.pending != nil }
  private var rows: [WorkFact] { let selected = Set(batch?.rows.map(\.id) ?? []); return (batch?.rows ?? []) + model.items.filter { !selected.contains($0.id) } }
  var body: some View {
    VStack(spacing: 0) {
      HStack { Text(batch?.undo == true ? "撤销本次归类" : "重新归类").font(.headline); Spacer(); Button("取消") { Task { await model.cancelBatch() } }.disabled(locked) }.padding()
      List {
        if !model.message.isEmpty { Text(model.message).foregroundStyle(.orange) }
        if batch?.pending != nil { Text("操作结果待确认。只会在点击手动确认后重发原请求。") }
        if let batch {
          if batch.undo { Text("按成功回执的版本还原 \(model.local.undo?.count ?? 0) 条记录的项目。任一版本变化将整批停止。") }
          else {
            Section {
              Button("读取所选事实最新版本") { Task { await model.refreshBatch() } }.disabled(locked)
              Text("已选 \(batch.rows.count) 条。仅修改项目，保留正文、日期与状态。")
              Button("全选已加载记录") { let ids = Set(batch.rows.map(\.id)); model.updateBatch(rows: batch.rows + model.items.filter { !ids.contains($0.id) }, project: batch.project) }.disabled(locked || rows.count > 100)
              if model.nextCursor != nil { Text("还有未加载记录；返回列表加载后再选择。").font(.caption) }
              TextField("目标项目（留空为未归类）", text: Binding(get: { batch.project }, set: { model.updateBatch(rows: batch.rows, project: $0) })).accessibilityLabel("目标项目").focused($focused).disabled(locked)
              let projects = Array(Set(model.items.compactMap(\.project))).sorted()
              if !projects.isEmpty { Menu("选择已有项目") { Button("未归类") { model.updateBatch(rows: batch.rows, project: "") }; ForEach(projects, id: \.self) { p in Button(p) { model.updateBatch(rows: batch.rows, project: p) } } }.disabled(locked) }
            }
            Section("核对所选事实") {
              ForEach(rows) { fact in
                let selected = batch.rows.contains { $0.id == fact.id }
                Button { model.updateBatch(rows: selected ? batch.rows.filter { $0.id != fact.id } : batch.rows + [fact], project: batch.project) } label: {
                  HStack(alignment: .top) { Image(systemName: selected ? "checkmark.circle.fill" : "circle"); VStack(alignment: .leading, spacing: 5) { Text(fact.title).bold(); Text("\(fact.workDate) · \(fact.project ?? "未归类")").font(.caption); Text(fact.id).font(.caption2).foregroundStyle(.secondary) } }
                }.disabled(locked || (!selected && batch.rows.count >= 100)).accessibilityLabel("选择 " + fact.title).accessibilityAddTraits(selected ? .isSelected : [])
              }
            }
          }
        }
      }.scrollDismissesKeyboard(.interactively)
      if let batch {
        Button(batch.pending != nil ? "手动确认原请求" : batch.undo ? "确认撤销项目调整" : "确认 \(batch.rows.count) 条 → \(batch.project.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "未归类" : batch.project)") { focused = false; Task { await model.commitBatch() } }.disabled(model.busy || (!batch.undo && batch.rows.isEmpty)).buttonStyle(.borderedProminent).padding(16)
      }
    }.toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("收起键盘") { focused = false } } }
  }
}
