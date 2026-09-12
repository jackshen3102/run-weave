import Foundation
import SwiftUI
@MainActor final class EditorModel: ObservableObject, Identifiable {
  let id = UUID()
  @Published var draft: Draft
  @Published var busy = false
  @Published var message = ""
  @Published var latest: SuijiRecord?
  @Published var confirmed = false
  let client: APIClient
  let store: DraftStore
  let limits: Limits
  private var active = true
  init(draft: Draft, client: APIClient, store: DraftStore, limits: Limits) {
    self.draft = draft; self.client = client; self.store = store; self.limits = limits
  }
  var canReopen: Bool { active && !confirmed }
  var editable: Bool { !busy && !draft.frozen && !confirmed && active }
  func cancel() { active = false }
  func prepareForCapture(kind: RecordKind, body: String) async {
    guard draft.recordID == nil else { return }
    if editable, !draft.conflict, draft.pending == nil, draft.body.isEmpty, draft.existing.isEmpty, draft.local.isEmpty {
      guard draft.kind != kind || !body.isEmpty else { return }
      draft.kind = kind; draft.body = body; await persist()
    } else if !body.isEmpty {
      message = "已恢复原有草稿，新内容未覆盖它。请先处理当前草稿，再另存。"
    }
  }
  func persist() async {
    draft.revision += 1; let snapshot = draft
    do { try await store.save(snapshot); if active && draft.revision == snapshot.revision { message = "草稿已保存在本机" } }
    catch { if active { message = "草稿写入本机失败，请保留页面：" + error.localizedDescription } }
  }
  func add(data: Data, name: String, mime: String, kind: String) async {
    guard editable else { return }
    let count = draft.existing.filter { $0.kind == kind }.count + draft.local.filter { $0.kind == kind }.count
    let max = kind == "image" ? limits.imagesPerRecord : limits.markdownPerRecord
    guard count < max else { message = "此类附件已达上限，请先明确移除已有附件"; return }
    do {
      let item = try await store.importFile(data: data, fileName: name, mimeType: mime, kind: kind, limit: limits.attachmentBytes)
      guard active, editable else { return }; draft.local.append(item); await persist()
    } catch { message = error.localizedDescription }
  }
  func removeLocal(_ item: LocalAttachment) async {
    guard editable else { return }
    draft.local.removeAll { $0.id == item.id }; draft.revision += 1
    do { try await store.save(draft); try await store.removeLocal(item); message = "草稿已保存在本机" }
    catch { message = "移除附件后写盘失败：" + error.localizedDescription }
  }
  func save() async {
    guard !busy, active, !confirmed else { return }
    guard !draft.conflict else { message = "请先查看并处理版本冲突"; return }
    busy = true; defer { busy = false }
    do {
      guard draft.body.unicodeScalars.count <= limits.bodyScalars, !draft.body.contains("\0") else { throw MessageError(message: "正文超出限额或包含无效字符") }
      guard !draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !draft.local.isEmpty || !draft.existing.isEmpty else { throw MessageError(message: "请输入正文或添加附件") }
      draft.frozen = true; draft.revision += 1; try await store.save(draft)
      for index in draft.local.indices where draft.local[index].uploaded == nil {
        try checkActive()
        let item = draft.local[index], bytes = try await store.data(item), boundary = UUID().uuidString
        var multipart = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(item.fileName.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "_").replacingOccurrences(of: "\n", with: "_"))\"\r\nContent-Type: \(item.mimeType)\r\n\r\n".utf8)
        multipart.append(bytes); multipart.append(Data("\r\n--\(boundary)--\r\n".utf8))
        let result = try await client.request(UploadResponse.self, path: "api/suiji/v1/uploads", method: "POST", data: multipart, key: item.uploadKey, contentType: "multipart/form-data; boundary=\(boundary)")
        try checkActive(); draft.local[index].uploaded = result.attachment; draft.revision += 1; try await store.save(draft)
      }
      if draft.pending == nil {
        let ids = draft.existing.map(\.id) + draft.local.compactMap { $0.uploaded?.id }
        var payload: [String: Any] = ["kind": draft.kind.rawValue, "body": draft.body, "attachmentIds": ids]
        if let version = draft.expectedVersion { payload["expectedVersion"] = version }
        draft.pending = PendingOperation(path: "api/suiji/v1/records" + (draft.recordID.map { "/" + $0 } ?? ""), method: draft.recordID == nil ? "POST" : "PATCH", payload: try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
        draft.revision += 1; try await store.save(draft)
      }
      try checkActive(); guard let operation = draft.pending else { return }
      let result = try await client.request(RecordResponse.self, path: operation.path, method: operation.method, data: operation.payload, key: operation.key)
      try checkActive()
      guard result.record.body == draft.body, result.record.kind == draft.kind,
        draft.recordID == nil || result.record.id == draft.recordID,
        UUID(uuidString: result.record.id) != nil, result.record.version >= (draft.expectedVersion ?? 1),
        result.record.attachments.map(\.id) == draft.existing.map(\.id) + draft.local.compactMap({ $0.uploaded?.id }) else { throw MessageError(message: "响应与保存内容不一致，请重试确认") }
      try await store.remove(draft); confirmed = true; message = "已保存"
    } catch is CancellationError { return }
    catch let error as APIError {
      guard active else { return }
      if error.error.code == "VERSION_CONFLICT" {
        draft.frozen = false; draft.pending = nil; draft.conflict = true
        message = "版本冲突，草稿保留在本机。请查看最新内容后决定。"
      } else if !error.uncertain {
        draft.frozen = false; draft.pending = nil; message = error.localizedDescription
      } else { message = "保存结果待确认，请手动重试确认。" }
      draft.revision += 1
      do { try await store.save(draft) } catch { message += " 本机状态写入失败，请保留页面。" }
    } catch { if active { message = draft.frozen ? "保存结果待确认：\(error.localizedDescription)" : error.localizedDescription } }
  }
  private func checkActive() throws { if !active { throw CancellationError() } }
  func compare() async {
    guard let id = draft.recordID, active else { return }
    do { let result = try await client.request(RecordResponse.self, path: "api/suiji/v1/records/" + id); if active { latest = result.record } }
    catch { if active { message = error.localizedDescription } }
  }
  func rebase() async {
    guard let latest, active else { return }
    draft.expectedVersion = latest.version; draft.existing = latest.attachments
    // A retained local upload already bound in the remote result must not be added twice.
    draft.local.removeAll { item in latest.attachments.contains { $0.id == item.uploaded?.id } }
    draft.conflict = false; draft.pending = nil; draft.frozen = false; self.latest = nil; await persist()
  }
  func discard() async -> Bool {
    guard editable else { return false }
    do { try await store.remove(draft); active = false; return true } catch { message = error.localizedDescription; return false }
  }
}
