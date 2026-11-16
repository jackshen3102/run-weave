import Foundation
import IOSDiagnostics

/// Host-owned queues. Shared diagnostics remains Foundation-only and never accesses networking.
@MainActor final class QualityDiagnosticsUploader {
  static let shared = QualityDiagnosticsUploader()
  private struct Queue: Codable {
    var schemaVersion = 1
    let backendId: String
    var sourceId = UUID().uuidString
    var streamId = UUID().uuidString
    var nextSeq = 1
    var events: [QualityEvent] = []
    var droppedRanges: [QualityRange] = []
    var blocked: String?
  }
  private var queues: [String: Queue] = [:]
  private var clients: [String: APIClient] = [:]
  private var identities: [String: String] = [:]
  private var tasks: [String: Task<Void, Never>] = [:]
  private var busy: Set<String> = []
  private var failures: [String: Int] = [:]
  private var observers: [NSObjectProtocol] = []
  private let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("QualityWorkflow", isDirectory: true)

  private init() {
    // Resume only diagnostics. Foreground/network recovery never retries business writes.
    observers.append(NotificationCenter.default.addObserver(forName: .init("UIApplicationDidBecomeActiveNotification"), object: nil, queue: .main) { _ in
      Task { @MainActor in for backendId in self.clients.keys { self.schedule(backendId, seconds: 0) } }
    })
  }
  func register(_ api: APIClient) async {
    do {
      guard let trust = await api.credentials.trust() else { return }
      let capabilities: QualityCapabilities = try await api.authorized("/api/quality-workflow/capabilities", requestTimeout: 2)
      guard capabilities.enabled, capabilities.schemaVersion == 1, capabilities.backendId == trust.identityId else { return }
      let id = trust.identityId
      if queues[id] == nil { queues[id] = try load(id) }
      clients[id] = api; identities[api.connectionID] = id; schedule(id, seconds: 0)
    } catch { /* Unsupported/unauthenticated endpoints never receive fallback writes. */ }
  }
  func observer(api: APIClient, terminalID: String, attemptID: String? = nil) -> ((ClientDiagnosticRecord) -> Void)? {
    guard let backendId = identities[api.connectionID] else { return nil }
    return { [weak self] record in self?.append(record, backendId: backendId, terminalID: terminalID, attemptID: attemptID) }
  }
  private func file(_ id: String) -> URL { directory.appendingPathComponent(id + ".json") }
  private func load(_ id: String) throws -> Queue {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    var mutable = directory; try mutable.setResourceValues(values)
    guard FileManager.default.fileExists(atPath: file(id).path) else { let queue = Queue(backendId: id); try save(queue); return queue }
    do {
      let data = try Data(contentsOf: file(id))
      guard data.count <= 3 * 1024 * 1024 else { throw APIError.invalidResponse }
      let value = try JSONDecoder().decode(Queue.self, from: data)
      guard value.schemaVersion == 1, value.backendId == id, value.nextSeq > 0, value.events.allSatisfy({ $0.seq > 0 && $0.seq < value.nextSeq }) else { throw APIError.invalidResponse }
      return value
    } catch {
      try FileManager.default.moveItem(at: file(id), to: directory.appendingPathComponent(id + ".corrupt." + UUID().uuidString))
      var queue = Queue(backendId: id); queue.droppedRanges = [QualityRange(from: 1, through: 1, reason: "corruption")]; queue.nextSeq = 2
      try save(queue); return queue
    }
  }
  private func save(_ queue: Queue) throws {
    try JSONEncoder().encode(queue).write(to: file(queue.backendId), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
  private func append(_ record: ClientDiagnosticRecord, backendId: String, terminalID: String, attemptID: String?) {
    guard var queue = queues[backendId] else { return }
    let context = record.context
    let event = QualityEvent(seq: queue.nextSeq, at: record.at, action: record.action.rawValue, stage: record.stage.rawValue,
      operationId: record.operationID, launchId: context["launch_id"] ?? ClientDiagnostics.launchID, elapsedMs: record.elapsedMs,
      appVersion: context["app_version"] ?? "unknown", buildId: context["build_id"] ?? "unknown", sourceRevision: context["source_revision"] ?? "unknown",
      sourceState: context["source_state"] ?? "unknown", terminalSessionId: terminalID, attemptId: attemptID,
      relatedOperationId: record.relatedOperationID, failureCode: record.failureCode, status: nil, closeCode: nil)
    queue.nextSeq += 1; queue.events.append(event)
    do {
      while try queue.events.count > 10_000 || JSONEncoder().encode(queue).count > 2 * 1024 * 1024 {
        guard !queue.events.isEmpty else { break }
        let removed = queue.events.removeFirst()
        if let last = queue.droppedRanges.last, last.reason == "overflow", last.through + 1 == removed.seq { queue.droppedRanges[queue.droppedRanges.count - 1].through = removed.seq }
        else { queue.droppedRanges.append(QualityRange(from: removed.seq, through: removed.seq, reason: "overflow")) }
      }
      try save(queue); queues[backendId] = queue
      if queue.events.count >= 64 || event.stage == "failed" { schedule(backendId, seconds: 1) }
    } catch { /* Keep the last durable queue; never affect input or reconnect. */ }
  }
  private func schedule(_ id: String, seconds: Double) {
    tasks[id]?.cancel()
    tasks[id] = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
      guard !Task.isCancelled else { return }
      await self?.flush(id)
    }
  }
  private func flush(_ id: String) async {
    guard !busy.contains(id), let api = clients[id], let queue = queues[id], queue.blocked == nil else { return }
    guard !queue.events.isEmpty || !queue.droppedRanges.isEmpty else { schedule(id, seconds: 30); return }
    busy.insert(id); defer { busy.remove(id) }
    let events = Array(queue.events.prefix(64)); let ranges = Array(queue.droppedRanges.prefix(128))
    let through = max(events.map(\.seq).max() ?? 0, ranges.map(\.through).max() ?? 0)
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let batch = QualityBatch(backendId: id, sourceId: queue.sourceId, streamId: queue.streamId, uploadedAt: formatter.string(from: Date()), events: events, droppedRanges: ranges)
    do {
      guard let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(batch)) as? [String: Any] else { throw APIError.invalidResponse }
      let receipt: QualityReceipt = try await api.authorized("/api/quality-workflow/batches", method: "POST", body: body, requestTimeout: 10)
      guard receipt.ackThrough >= 0, receipt.ackThrough <= through, var current = queues[id], current.streamId == queue.streamId else { throw APIError.invalidResponse }
      current.events.removeAll { $0.seq <= receipt.ackThrough }
      current.droppedRanges = current.droppedRanges.filter { $0.through > receipt.ackThrough }.map { QualityRange(from: max($0.from, receipt.ackThrough + 1), through: $0.through, reason: $0.reason) }
      try save(current); queues[id] = current; failures[id] = 0; schedule(id, seconds: current.events.isEmpty ? 30 : 1.1)
    } catch APIError.http(let status) where [400, 409, 413].contains(status) {
      var current = queues[id]!; current.blocked = "HTTP_\(status)"; try? save(current); queues[id] = current
    } catch {
      failures[id, default: 0] += 1; schedule(id, seconds: min(300, pow(2, Double(min(8, failures[id]!)))) + Double.random(in: 0...1))
    }
  }
}
