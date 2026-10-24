import Foundation

public enum DiagnosticAction: String, Sendable {
  case terminalSend = "terminal_send", suijiSave = "suiji_save"
  case browserOpen = "browser_open", connectionRecover = "connection_recover", analytics
}

public enum DiagnosticStage: String, Sendable {
  case started, requestStarted = "request_started", responseReceived = "response_received"
  case stateUpdated = "state_updated", presentationRequested = "presentation_requested", awaitingConfirmation = "awaiting_confirmation", loaded
  case confirmed, uiUpdated = "ui_updated", rejected, failed, unknown, cancelled
}

public struct ClientDiagnosticRecord: Codable, Sendable {
  public let at: String
  public let action: DiagnosticAction
  public let operationID: String
  public let stage: DiagnosticStage
  public let elapsedMs: Int
  public let context: [String: String]
  public let errorDomain: String?
  public let errorCode: Int?
  public let failureCode: String?
  public let relatedOperationID: String?
}

extension DiagnosticAction: Codable {}
extension DiagnosticStage: Codable {}

/// One operation per explicit intent/connection attempt, never per keystroke or output frame.
@MainActor public struct ClientDiagnosticOperation {
  public let id = UUID().uuidString
  private let action: DiagnosticAction
  private let started = ProcessInfo.processInfo.systemUptime
  private let context: [String: String]

  public init(_ action: DiagnosticAction) {
    self.action = action
    context = ClientDiagnostics.context()
    stage(.started)
  }

  public func stage(_ stage: DiagnosticStage, error: Error? = nil, failureCode: String? = nil, relatedOperationID: String? = nil) {
    let value = error as NSError?
    let domain = value?.domain
    let safeDomain = domain.flatMap { $0.count <= 80 && $0.unicodeScalars.allSatisfy {
      CharacterSet.alphanumerics.contains($0) || "._-".unicodeScalars.contains($0)
    } ? $0 : nil }
    let safeCode = failureCode.flatMap { $0.range(of: "^[A-Z0-9_]{1,64}$", options: .regularExpression) != nil ? $0 : nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    ClientDiagnostics.store.append(ClientDiagnosticRecord(
      at: formatter.string(from: Date()), action: action, operationID: id,
      stage: stage, elapsedMs: Int((ProcessInfo.processInfo.systemUptime - started) * 1000),
      context: action == .analytics ? ClientDiagnostics.context() : context, errorDomain: safeDomain, errorCode: value?.code, failureCode: safeCode, relatedOperationID: relatedOperationID.flatMap { UUID(uuidString: $0) == nil ? nil : $0 }))
    // Events contain only fixed vocabulary. Replay correlation uses the separate launch tag.
    if action != .analytics { ClientDiagnostics.onEvent?("action_\(action.rawValue)_\(stage.rawValue)") }
  }
}

@MainActor public enum ClientDiagnostics {
  public static var contextProvider: (() -> [String: String])?
  public static var onEvent: ((String) -> Void)?
  public static let launchID = UUID().uuidString
  fileprivate static let store = DiagnosticRing()

  fileprivate static func context() -> [String: String] {
    let allowed: Set<String> = ["app_version", "app_build", "build_id", "source_revision", "source_state",
      "client", "analytics_environment", "build_configuration", "device_kind", "clarity_session_id", "clarity_state"]
    var fields = (contextProvider?() ?? [:]).filter { allowed.contains($0.key) && $0.value.count <= 128 }
    fields["launch_id"] = launchID
    return fields
  }

  public static func snapshot() async -> [ClientDiagnosticRecord] { await store.snapshot() }
  private struct Export: Encodable { let records: [ClientDiagnosticRecord]; let persistenceFailed: Bool }
  public static func clear() async throws {
    await store.clear()
    if await store.persistenceFailed() { throw CocoaError(.fileWriteUnknown) }
  }
  public static func persistenceFailed() async -> Bool { await store.persistenceFailed() }
  public static func export() async throws -> URL {
    let records = await snapshot()
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("client-diagnostics.json")
    let payload = Export(records: records, persistenceFailed: await store.persistenceFailed())
    try JSONEncoder().encode(payload).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    return file
  }
}

private final class DiagnosticRing: @unchecked Sendable {
  private let queue = DispatchQueue(label: "com.runweave.client-diagnostics", qos: .utility)
  private var records: [ClientDiagnosticRecord] = []
  private var storageFailed = false
  private var unreadable = false
  private var loaded = false
  private var pending = false
  private let file = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("ClientDiagnostics/records.json")

  func append(_ record: ClientDiagnosticRecord) {
    queue.async {
      self.load()
      self.records.append(record)
      if self.records.count > 512 { self.records.removeFirst(self.records.count - 512) }
      guard !self.pending else { return }
      self.pending = true
      self.queue.asyncAfter(deadline: .now() + 0.5) { self.pending = false; self.save() }
    }
  }

  func snapshot() async -> [ClientDiagnosticRecord] {
    await withCheckedContinuation { continuation in
      queue.async { self.load(); self.save(); continuation.resume(returning: self.records) }
    }
  }

  func clear() async {
    await withCheckedContinuation { continuation in
      queue.async { self.records = []; self.loaded = true; self.unreadable = false; self.save(); continuation.resume() }
    }
  }
  func persistenceFailed() async -> Bool {
    await withCheckedContinuation { continuation in queue.async { continuation.resume(returning: self.storageFailed) } }
  }
  private func load() {
    guard !loaded else { return }; loaded = true
    guard FileManager.default.fileExists(atPath: file.path) else { return }
    guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 1024 * 1024,
      let data = try? Data(contentsOf: file), let decoded = try? JSONDecoder().decode([ClientDiagnosticRecord].self, from: data)
    else { storageFailed = true; unreadable = true; return }
    records = Array(decoded.suffix(512))
  }

  private func save() {
    guard !unreadable else { return }
    do {
      let directory = file.deletingLastPathComponent()
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      var values = URLResourceValues(); values.isExcludedFromBackup = true
      var mutableDirectory = directory; try mutableDirectory.setResourceValues(values)
      try JSONEncoder().encode(records).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      storageFailed = false
    } catch { storageFailed = true /* The in-memory ring remains exportable. */ }
  }
}
