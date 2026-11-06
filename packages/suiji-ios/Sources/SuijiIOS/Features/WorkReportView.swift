import SwiftUI
struct WorkReportFeedButton: View {
  @ObservedObject var model: WorkRecordModel
  let report: WorkReport
  var body: some View {
    Button { Task { await model.openReport(report) } } label: { WorkReportCard(report: report) }
      .buttonStyle(.plain).accessibilityLabel("周报，\(report.title)，\(report.from)至\(report.to)")
  }
}
struct WorkReportCard: View {
  let report: WorkReport
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("周报 · \(report.from) — \(report.to)").font(.caption).foregroundStyle(SuijiTheme.green)
      Text(report.title).font(.headline)
      Text(report.body.replacingOccurrences(of: "*", with: "").replacingOccurrences(of: "#", with: "")).font(.callout).lineLimit(2).lineSpacing(5)
      let missing = report.days.filter { $0.coverage != "complete" }.count
      Text(missing > 0 ? "\(missing) 天来源尚未齐全 · 查看完整周报 →" : "查看完整周报 →").font(.caption).foregroundStyle(.secondary)
    }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
      .background(SuijiTheme.green.opacity(0.05), in: RoundedRectangle(cornerRadius: 16))
      .overlay(RoundedRectangle(cornerRadius: 16).stroke(SuijiTheme.green.opacity(0.4)))
  }
}
struct WorkReportView: View {
  @ObservedObject var model: WorkRecordModel
  let report: WorkReport
  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Button("返回工作") { model.reportDetail = nil; model.reportEditing = false }.disabled(model.busy)
        Spacer()
        Button(model.reportEditing ? (model.reportDraft?.pending == nil ? "保存" : "手动确认原请求") : "编辑周报") { Task { if model.reportEditing { await model.saveReport() } else { await model.editReport() } } }.disabled(model.busy)
      }.padding(20)
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Text("\(report.from) — \(report.to) · 七个自然日").font(.subheadline).foregroundStyle(.secondary)
          Text("根据 \(report.sourceFacts.count) 条工作事实整理" + (report.manuallyEdited ? " · 已人工编辑" : "")).font(.caption).foregroundStyle(.secondary)
          let missing = report.days.filter { $0.coverage != "complete" }.map(\.date)
          if !missing.isEmpty { Text("来源未齐：" + missing.joined(separator: "、") + "。未上报不代表没有工作。").font(.callout).foregroundStyle(.orange) }
          if !model.message.isEmpty { Text(model.message).foregroundStyle(.orange) }
          if model.reportEditing, let draft = model.reportDraft {
            TextField("周报标题", text: Binding(get: { model.reportDraft?.title ?? "" }, set: { model.updateReport(title: $0) })).textFieldStyle(.roundedBorder).accessibilityLabel("周报标题").disabled(draft.pending != nil || model.busy)
            TextEditor(text: Binding(get: { model.reportDraft?.body ?? "" }, set: { model.updateReport(body: $0) })).frame(minHeight: 440).accessibilityLabel("周报正文").disabled(draft.pending != nil || model.busy)
            if draft.pending != nil { Text("保存结果待确认，返回或重启不会自动发送。").font(.footnote) }
            else { Button("读取最新版本并保留草稿") { Task { await model.refreshReportVersion() } }.disabled(model.busy) }
          } else {
            Text(report.title).font(.title2.bold())
            RecordBody(text: report.body)
          }
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
      }
      Button("查看原始日志") { model.reportDetail = nil; model.reportEditing = false; Task { await model.show("logs", from: report.from, to: report.to) } }.buttonStyle(.bordered).padding(16).disabled(model.busy)
    }
  }
}
