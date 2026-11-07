import Clarity
import SwiftUI
import SuijiCaptureCore

struct MaterialEditorFields: View {
  @ObservedObject var model: EditorModel
  private var category: Binding<String> { Binding(get: { model.draft.material != nil ? "material" : model.draft.kind.rawValue }, set: { model.selectCategory($0) }) }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Picker("记录类型", selection: category) {
        Text("想法").tag("note"); Text("待办").tag("task")

      }.pickerStyle(.segmented)
      if model.draft.material != nil {
        DatePicker("归属日期", selection: Binding(get: { model.draft.material?.date ?? Date() }, set: { model.draft.material?.materialDate = MaterialInput.day($0) }), in: ...Date(), displayedComponents: .date)
          .environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!)
        Text("这是升级前的素材草稿。原请求保留，服务将其保存到浏览；结果未知时请确认原请求。").font(.footnote).foregroundStyle(.secondary)
      }
    }.disabled(!model.editable)
  }
}
struct MaterialFeedControls: View {
  @ObservedObject var session: SuijiSession
  @State private var range = "all"
  @State private var from = Date()
  @State private var to = Date()
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Picker("素材日期", selection: $range) {
        Text("全部日期").tag("all"); Text("今天").tag("today"); Text("昨天").tag("yesterday"); Text("日期范围").tag("range")
      }.pickerStyle(.menu)
      if range == "range" {
        DatePicker("开始", selection: $from, in: ...to, displayedComponents: .date)
        DatePicker("结束", selection: $to, in: from...Date(), displayedComponents: .date)
      }
      if !session.pendingCaptures.isEmpty {
        NavigationLink("待发送 / 结果待确认（\(session.pendingCaptures.count)）") { MaterialQueueView(session: session) }
      }
      if !session.captureMessage.isEmpty { Text(session.captureMessage).font(.footnote).foregroundStyle(.orange) }
    }.environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!)
      .onChange(of: range) { _, _ in update() }.onChange(of: from) { _, _ in update() }.onChange(of: to) { _, _ in update() }
      .onAppear { session.refreshCaptures() }
  }
  private func update() {
    if range == "all" { session.materialFrom = ""; session.materialTo = "" }
    else if range == "range" { session.materialFrom = MaterialInput.day(from); session.materialTo = MaterialInput.day(to) }
    else { let day = MaterialInput.day(Date().addingTimeInterval(range == "yesterday" ? -86400 : 0)); session.materialFrom = day; session.materialTo = day }
  }
}
struct MaterialQueueView: View {
  @ObservedObject var session: SuijiSession
  var body: some View {
    List {
      Text("仅手动重试。结果待确认时会沿用原请求，不会新建另一份浏览内容。").font(.footnote)
      ForEach(session.pendingCaptures) { item in
        VStack(alignment: .leading, spacing: 8) {
          Text(item.material.materialDate + " · " + (item.state == "queued" ? "待发送" : item.state == "confirmed" ? "已保存，待清理" : "保存结果待确认"))
          Text(item.body).textSelection(.enabled)
          if let data = try? CaptureQueue.image(item), let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFit() }
          Button("重试确认") { Task { await session.retryCapture(item) } }.disabled(session.captureBusy)
        }
      }
      if !session.captureMessage.isEmpty { Text(session.captureMessage).foregroundStyle(.orange) }
    }.clarityMask().navigationTitle("待发送浏览").onAppear { session.refreshCaptures() }
  }
}
