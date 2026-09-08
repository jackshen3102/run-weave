import SwiftUI
struct AttachmentReader: View {
  let title: String
  let kind: String
  let load: () async throws -> Data
  @State private var data: Data?
  @State private var error = ""
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      ScrollView {
        if let data {
          if kind == "image", let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFit().accessibilityLabel(title) }
          else { Text(verbatim: String(data: data, encoding: .utf8) ?? "无法读取 UTF-8 内容").textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding() }
        } else if !error.isEmpty { Text(error).padding() } else { ProgressView("正在读取附件") }
      }.navigationTitle(title).navigationBarTitleDisplayMode(.inline).toolbar { Button("关闭") { dismiss() } }
        .task { do { data = try await load() } catch { self.error = error.localizedDescription } }
    }
  }
}
struct RecordDetail: View {
  @ObservedObject var session: SuijiSession
  let original: SuijiRecord
  var onReview: ((SuijiRecord) -> Void)? = nil
  var citedVersion: Int? = nil
  @State private var refreshed: SuijiRecord?
  @State private var confirmingTrash = false
  @Environment(\.dismiss) private var dismiss
  @State private var attachment: Attachment?
  private var record: SuijiRecord {
    let candidates = [original, refreshed, session.lastChangedRecord.flatMap { $0.id == original.id ? $0 : nil }, session.records.first { $0.id == original.id }].compactMap { $0 }
    return candidates.max { $0.version < $1.version } ?? original
  }
  private var pending: Bool { session.pendingStatuses.contains(record.id) }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if let citedVersion, citedVersion != record.version { Text("此记录已更新；回答引用的是版本 \(citedVersion)，下方是当前原文。").font(.footnote).foregroundStyle(.secondary) }
        if let status = record.taskStatus { TaskStatusBadge(status: status) }
        Text(verbatim: record.body).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        ForEach(record.attachments) { item in Button { attachment = item } label: { Label(item.fileName, systemImage: item.kind == "image" ? "photo" : "doc.text") } }
        Text(displayDate(record.createdAt)).font(.caption).foregroundStyle(.secondary)
        if record.deletedAt != nil { Text("已在回收站，恢复后可继续编辑。").foregroundStyle(.secondary) }
        if let onReview, record.deletedAt == nil { Button("聊聊这条") { onReview(record) } }
        if pending { Button("操作结果待确认 · 重试确认") { Task { await session.changeRecord(record, action: .status(.done)) } } }
        else if record.deletedAt == nil, record.taskStatus == .open {
          HStack { Button("完成") { Task { await session.changeRecord(record, action: .status(.done)) } }; Spacer(); Button("不再做") { Task { await session.changeRecord(record, action: .status(.archived)) } } }
        }
        if record.deletedAt == nil, record.kind == .task, record.taskStatus != .open {
          Button("再建一个待办") { Task { await session.openEditor(kind: .task, body: record.body) } }
        }
        if record.deletedAt != nil {
          Button("恢复记录") { Task { await session.changeRecord(record, action: .trash(false)) } }.disabled(pending)
        } else {
          Button("移入回收站", role: .destructive) { confirmingTrash = true }.disabled(pending)
        }
        if !session.message.isEmpty { Text(session.message).font(.footnote).foregroundStyle(.orange) }
      }.padding(20).disabled(session.statusBusy.contains(record.id))
    }.navigationTitle(record.kind == .note ? "想法" : "待办").navigationBarTitleDisplayMode(.inline)
      .toolbar { Button("编辑") { Task { await session.openEditor(record: record) } }.disabled(record.deletedAt != nil || pending || session.statusBusy.contains(record.id)) }
      .confirmationDialog("移入回收站？正文和附件会保留，可随时恢复。", isPresented: $confirmingTrash, titleVisibility: .visible) {
        Button("移入回收站", role: .destructive) { Task { await session.changeRecord(record, action: .trash(true)) } }
        Button("取消", role: .cancel) {}
      }
      .onChange(of: record.deletedAt) { _, _ in dismiss() }
      .sheet(item: $attachment) { item in
        if let client = session.client { AttachmentReader(title: item.fileName, kind: item.kind) { try await client.bytes(path: "api/suiji/v1/attachments/\(item.id)/content") } }
      }
      .task {
        guard let client = session.client else { return }
        do {
          let value = try await client.request(RecordResponse.self, path: "api/suiji/v1/records/\(original.id)").record
          if session.isCurrent(client) { refreshed = value }
        } catch { if session.isCurrent(client) { session.message = error.localizedDescription } }
      }
  }
}
