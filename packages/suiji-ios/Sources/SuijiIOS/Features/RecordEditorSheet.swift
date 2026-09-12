import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
struct RecordEditorSheet: View {
  @ObservedObject var model: EditorModel
  @Environment(\.dismiss) private var dismiss
  @State private var photo: PhotosPickerItem?
  @State private var choosingFile = false
  @State private var discarding = false
  @State private var preview: LocalAttachment?
  @FocusState private var focused: Bool
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Picker("记录类型", selection: $model.draft.kind) { Text("想法").tag(RecordKind.note); Text("待办").tag(RecordKind.task) }
            .pickerStyle(.segmented).disabled(!model.editable)
          if model.draft.recordID != nil {
            Text("切换为待办时设为未完成；切换为想法时清除待办状态。").font(.footnote).foregroundStyle(.secondary)
          }
          TextEditor(text: $model.draft.body).contentMargins(.bottom, 20, for: .scrollContent)
            .frame(height: 240).focused($focused).disabled(!model.editable)
            .accessibilityLabel("正文").scrollContentBackground(.hidden).padding(8).foregroundStyle(SuijiTheme.ink).background(SuijiTheme.surface, in: RoundedRectangle(cornerRadius: 12))
          Text("\(model.draft.body.unicodeScalars.count) / \(model.limits.bodyScalars)").font(.caption).foregroundStyle(.secondary)
          ForEach(model.draft.existing) { attachment in
            HStack { Label(attachment.fileName, systemImage: attachment.kind == "image" ? "photo" : "doc.text"); Spacer()
              Button("移除") { model.draft.existing.removeAll { $0.id == attachment.id }; Task { await model.persist() } }.disabled(!model.editable)
            }
          }
          ForEach(model.draft.local) { attachment in
            HStack {
              Button { preview = attachment } label: { Label("\(attachment.fileName)（\(attachment.byteSize / 1024) KiB）", systemImage: attachment.kind == "image" ? "photo" : "doc.text") }
              Spacer(); Button("移除") { Task { await model.removeLocal(attachment) } }.disabled(!model.editable)
            }
          }
          HStack(spacing: 24) {
            PhotosPicker(selection: $photo, matching: .images) { Label("图片", systemImage: "photo") }
            Button { choosingFile = true } label: { Label("Markdown", systemImage: "doc.badge.plus") }
          }.disabled(!model.editable)
          Text(model.message).font(.footnote).foregroundStyle(model.draft.frozen ? .orange : .secondary).accessibilityIdentifier("draft-status")
          if model.draft.conflict {
            Button("查看最新内容与本地草稿") { Task { await model.compare() } }
            if let latest = model.latest {
              Text("云端最新（版本 \(latest.version)）").font(.headline)
              Text("云端类型：\(latest.kind == .note ? "想法" : "待办")").font(.subheadline)
              Text(verbatim: latest.body).textSelection(.enabled)
              Text("本地草稿").font(.headline); Text(verbatim: model.draft.body).textSelection(.enabled)
              Text("继续编辑将保留本地正文和类型，采用云端最新附件；可再次调整后保存。").font(.footnote)
              Button("已比较，基于最新版本继续编辑") { Task { await model.rebase() } }
            }
          }
          Button("放弃草稿", role: .destructive) { discarding = true }.disabled(!model.editable)
        }.padding(20)
      }.background(SuijiTheme.background)
      .navigationTitle(model.draft.recordID == nil ? "随手记下" : "编辑记录").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("收起") { focused = false; dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(model.busy ? "保存中…" : model.draft.frozen ? "重试确认" : "保存") { focused = false; Task { await model.save(); if model.confirmed { dismiss() } } }
            .disabled(model.busy || model.draft.conflict)
        }
        ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("收起键盘") { focused = false } }
      }
      .onChange(of: model.draft.body) { _, _ in Task { await model.persist() } }
      .onChange(of: model.draft.kind) { _, _ in Task { await model.persist() } }
      .onChange(of: photo) { _, item in Task { await importPhoto(item) } }
      .fileImporter(isPresented: $choosingFile, allowedContentTypes: [.item]) { result in Task { await importMarkdown(result) } }
      .confirmationDialog("放弃本机草稿？服务器记录不会被删除。", isPresented: $discarding, titleVisibility: .visible) {
        Button("放弃草稿", role: .destructive) { Task { if await model.discard() { dismiss() } } }
      }
      .sheet(item: $preview) { item in AttachmentReader(title: item.fileName, kind: item.kind) { try await model.store.data(item) } }
    }
  }
  private func importPhoto(_ item: PhotosPickerItem?) async {
    guard let item else { return }
    do {
      guard let data = try await item.loadTransferable(type: Data.self) else { throw MessageError(message: "图片读取失败") }
      let jpeg = try await Task.detached(priority: .userInitiated) {
        guard let image = UIImage(data: data), let bytes = image.jpegData(compressionQuality: 0.9) else { throw MessageError(message: "图片无法转换为 JPEG") }; return bytes
      }.value
      await model.add(data: jpeg, name: "图片.jpg", mime: "image/jpeg", kind: "image")
    } catch { model.message = error.localizedDescription }; photo = nil
  }
  private func importMarkdown(_ result: Result<URL, Error>) async {
    do {
      let url = try result.get()
      let data = try await Task.detached(priority: .userInitiated) {
        let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard ["md", "markdown", "mdown"].contains(url.pathExtension.lowercased()) else { throw MessageError(message: "请选择 Markdown 文件") }
        let values = try url.resourceValues(forKeys: [.fileSizeKey])
        guard let size = values.fileSize, size <= 5 * 1024 * 1024 else { throw MessageError(message: "Markdown 超过 5 MiB") }
        let data = try Data(contentsOf: url)
        guard let string = String(data: data, encoding: .utf8), !string.contains("\0") else { throw MessageError(message: "Markdown 必须为有效 UTF-8") }; return data
      }.value
      await model.add(data: data, name: url.lastPathComponent, mime: "text/markdown", kind: "markdown")
    } catch { model.message = error.localizedDescription }
  }
}
