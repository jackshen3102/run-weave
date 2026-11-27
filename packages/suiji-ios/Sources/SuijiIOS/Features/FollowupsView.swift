import Clarity
import SwiftUI

struct FollowupsView: View {
  @ObservedObject var session: SuijiSession
  let record: SuijiRecord
  var match: FollowupSearchMatch? = nil
  @State private var items: [SuijiFollowup] = []
  @State private var cursor: String?
  @State private var showingLatest = false
  @State private var busy = false
  @State private var message = ""
  @State private var requestID = UUID()
  @State private var attachment: Attachment?
  private var matchedID: String? { showingLatest ? nil : match?.id }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text("跟进 \(record.followupSummary?.count ?? items.count) 条").font(.headline)
        Spacer()
        Button(matchedID == nil ? "刷新跟进" : "查看最新跟进") {
          Task { await load(latest: matchedID != nil || showingLatest) }
        }.disabled(busy)
      }
      if items.isEmpty && !busy && message.isEmpty {
        Text("还没有跟进").font(.subheadline).foregroundStyle(.secondary)
      }
      ForEach(items) { item in
        VStack(alignment: .leading, spacing: 8) {
          if item.id == matchedID { Label("命中的跟进", systemImage: "magnifyingglass").font(.caption.weight(.semibold)).foregroundStyle(SuijiTheme.green) }
          Text((item.source.actor == "app" ? "你" : "Agent" + (item.source.agentName.map { " · " + $0 } ?? "")) + " · " + displayDate(item.createdAt)).font(.caption).foregroundStyle(.secondary)
          if let id = item.source.sessionId { Text("会话：" + id).font(.caption).foregroundStyle(.secondary) }
          RecordBody(text: item.body).frame(maxWidth: .infinity, alignment: .leading)
          ForEach(item.attachments) { file in
            Button { attachment = file } label: { Label(file.fileName, systemImage: file.kind == "image" ? "photo" : "doc.text") }
          }
        }.padding(12).background(SuijiTheme.surface, in: RoundedRectangle(cornerRadius: 12))
      }
      if busy { ProgressView("正在读取跟进") }
      if !message.isEmpty {
        Text(message).font(.footnote).foregroundStyle(.orange)
        if matchedID != nil { Button("重试定位") { Task { await load() } }.disabled(busy) }
      }
      if cursor != nil { Button("加载更早跟进") { Task { await load(more: true) } }.disabled(busy) }
    }
    .clarityMask()
    .task(id: record.id + ":" + String(record.followupSummary?.latest?.sequence ?? 0)) { await load() }
    .onDisappear { requestID = UUID() }
    .sheet(item: $attachment) { item in
      if let client = session.client { AttachmentReader(title: item.fileName, kind: item.kind) { try await client.bytes(path: "api/suiji/v1/attachments/\(item.id)/content") } }
    }
    .mobileAnalyticsScreen(.followups)
  }
  private func load(more: Bool = false, latest: Bool? = nil) async {
    guard let client = session.client else { return }
    let request = UUID(); requestID = request; busy = true; message = ""
    defer { if requestID == request { busy = false } }
    do {
      let base = "api/suiji/v1/records/" + record.id
      let useLatest = latest ?? showingLatest
      let start = more ? cursor : (useLatest ? nil : match?.cursor)
      let suffix = start.map { "?cursor=" + ($0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "") } ?? ""
      let page = try await client.request(FollowupPage.self, path: base + "/followups" + suffix)
      guard session.isCurrent(client), requestID == request else { return }
      items = more ? items + page.items.filter { value in !items.contains { $0.id == value.id } } : page.items
      cursor = page.nextCursor
      if !more {
        showingLatest = useLatest
        let current = try await client.request(RecordResponse.self, path: base).record
        if session.isCurrent(client), requestID == request { session.acceptFollowupRecord(current) }
      }
    } catch { if session.isCurrent(client), requestID == request { message = error.localizedDescription } }
  }
}
