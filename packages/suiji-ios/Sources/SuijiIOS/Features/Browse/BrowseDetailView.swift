import Clarity
import SwiftUI
struct BrowseDetailView: View {
  @ObservedObject var model: BrowseModel; let original: BrowseEntry
  @State private var loaded: BrowseEntry?; @State private var note = ""; @State private var provider = ""; @State private var sourceName = ""
  @State private var history: BrowseHistory?; @State private var attachment: Attachment?; @State private var confirming = false
  @Environment(\.suijiOpenLink) private var openLink
  private var entry: BrowseEntry { loaded ?? original }
  var body: some View {
    ScrollView {
      VStack(alignment:.leading,spacing:16) {
        Text(entry.title).font(.title2.bold()); Text(entry.source.displayName + (entry.source.displayName == browseType(entry.contentType) ? "" : " · " + browseType(entry.contentType))).font(.subheadline)
        Text(entry.contentType == "app-usage" ? "统计日期：" + entry.browseDate : (entry.occurredAt == nil ? "保存于 " : "浏览过 ") + browseTime(entry.occurredAt ?? entry.capturedAt)).font(.caption).foregroundStyle(.secondary)
        if entry.contentState.state != "available" { Text("正文范围：" + browseReason(entry.contentState.reason)).foregroundStyle(.orange) }
        RecordBody(text:entry.body ?? entry.excerpt ?? "")
        ForEach(entry.attachments) { file in Button(file.fileName) { attachment = file } }
        if let source = entry.sourceUrl, let url = URL(string:source) { Button("打开原文") { openLink?(url) }.accessibilityIdentifier("browse-original") }
        if entry.deletedAt == nil {
          Text("我的备注").font(.headline); TextEditor(text:$note).disabled(model.local.operations[entry.id] != nil).frame(minHeight:100).overlay(RoundedRectangle(cornerRadius:8).stroke(.quaternary))
          if entry.source.connectionId == nil {
            Text("来源").font(.headline)
            TextField("来源名称，例如未标注",text:$sourceName)
          }
          Button(model.local.operations[entry.id] == nil ? "保存备注与来源" : "确认原保存请求") { Task {
            var fields:[String:Any] = ["userNote":note]
            if entry.source.connectionId == nil { fields["source"] = ["provider":provider,"displayName":sourceName,"connectionId":NSNull()] }
            if let value = await model.mutate(entry,fields:fields) { loaded = value }
          } }.disabled(model.busy)
          Button("移到浏览回收站",role:.destructive) { confirming = true }.disabled(model.busy || model.local.operations[entry.id] != nil)
        } else { Button("恢复浏览条目") { Task { if let value = await model.mutate(entry,fields:["trashed":false],trash:true) { loaded = value } } }.disabled(model.busy) }
        if let history {
          if !history.followups.isEmpty { Text("迁移前跟进（只读）").font(.headline); ForEach(history.followups) { item in Text(item.body); ForEach(item.attachments) { file in Button(file.fileName) { attachment = file } } } }
          ForEach(history.revisions,id:\.version) { revision in DisclosureGroup("历史版本 \(revision.version)") { Text(revision.snapshot.body).textSelection(.enabled); ForEach(revision.snapshot.attachments) { file in Button(file.fileName) { attachment = file } } } }
        }
        if !model.message.isEmpty { Text(model.message).foregroundStyle(.orange) }
      }.padding(20)
    }.clarityMask().navigationTitle("浏览详情").navigationBarTitleDisplayMode(.inline)
      .task {
        do {
          loaded = try await model.detail(original); note = entry.userNote; provider = entry.source.provider; sourceName = entry.source.displayName
          if let client = model.session.client { history = try? await client.request(BrowseHistory.self,path:"api/suiji/v1/browse/entries/" + entry.id + "/history") }
        } catch { model.message = error.localizedDescription }
      }
      .confirmationDialog("仅删除随记里的浏览条目，不影响远端历史。",isPresented:$confirming) { Button("移到回收站",role:.destructive) { Task { if let value = await model.mutate(entry,fields:["trashed":true],trash:true) { loaded = value } } } }
      .sheet(item:$attachment) { file in AttachmentReader(title:file.fileName,kind:file.kind) {
        guard let client = model.session.client else { throw CancellationError() }
        return try await client.bytes(path:"api/suiji/v1/browse/attachments/" + file.id + "/content")
      } }
  }
}
struct BrowseDigestView: View {
  @ObservedObject var model: BrowseModel; let digest: BrowseDigest
  @State private var entries:[BrowseEntry] = []
  var body: some View {
    List {
      Text(digest.title).font(.title2); if digest.state != "current" { Text("来源已变化，此回顾待更新").foregroundStyle(.orange) }
      Text(digest.body).textSelection(.enabled)
      Section("原始条目（不额外计数）") { ForEach(Array(digest.entryRefs.enumerated()),id:\.element.id) { index, ref in if let entry = entries.first(where:{ $0.id == ref.id }) { NavigationLink { BrowseDetailView(model:model,original:entry) } label: { Text("[\(index + 1)] " + entry.title + (entry.version == ref.version ? "" : "（版本已更新）")) } } else { Text("[\(index + 1)] 条目暂不可读取") } } }
    }.clarityMask().navigationTitle("阅读回顾").task {
      guard let client = model.session.client else { return }
      var result:[BrowseEntry] = []
      for ref in digest.entryRefs {
        if let value = try? await client.request(BrowseEntryResponse.self,path:"api/suiji/v1/browse/entries/" + ref.id), model.session.isCurrent(client) { result.append(value.entry) }
      }
      entries = result
    }
  }
}
