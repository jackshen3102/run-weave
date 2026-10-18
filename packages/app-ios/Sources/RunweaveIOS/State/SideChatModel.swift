import Foundation

@MainActor
final class SideChatModel: ObservableObject {
  @Published private(set) var capabilities: SideChatCapabilities?
  @Published private(set) var snapshot: SideChatSnapshot?
  @Published private(set) var draft = SideChatDraft()
  @Published private(set) var pending: SideChatPending?
  @Published private(set) var stale = true
  @Published private(set) var loading = false
  @Published private(set) var failure: String?
  @Published private(set) var unread = false
  @Published var visible = false { didSet { archive.visible = visible; persist() } }
  var commitEditor: (() -> Void)?
  private weak var session: AppSession?
  private let terminalID: String
  private let connectionScope: String
  private var archive = SideChatArchive()
  private var storage: SideChatDraftArchive?
  private var pollTask: Task<Void, Never>?
  private var pollGeneration = 0
  private var refreshing = false
  private var writing = false

  init(session: AppSession, terminalID: String) {
    self.session = session; self.terminalID = terminalID
    connectionScope = session.connection?.scope ?? session.api?.connectionID ?? "unavailable"
    do {
      let scope = session.connection?.scope ?? session.api?.connectionID ?? "unavailable"
      let storage = try SideChatDraftArchive(scope: scope, terminalID: terminalID)
      self.storage = storage; archive = try storage.load()
      if let id = archive.chatID { snapshot = archive.snapshots[id]; draft = archive.drafts[id] ?? SideChatDraft() }
      pending = archive.pending; visible = archive.visible
    } catch { failure = "旁聊草稿读取失败，请保留现有记录。" + displayError(error) }
  }
  var current: Bool { (session?.connection?.scope ?? session?.api?.connectionID ?? "unavailable") == connectionScope && session?.terminal?.id == terminalID }
  private func isCurrent(_ epoch: Int?) -> Bool { current && session?.generation == epoch }
  var canRead: Bool { current && session?.authenticated == true && session?.foreground == true && session?.health.status == .online }
  var busy: Bool { snapshot?.currentTurn?.busy == true }
  var canEnd: Bool {
    canRead && !stale && !writing && snapshot != nil && !["ended", "ending"].contains(snapshot!.sideChat.status)
      && (pending == nil || snapshot?.sideChat.status == "unavailable" || snapshot?.currentTurn?.state == "unknown")
  }
  var canSend: Bool { canRead && !stale && !writing && pending == nil && !busy && snapshot?.sideChat.status == "active" && !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  func startPolling() {
    guard pollTask == nil, canRead else { if !canRead { stale = true }; return }
    pollGeneration += 1
    let epoch = pollGeneration
    pollTask = Task { [weak self] in
      await self?.discover()
      while let self, self.pollGeneration == epoch, self.canRead, !Task.isCancelled {
        await self.refresh()
        let interval: UInt64 = self.visible ? (self.busy ? 1 : 3) : 5
        do { try await Task.sleep(nanoseconds: interval * 1_000_000_000) } catch { break }
      }
      if self?.pollGeneration == epoch { self?.pollTask = nil }
    }
  }
  func suspend() { pollGeneration += 1; pollTask?.cancel(); pollTask = nil; stale = true }
  func discover() async {
    let epoch = session?.generation
    guard canRead, let api = session?.api else { return }
    do {
      let result = try await SideChatService(api: api).capabilities(terminalID: terminalID)
      guard isCurrent(epoch), !Task.isCancelled else { return }; capabilities = result
    } catch { if case APIError.http(404) = error { capabilities = nil } }
  }
  func open() async {
    let epoch = session?.generation
    guard canRead, !loading, let api = session?.api else { return }
    if archive.chatID != nil && snapshot?.sideChat.status != "ended" { visible = true; await refresh(); return }
    loading = true; defer { loading = false }
    var submittedID: String?
    do {
      let service = SideChatService(api: api)
      let caps = try await service.capabilities(terminalID: terminalID)
      guard isCurrent(epoch) else { return }; capabilities = caps
      guard caps.supported, let source = caps.source else { failure = caps.reason ?? "此终端不支持消息旁聊"; return }
      if let id = caps.activeSideChatId { attach(id) }
      else {
        guard pending == nil else { failure = "上次操作结果待核对，请先查询"; return }
        let operation = SideChatPending(operationID: UUID().uuidString, kind: "create", draft: nil)
        submittedID = operation.operationID
        setPending(operation)
        let result = try await service.create(operationID: operation.operationID, source: source)
        guard isCurrent(epoch) else { return }; attach(result.operation.sideChatId)
        if result.operation.state == "unknown" {
          var unresolved = operation; unresolved.chatID = result.operation.sideChatId; setPending(unresolved)
        } else { setPending(nil) }
      }
      visible = true; await refresh()
    } catch { if isCurrent(epoch) { failed(error, operationID: submittedID) } }
  }
  func returnToMain() { commitEditor?(); visible = false }
  private func attach(_ id: String) {
    archive.chatID = id; snapshot = archive.snapshots[id]; draft = archive.drafts[id] ?? SideChatDraft(); persist()
  }
  func edit(text: String, start: Int, end: Int) {
    if draft.text != text { draft.revision += 1 }
    draft.text = text; draft.start = start; draft.end = end
    if let id = archive.chatID { archive.drafts[id] = draft }; persist()
  }
  func refresh() async {
    let epoch = session?.generation
    guard canRead, !refreshing, let id = archive.chatID, let api = session?.api else { return }
    refreshing = true; defer { refreshing = false }
    do {
      let service = SideChatService(api: api)
      var result = try await service.snapshot(id)
      guard isCurrent(epoch), archive.chatID == id, result.sideChat.version >= (snapshot?.sideChat.version ?? 0), !Task.isCancelled else { return }
      let previous = snapshot?.messages ?? []
      var combined = Dictionary(previous.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
      for message in result.messages { combined[message.id] = message }
      var cursor = result.beforeSequence
      if let last = previous.last?.sequence {
        while let before = cursor, before > last + 1 {
          let page = try await service.messages(id, before: before)
          for message in page.messages { combined[message.id] = message }; cursor = page.beforeSequence
        }
      }
      guard isCurrent(epoch), archive.chatID == id, result.sideChat.version >= (snapshot?.sideChat.version ?? 0), !Task.isCancelled else { return }
      if let first = previous.first?.sequence, first < (result.messages.first?.sequence ?? Int.max) { cursor = snapshot?.beforeSequence }
      result.messages = combined.values.sorted { $0.sequence < $1.sequence }; result.beforeSequence = cursor
      snapshot = result; stale = false; archive.snapshots[id] = result
      unread = (result.messages.last { $0.role == "assistant" }?.sequence ?? 0) > (archive.readSequences[id] ?? 0)
      persist()
      if pending != nil { await queryOperation() }
    } catch { if isCurrent(epoch) && !Task.isCancelled { stale = true; failure = displayError(error) } }
  }
  func older() async {
    let epoch = session?.generation
    guard let before = snapshot?.beforeSequence, let id = archive.chatID, let api = session?.api else { return }
    do {
      let page = try await SideChatService(api: api).messages(id, before: before)
      guard isCurrent(epoch), archive.chatID == id, var value = snapshot else { return }
      value.messages = Dictionary((page.messages + value.messages).map { ($0.id, $0) }, uniquingKeysWith: { _, new in new }).values.sorted { $0.sequence < $1.sequence }
      value.beforeSequence = page.beforeSequence; snapshot = value; archive.snapshots[id] = value; persist()
    } catch { if isCurrent(epoch) { failure = displayError(error) } }
  }
  func presented(sequence: Int) {
    guard visible, !stale, let id = archive.chatID else { return }
    archive.readSequences[id] = max(archive.readSequences[id] ?? 0, sequence)
    unread = (snapshot?.messages.last { $0.role == "assistant" }?.sequence ?? 0) > (archive.readSequences[id] ?? 0)
    persist()
  }
  func send() async {
    let epoch = session?.generation
    commitEditor?()
    guard canSend, let value = snapshot, let api = session?.api else { return }
    guard draft.text.utf8.count <= 65_536 else { failure = "正文最多 64 KiB"; return }
    let operation = SideChatPending(operationID: UUID().uuidString, chatID: value.sideChat.id, kind: "turn", draft: draft)
    setPending(operation); writing = true; defer { writing = false }
    do {
      let result = try await SideChatService(api: api).send(value.sideChat.id, operationID: operation.operationID, version: value.sideChat.version, text: draft.text)
      guard isCurrent(epoch) else { return }; accepted(result.operation, submitted: operation); await refresh()
    } catch { if isCurrent(epoch) { failed(error, operationID: operation.operationID) } }
  }
  func stop() async { await write(kind: "stop") }
  func end() async { commitEditor?(); await write(kind: "end") }
  private func write(kind: String) async {
    let epoch = session?.generation
    guard canRead, !stale, !writing, (pending == nil || (kind == "end" && canEnd)), let value = snapshot, let api = session?.api else { return }
    let operation = SideChatPending(operationID: UUID().uuidString, chatID: value.sideChat.id, kind: kind, draft: draft)
    setPending(operation); writing = true; defer { writing = false }
    do {
      let service = SideChatService(api: api)
      let result: SideChatWriteResponse
      if kind == "end" { result = try await service.end(value.sideChat.id, operationID: operation.operationID, version: value.sideChat.version) }
      else if let turn = value.currentTurn { result = try await service.stop(value.sideChat.id, turnID: turn.id, operationID: operation.operationID, version: value.sideChat.version) }
      else { setPending(nil); return }
      guard isCurrent(epoch) else { return }; accepted(result.operation, submitted: operation); await refresh()
    } catch { if isCurrent(epoch) { failed(error, operationID: operation.operationID) } }
  }
  func queryOperation() async {
    let epoch = session?.generation
    guard canRead, var operation = pending, let api = session?.api else { return }
    do {
      let service = SideChatService(api: api)
      if operation.chatID == nil {
        let caps = try await service.capabilities(terminalID: terminalID)
        if let id = caps.activeSideChatId { operation.chatID = id; attach(id) }
      }
      guard let id = operation.chatID else { failure = "创建结果尚未确认，不会自动重发"; return }
      let result = try await service.operation(id, operationID: operation.operationID)
      guard isCurrent(epoch) else { return }; accepted(result, submitted: operation)
    } catch { if isCurrent(epoch) { failure = "操作结果仍未确认，请保留草稿；不会自动重发" } }
  }
  private func accepted(_ result: SideChatOperation, submitted: SideChatPending) {
    guard pending?.operationID == submitted.operationID else { return }
    let retained = submitted.draft?.revision != draft.revision
    if result.state == "unknown" { failure = "执行结果不明，请保留草稿并查询状态"; return }
    if submitted.kind == "end" && result.state != "completed" { return }
    if ["turn", "end"].contains(submitted.kind), submitted.chatID == archive.chatID, submitted.draft?.revision == draft.revision { edit(text: "", start: 0, end: 0) }
    setPending(nil); failure = nil
    if submitted.kind == "end", submitted.chatID == archive.chatID {
      if retained { failure = "旁聊已结束，新编辑的文字已保留，可复制取回" }
      else { visible = false }
    }
  }
  private func failed(_ error: Error, operationID: String? = nil) {
    guard current, operationID == nil || pending?.operationID == operationID else { return }
    let status = (error as? SideChatFailure)?.status
    if operationID != nil, let status, [400, 401, 403, 404, 409, 422].contains(status) { setPending(nil) }
    if operationID != nil, case APIError.http(let status) = error, [400, 401, 403, 404, 409, 422].contains(status) { setPending(nil) }
    failure = displayError(error)
  }
  private func setPending(_ value: SideChatPending?) { pending = value; archive.pending = value; persist() }
  private func persist() {
    do { try storage?.save(archive) } catch { failure = "旁聊本地存储失败，请复制未发送文字。" + displayError(error) }
  }
}
