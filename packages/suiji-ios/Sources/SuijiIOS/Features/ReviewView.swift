import SwiftUI

struct ReviewView: View {
  @ObservedObject var session: SuijiSession
  @ObservedObject var model: ReviewModel
  var body: some View {
    Group {
      if session.info?.ai?.enabled != true {
        EmptyState(title: "AI 回顾尚未启用", detail: "当前服务没有可用的回顾模型，记录和待办仍可正常使用。")
      } else {
        ScrollView {
          VStack(alignment: .leading, spacing: 24) {
            Text("从记录里，接着想").font(.title2.bold())
            Text("主动发问后才检索。回答引用原文，保存结论由你决定。").foregroundStyle(.secondary)
            ForEach(model.turns) { turn in
              Text(verbatim: turn.question).padding().frame(maxWidth: .infinity, alignment: .trailing).background(SuijiTheme.pale, in: RoundedRectangle(cornerRadius: 16))
              if let answer = turn.review.answer { answerView(answer) }
            }
            VStack(alignment: .leading, spacing: 14) {
              Picker("回顾范围", selection: $model.scope) {
                Text("全部历史").tag(ReviewScope.all)
                Text("当前待办").tag(ReviewScope.open)
                if model.scope.kind == "record" { Text("这条记录").tag(model.scope) }
              }.disabled(model.running || model.pending)
              TextField("以前有哪些想做、后来放下的事？", text: $model.question, axis: .vertical).lineLimit(3...8).textFieldStyle(.roundedBorder).accessibilityLabel("向随记提问").disabled(model.running || model.pending)
              if model.running { ProgressView("正在检索与回顾…") }
              if !model.message.isEmpty { Text(model.message).font(.footnote).foregroundStyle(.orange) }
              HStack {
                if model.job?.status == "running" {
                  Button("查询进度") { Task { await model.refresh() } }
                  Spacer(); Button("取消回顾") { Task { await model.cancel() } }
                } else {
                  Spacer(); Button(model.pending ? "手动确认请求" : "发送") { Task { await model.submit() } }.buttonStyle(.borderedProminent).foregroundStyle(SuijiTheme.onGreen).disabled(model.starting || model.question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
              }
              if !model.message.isEmpty, !model.starting { Button("结束此次等待，重新提问") { model.endWaiting() }.font(.footnote) }
            }.padding().background(SuijiTheme.surface, in: RoundedRectangle(cornerRadius: 16))
            Text("对话仅保留在当前会话，重新登录后不会自动重新执行。服务上的回顾结果保留 30 分钟。").font(.caption).foregroundStyle(.secondary)
          }.padding(20)
        }.background(SuijiTheme.background)
      }
    }.navigationTitle("AI 回顾")
  }
  private func answerView(_ answer: ReviewAnswer) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(verbatim: answer.text).textSelection(.enabled)
      ForEach(Array(answer.citations.enumerated()), id: \.offset) { index, citation in
        NavigationLink { ReviewCitationDetail(session: session, citation: citation) } label: {
          VStack(alignment: .leading, spacing: 6) {
            Text("[\(index + 1)] \(displayDate(citation.createdAt)) · \(citation.taskStatus?.label ?? "想法") · 版本 \(citation.version)").font(.caption).foregroundStyle(.secondary)
            Text(verbatim: citation.quote.isEmpty ? citation.attachment?.fileName ?? "已读取图片附件" : citation.quote).font(.callout).lineLimit(5)
          }.frame(maxWidth: .infinity, alignment: .leading).padding().background(SuijiTheme.pale, in: RoundedRectangle(cornerRadius: 12))
        }.buttonStyle(.plain)
      }
      Text("本次查看 \(answer.coverage.listedRecords) 条摘要、\(answer.coverage.readRecords) 条原文、\(answer.coverage.attachmentReads) 段附件。关键词检索，未启用向量索引，未读取外链。").font(.caption).foregroundStyle(.secondary)
      HStack {
        Button("另存笔记") { Task { await session.openEditor(kind: .note, body: answer.text) } }
        Spacer(); Button("新建待办") { Task { await session.openEditor(kind: .task, body: answer.text) } }
      }
    }.padding().background(SuijiTheme.surface, in: RoundedRectangle(cornerRadius: 16))
  }
}
struct ReviewCitationDetail: View {
  @ObservedObject var session: SuijiSession
  let citation: ReviewCitation
  @State private var record: SuijiRecord?
  @State private var error = ""
  var body: some View {
    Group {
      if let record { RecordDetail(session: session, original: record, citedVersion: citation.version) }
      else if !error.isEmpty { Text(error).padding() }
      else { ProgressView("正在读取原文") }
    }.task {
      guard let client = session.client else { return }
      do {
        let result = try await client.request(RecordResponse.self, path: "api/suiji/v1/records/\(citation.recordId)")
        if session.isCurrent(client) { record = result.record }
      } catch { if session.isCurrent(client) { self.error = error.localizedDescription } }
    }
  }
}
