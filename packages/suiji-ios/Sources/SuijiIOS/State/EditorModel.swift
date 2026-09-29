import Foundation
import SwiftUI
@MainActor final class EditorModel: ObservableObject, Identifiable {
  let id = UUID()
  @Published var draft: Draft
  @Published var busy = false
  @Published var message = ""
  @Published var latest: SuijiRecord?
  @Published var confirmed = false
  @Published var correction: SuijiCorrection?
  @Published var correctionSource: String?
  @Published var correctionBusy = false
  @Published var correctionMessage = ""
  @Published var lexicon: CorrectionLexicon?
  @Published var lexiconPending = false
  @Published var preferences: CorrectionPreferences?
  @Published var history: CorrectionHistoryPage?
  @Published var feedbackPending = false
  let correctionAvailable: Bool
  let correctionSupported: Bool
  let historySupported: Bool
  private var correctionTask: Task<Void, Never>?
  private var correctionKey: String?
  let client: APIClient
  let store: DraftStore
  let limits: Limits
  var onFollowupSaved: ((FollowupResponse) -> Void)?
  private var active = true
  init(draft: Draft, client: APIClient, store: DraftStore, limits: Limits, correctionCapability: Bool? = nil, historyCapability: Bool? = nil) {
    self.draft = draft; self.client = client; self.store = store; self.limits = limits
    self.correctionAvailable = correctionCapability == true; self.correctionSupported = correctionCapability != nil
    self.historySupported = historyCapability == true
  }
  var canReopen: Bool { active && !confirmed }
  var editable: Bool { !busy && !draft.frozen && !confirmed && active }
  func cancel() { active = false; correctionTask?.cancel() }
  func cancelCorrection() async {
    correctionTask?.cancel()
    if let id = correction?.id { _ = try? await client.request(SuijiCorrection.self, path: "api/suiji/v1/corrections/" + id, method: "DELETE") }
    correction = nil; correctionSource = nil; correctionBusy = false; correctionKey = nil; correctionMessage = ""
  }
  func loadLexicon() async {
    do { let value = try await client.request(CorrectionLexicon.self, path: "api/suiji/v1/correction-lexicon"); try checkActive(); lexicon = value
      lexiconPending = (try await store.lexiconIntent()) != nil
    } catch { if active { correctionMessage = error.localizedDescription } }
  }
  func correct() async {
    guard correctionAvailable, editable, !correctionBusy, !draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    if correctionKey != nil && correctionSource != draft.body {
      correctionMessage = "原请求结果待确认；请先取消，再对新正文发起纠错"
      return
    }
    let source = draft.body, key = correctionKey ?? UUID().uuidString
    correctionKey = key; correctionSource = source; correction = nil; correctionBusy = true; correctionMessage = "正在纠正文字…"
    let task = Task { @MainActor in
      do {
        struct Input: Encodable { let text: String; let recordId: String?; let feedbackCapable: Bool? }
        let eligible = historySupported && draft.followupRecordID == nil
        let payload = try JSONEncoder().encode(Input(text: source, recordId: eligible ? draft.recordID : nil,
          feedbackCapable: eligible ? true : nil))
        var job = try await client.request(SuijiCorrection.self, path: "api/suiji/v1/corrections", method: "POST", data: payload, key: key)
        try checkActive(); correction = job
        while job.status == "running" {
          try await Task.sleep(for: .seconds(1)); try Task.checkCancellation(); try checkActive()
          job = try await client.request(SuijiCorrection.self, path: "api/suiji/v1/corrections/" + job.id)
          correction = job
        }
        try Task.checkCancellation(); try checkActive()
        correction = job; correctionKey = nil
        correctionMessage = job.status == "completed" ? "" : (job.error ?? "纠错未完成")
      } catch is CancellationError { }
      catch { if active { correctionMessage = "纠错结果待确认；再次点击会沿用同一请求。" + error.localizedDescription } }
      if active { correctionBusy = false }
    }
    correctionTask = task
    await task.value
  }
  func applyCorrection() async {
    guard editable, let correction, correction.status == "completed", let text = correction.correctedText,
      correctionSource == draft.body else { correctionMessage = "正文或编辑会话已变化，请重新纠错"; return }
    draft.body = text
    if correction.historyId != nil, let correctionSource {
      draft.correctionTrace = CorrectionTrace(correctionId: correction.id, inputText: correctionSource,
        correctedText: text, applied: true)
    } else { draft.correctionTrace = nil }
    self.correction = nil; correctionSource = nil
    await persist(); correctionMessage = "已应用到本机草稿；点击保存才会更新记录"
  }
  func putLexicon(_ entries: [CorrectionEntry]) async throws {
    try checkActive()
    guard let lexicon else { throw MessageError(message: "请先读取词库") }
    let pending = try await store.lexiconIntent()
    let intent = pending ?? LexiconIntent(key: UUID().uuidString, expectedVersion: lexicon.version, entries: entries)
    if pending == nil { try await store.saveLexiconIntent(intent) }
    lexiconPending = true
    do {
      struct Payload: Encodable { let expectedVersion: Int; let entries: [CorrectionEntry] }
      let payload = try JSONEncoder().encode(Payload(expectedVersion: intent.expectedVersion, entries: intent.entries))
      let value = try await client.request(CorrectionLexicon.self, path: "api/suiji/v1/correction-lexicon", method: "PUT", data: payload, key: intent.key)
      try checkActive(); try await store.removeLexiconIntent(); self.lexicon = value; lexiconPending = false; correctionMessage = "已记住；可在词库中撤销"
    } catch {
      if let api = error as? APIError, !api.uncertain { try? await store.removeLexiconIntent(); lexiconPending = false }
      correctionMessage = error.localizedDescription
      throw error
    }
  }
  func prepareForCapture(kind: RecordKind, body: String) async {
    guard draft.recordID == nil else { return }
    if editable, !draft.conflict, draft.pending == nil, draft.body.isEmpty, (draft.tags ?? []).isEmpty, draft.existing.isEmpty, draft.local.isEmpty {
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
      if draft.followupRecordID == nil, draft.pending == nil, let tags = draft.tags { draft.tags = try SuijiTags.normalize(tags) }
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
        var payload: [String: Any] = ["body": draft.body, "attachmentIds": ids]
        if draft.followupRecordID == nil { payload["kind"] = draft.kind.rawValue }
        if draft.followupRecordID == nil, let tags = draft.tags { payload["tags"] = tags }
        if draft.followupRecordID == nil, let version = draft.expectedVersion { payload["expectedVersion"] = version }
        draft.pending = PendingOperation(path: draft.followupRecordID.map { "api/suiji/v1/records/" + $0 + "/followups" } ?? ("api/suiji/v1/records" + (draft.recordID.map { "/" + $0 } ?? "")), method: draft.recordID == nil ? "POST" : "PATCH", payload: try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]))
        draft.revision += 1; try await store.save(draft)
      }
      try checkActive(); guard let operation = draft.pending else { return }
      if let recordID = draft.followupRecordID {
        let result = try await client.request(FollowupResponse.self, path: operation.path, method: operation.method, data: operation.payload, key: operation.key)
        try checkActive()
        guard result.followup.recordId == recordID, result.followup.body == draft.body,
          result.followup.attachments.map(\.id) == draft.local.compactMap({ $0.uploaded?.id }) else { throw MessageError(message: "跟进响应与保存内容不一致，请重试确认") }
        try await store.remove(draft); confirmed = true; message = "已保存"; onFollowupSaved?(result); return
      }
      let result = try await client.request(RecordResponse.self, path: operation.path, method: operation.method, data: operation.payload, key: operation.key)
      try checkActive()
      guard result.record.body == draft.body, result.record.kind == draft.kind,
        draft.tags == nil || (result.record.tags ?? []) == draft.tags,
        draft.recordID == nil || result.record.id == draft.recordID,
        UUID(uuidString: result.record.id) != nil, result.record.version >= (draft.expectedVersion ?? 1),
        result.record.attachments.map(\.id) == draft.existing.map(\.id) + draft.local.compactMap({ $0.uploaded?.id }) else { throw MessageError(message: "响应与保存内容不一致，请重试确认") }
      if let trace = draft.correctionTrace, trace.applied,
        draft.expectedVersion == nil || result.record.version > draft.expectedVersion!, let operation = draft.pending {
        do {
          var intents = try await store.feedbackIntents()
          intents.append(CorrectionFeedbackIntent(correctionId: trace.correctionId, key: UUID().uuidString,
            recordId: result.record.id, recordVersion: result.record.version, saveKey: operation.key))
          try await store.saveFeedbackIntents(intents)
          feedbackPending = true
        } catch { correctionMessage = "记录已保存；历史反馈在本机排队失败" }
      }
      try await store.remove(draft); confirmed = true; message = "已保存"
      await retryFeedback()
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
  func loadPreferences() async {
    guard historySupported else { return }
    do { let value = try await client.request(CorrectionPreferences.self, path: "api/suiji/v1/correction-preferences")
      try checkActive(); preferences = value
      feedbackPending = !(try await store.feedbackIntents()).isEmpty
    } catch { if active { correctionMessage = error.localizedDescription } }
  }
  func setHistoryEnabled(_ enabled: Bool) async {
    guard let preferences else { return }
    do {
      struct Payload: Encodable { let expectedVersion: Int; let historyEnabled: Bool }
      let data = try JSONEncoder().encode(Payload(expectedVersion: preferences.version, historyEnabled: enabled))
      let value = try await client.request(CorrectionPreferences.self, path: "api/suiji/v1/correction-preferences",
        method: "PUT", data: data, key: UUID().uuidString)
      try checkActive(); self.preferences = value
    } catch { if active { correctionMessage = error.localizedDescription } }
  }
  func loadHistory(cursor: String? = nil) async {
    guard historySupported else { return }
    do { let path = "api/suiji/v1/correction-history" + (cursor.map { "?cursor=" + ($0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "") } ?? "")
      let value = try await client.request(CorrectionHistoryPage.self, path: path)
      try checkActive(); history = cursor == nil ? value : CorrectionHistoryPage(items: (history?.items ?? []) + value.items, nextCursor: value.nextCursor)
    } catch { if active { correctionMessage = error.localizedDescription } }
  }
  func deleteHistory(_ id: String? = nil) async {
    do {
      _ = try await client.request(EmptyResponse.self, path: "api/suiji/v1/correction-history" + (id.map { "/" + $0 } ?? ""),
        method: "DELETE", key: UUID().uuidString)
      try checkActive(); await loadHistory(); await loadPreferences()
    } catch { if active { correctionMessage = error.localizedDescription } }
  }
  func retryFeedback() async {
    guard let intents = try? await store.feedbackIntents(), !intents.isEmpty else { feedbackPending = false; return }
    var remaining: [CorrectionFeedbackIntent] = []
    for intent in intents {
      do {
        struct Payload: Encodable { let recordId: String; let recordVersion: Int; let saveKey: String }
        let data = try JSONEncoder().encode(Payload(recordId: intent.recordId,
          recordVersion: intent.recordVersion, saveKey: intent.saveKey))
        _ = try await client.request(EmptyResponse.self, path: "api/suiji/v1/corrections/" + intent.correctionId + "/feedback",
          method: "POST", data: data, key: intent.key)
      } catch let error as APIError {
        if error.uncertain { remaining.append(intent) }
      } catch { remaining.append(intent) }
    }
    do { try await store.saveFeedbackIntents(remaining); feedbackPending = !remaining.isEmpty }
    catch { feedbackPending = true }
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
