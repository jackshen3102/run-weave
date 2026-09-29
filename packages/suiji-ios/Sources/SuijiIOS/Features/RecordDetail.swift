import SwiftUI
import UIKit
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
  @State private var showingFollowups = false
  @State private var copyFeedback = ""
  @Environment(\.dismiss) private var dismiss
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @State private var attachment: Attachment?
  private var record: SuijiRecord {
    let candidates = [original, refreshed, session.lastChangedRecord.flatMap { $0.id == original.id ? $0 : nil }, session.records.first { $0.id == original.id }].compactMap { $0 }
    return candidates.reduce(original) { mergeSuijiRecord($0, $1) }
  }
  private var pending: Bool { session.pendingStatuses.contains(record.id) }
  private var busy: Bool { session.statusBusy.contains(record.id) }
  private var hasFollowups: Bool { session.info?.features?.followups == true }
  private var hasBottomActions: Bool {
    record.deletedAt == nil && (pending || record.taskStatus == .open || record.taskStatus == .done || hasFollowups)
  }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if let citedVersion, citedVersion != record.version { Text("此记录已更新；回答引用的是版本 \(citedVersion)，下方是当前原文。").font(.footnote).foregroundStyle(.secondary) }
        if let status = record.taskStatus { TaskStatusBadge(status: status) }
        RecordBody(text: record.body, textStyle: .title1, fontWeight: .semibold)
          .frame(maxWidth: .infinity, alignment: .leading)
        if let tags = record.tags, !tags.isEmpty {
          RecordTags(tags: tags) { session.selectedTag = $0; dismiss() }
        }
        ForEach(record.attachments) { item in Button { attachment = item } label: { Label(item.fileName, systemImage: item.kind == "image" ? "photo" : "doc.text") } }
        Text(displayDate(record.createdAt)).font(.caption).foregroundStyle(.secondary)
        if record.deletedAt != nil { Text("已在回收站，恢复后可继续编辑。").foregroundStyle(.secondary) }
        if hasFollowups { followupRow }
        if !session.message.isEmpty { Text(session.message).font(.footnote).foregroundStyle(.orange) }
      }.padding(.horizontal, 25).padding(.top, 24).padding(.bottom, 32)
    }
      .background(SuijiTheme.background)
      .navigationTitle(record.kind == .note ? "想法详情" : "待办详情")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(.hidden, for: .tabBar)
      .safeAreaInset(edge: .bottom, spacing: 0) { if hasBottomActions { bottomBar } }
      .overlay(alignment: .bottom) {
        if !copyFeedback.isEmpty {
          HStack(spacing: 8) {
            Image(systemName: copyFeedback.hasPrefix("复制失败") ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
              .foregroundStyle(SuijiTheme.green)
            Text(copyFeedback).foregroundStyle(SuijiTheme.ink)
          }.font(.footnote.weight(.medium))
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(.regularMaterial, in: Capsule())
            .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
            .padding(.horizontal, 20).padding(.bottom, hasBottomActions ? 80 : 20)
            .allowsHitTesting(false)
            .accessibilityIdentifier("record-copy-feedback")
        }
      }
      .toolbar {
        ToolbarItemGroup(placement: .topBarTrailing) {
          Button { Task { await session.openEditor(record: record) } } label: {
            Image(systemName: "square.and.pencil").frame(minWidth: 44, minHeight: 44)
          }.accessibilityLabel("编辑").disabled(record.deletedAt != nil || pending || busy)
          moreMenu
        }
      }
      .onChange(of: record.body) { _, _ in copyFeedback = "" }
      .task(id: copyFeedback) {
        guard !copyFeedback.isEmpty else { return }
        do { try await Task.sleep(for: .seconds(2.5)) } catch { return }
        copyFeedback = ""
      }
      .confirmationDialog("移入回收站？正文和附件会保留，可随时恢复。", isPresented: $confirmingTrash, titleVisibility: .visible) {
        Button("移入回收站", role: .destructive) { Task { await session.changeRecord(record, action: .trash(true)) } }
        Button("取消", role: .cancel) {}
      }
      .onChange(of: record.deletedAt) { _, _ in dismiss() }
      .sheet(item: $attachment) { item in
        if let client = session.client { AttachmentReader(title: item.fileName, kind: item.kind) { try await client.bytes(path: "api/suiji/v1/attachments/\(item.id)/content") } }
      }
      .sheet(isPresented: $showingFollowups) {
        NavigationStack {
          ScrollView { FollowupsView(session: session, record: record).padding(20) }
            .background(SuijiTheme.background)
            .navigationTitle("跟进")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("关闭") { showingFollowups = false } } }
        }.presentationDetents([.medium, .large])
      }
      .task {
        guard let client = session.client else { return }
        do {
          let value = try await client.request(RecordResponse.self, path: "api/suiji/v1/records/\(original.id)").record
          if session.isCurrent(client) { refreshed = value }
        } catch { if session.isCurrent(client) { session.message = error.localizedDescription } }
      }
  }
  private var followupRow: some View {
    Button { showingFollowups = true } label: {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Text("跟进 · \(record.followupSummary?.count ?? 0) 条")
          Spacer()
          Text("查看")
          Image(systemName: "chevron.right").font(.caption)
        }.font(.subheadline.weight(.medium))
        if let latest = record.followupSummary?.latest {
          Text(latest.excerpt).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
      }.foregroundStyle(SuijiTheme.green)
        .padding(.vertical, 18)
        .contentShape(Rectangle())
        .overlay(alignment: .top) { SuijiTheme.border.frame(height: 1) }
        .overlay(alignment: .bottom) { SuijiTheme.border.frame(height: 1) }
    }.buttonStyle(.plain).accessibilityIdentifier("record-followups")
  }
  private var bottomBar: some View {
    bottomLayout {
      if pending {
        Button("操作结果待确认 · 重试确认") { Task { await session.changeRecord(record, action: .status(.done)) } }
          .buttonStyle(DetailActionStyle(primary: true)).disabled(busy)
      } else if record.taskStatus == .open {
        Button { Task { await session.changeRecord(record, action: .status(.done)) } } label: {
          Label("完成待办", systemImage: "checkmark")
        }.buttonStyle(DetailActionStyle(primary: true)).disabled(busy)
      } else if record.taskStatus == .done {
        Button { Task { await session.changeRecord(record, action: .status(.open)) } } label: {
          Label("恢复未完成", systemImage: "arrow.uturn.backward")
        }.buttonStyle(DetailActionStyle(primary: true)).disabled(busy)
      }
      if hasFollowups {
        Button(action: copyHandoff) { Label("交给 Agent", systemImage: "sparkles") }
          .buttonStyle(DetailActionStyle(primary: false)).disabled(busy)
          .accessibilityHint("复制交接指令，粘贴到 Agent 对话中")
      }
    }
    .padding(.horizontal, 20).padding(.top, 12).padding(.bottom, 8)
    .background(SuijiTheme.background)
  }
  private var bottomLayout: AnyLayout {
    dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 10)) : AnyLayout(HStackLayout(spacing: 10))
  }
  private var moreMenu: some View {
    Menu {
      if hasFollowups, record.deletedAt == nil {
        Button { Task { await session.openFollowup(record) } } label: { Label("追加跟进", systemImage: "plus") }
          .disabled(pending || busy)
        Button { showingFollowups = true } label: { Label("刷新跟进", systemImage: "arrow.clockwise") }
      }
      Button(action: copyBody) { Label("复制正文", systemImage: "doc.on.doc") }
        .disabled(record.body.isEmpty)
        .accessibilityIdentifier("copy-record-body")
      if let onReview, record.deletedAt == nil {
        Button { onReview(record) } label: { Label("聊聊这条", systemImage: "bubble.left") }
      }
      if record.deletedAt == nil, record.kind == .task, record.taskStatus != .open {
        Button { Task { await session.openEditor(kind: .task, body: record.body) } } label: { Label("再建一个待办", systemImage: "plus.square") }
      }
      Divider()
      if record.deletedAt != nil {
        Button { Task { await session.changeRecord(record, action: .trash(false)) } } label: { Label("恢复记录", systemImage: "arrow.uturn.backward") }
          .disabled(pending || busy)
      } else {
        if record.taskStatus == .open {
          Button { Task { await session.changeRecord(record, action: .status(.archived)) } } label: { Label("不再做", systemImage: "archivebox") }
            .disabled(pending || busy)
        }
        Button(role: .destructive) { confirmingTrash = true } label: { Label("移入回收站", systemImage: "trash") }
          .disabled(pending || busy)
      }
    } label: { Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44) }
      .accessibilityLabel("更多操作")
  }
  private func copyBody() {
    UIPasteboard.general.string = record.body
    copyFeedback = record.attachments.isEmpty ? "正文已复制" : "正文已复制，附件未包含"
    UIAccessibility.post(notification: .announcement, argument: copyFeedback)
  }
  private func copyHandoff() {
    guard let info = session.info else { return }
    do { UIPasteboard.general.string = try suijiHandoff(endpoint: session.endpoint, info: info, recordID: record.id); copyFeedback = "交接指令已复制" }
    catch { copyFeedback = "复制失败，请重试" }
    UIAccessibility.post(notification: .announcement, argument: copyFeedback)
  }
}
private struct DetailActionStyle: ButtonStyle {
  let primary: Bool
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.subheadline.weight(.semibold))
      .lineLimit(1)
      .frame(maxWidth: .infinity, minHeight: 52)
      .foregroundStyle(primary ? SuijiTheme.onGreen : SuijiTheme.green)
      .background(primary ? SuijiTheme.green : SuijiTheme.pale, in: RoundedRectangle(cornerRadius: 16))
      .opacity(configuration.isPressed ? 0.8 : 1)
  }
}
