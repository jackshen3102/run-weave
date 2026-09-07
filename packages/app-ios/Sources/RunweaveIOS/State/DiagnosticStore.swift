import Foundation

/// A single serial writer owns the bounded on-disk ring. Callers never perform file I/O on MainActor.
final class DiagnosticStore: @unchecked Sendable {
  static let shared = DiagnosticStore()
  struct Snapshot {
    let records: [DiagnosticRecord]
    let persistenceError: String?
  }
  private struct Stored: Codable {
    let scope: String
    let record: DiagnosticRecord
  }
  private let queue = DispatchQueue(label: "com.runweave.native.diagnostics", qos: .utility)
  private let file: URL
  private var loaded = false
  private var records: [Stored] = []
  private var sizes: [Int] = []
  private var bytes = 2
  private var pending: DispatchWorkItem?
  private var persistenceError: String?
  private var preserveUnreadableFile = false

  private init() {
    let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    file = root.appendingPathComponent("NativeDiagnostics/records.json")
  }

  func append(scope: String, _ record: DiagnosticRecord) {
    queue.async {
      self.load()
      let entry = Stored(scope: scope, record: record)
      guard let encoded = try? JSONEncoder().encode(entry), encoded.count < 256 * 1024 else {
        return
      }
      self.records.append(entry)
      self.sizes.append(encoded.count + 1)
      self.bytes += encoded.count + 1
      self.trim()
      guard self.pending == nil else { return }
      let work = DispatchWorkItem {
        self.pending = nil
        self.save()
      }
      self.pending = work
      self.queue.asyncAfter(deadline: .now() + 0.25, execute: work)
    }
  }

  func snapshot(scope: String) async -> Snapshot {
    await withCheckedContinuation { continuation in
      queue.async {
        self.load()
        self.save()
        continuation.resume(
          returning: Snapshot(
            records: self.records.filter { $0.scope == scope }.map { stored in
              var details = stored.record.details
              details["connectionId"] = stored.scope
              details["client"] = "native-ios"
              return DiagnosticRecord(
                at: stored.record.at, source: stored.record.source,
                message: stored.record.message, details: details)
            },
            persistenceError: self.persistenceError))
      }
    }
  }

  func clear(scope: String) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      queue.async {
        self.load()
        guard !self.preserveUnreadableFile else {
          // A connection-scoped clear cannot safely erase an unreadable file containing other connections.
          continuation.resume(throwing: APIError.diagnosticStorageUnavailable)
          return
        }
        self.records.removeAll { $0.scope == scope }
        self.recount()
        self.save()
        if self.persistenceError != nil {
          continuation.resume(throwing: APIError.diagnosticStorageUnavailable)
        } else {
          continuation.resume()
        }
      }
    }
  }

  func flush() async {
    await withCheckedContinuation { continuation in
      queue.async {
        self.load()
        self.save()
        continuation.resume()
      }
    }
  }

  private func load() {
    guard !loaded else { return }
    loaded = true
    guard FileManager.default.fileExists(atPath: file.path) else { return }
    do {
      let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      guard size <= 2 * 1024 * 1024 else { throw APIError.invalidResponse }
      records = try JSONDecoder().decode([Stored].self, from: Data(contentsOf: file))
      recount()
      trim()
    } catch {
      preserveUnreadableFile = true
      persistenceError = "持久日志读取失败，原文件已保留；当前仅记录在内存中"
    }
  }

  private func recount() {
    sizes = records.map { ((try? JSONEncoder().encode($0).count) ?? 0) + 1 }
    bytes = 2 + sizes.reduce(0, +)
  }
  private func trim() {
    let countLimit = persistenceError == nil ? 2000 : 300
    let byteLimit = persistenceError == nil ? 2 * 1024 * 1024 : 256 * 1024
    while records.count > countLimit || bytes > byteLimit {
      guard !records.isEmpty else { break }
      records.removeFirst()
      bytes -= sizes.removeFirst()
    }
  }
  private func save() {
    guard !preserveUnreadableFile else { return }
    do {
      let directory = file.deletingLastPathComponent()
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      var excluded = URLResourceValues()
      excluded.isExcludedFromBackup = true
      var mutableDirectory = directory
      try mutableDirectory.setResourceValues(excluded)
      let data = try JSONEncoder().encode(records)
      try data.write(
        to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      persistenceError = nil
    } catch {
      persistenceError = "持久日志写入失败，当前仅记录在内存中"
      trim()
    }
  }
}

extension DiagnosticRecord {
  static func terminal(_ event: [String: Any]) -> DiagnosticRecord? {
    guard let name = event["event"] as? String, let at = event["at"] as? String else { return nil }
    let allowed = [
      "terminalSessionId", "generation", "uptime", "queuedBytes", "renderer", "rendererVersion",
      "bytes", "cols", "rows", "mode", "appVersion", "deltaRows", "widthPoints", "heightPoints",
      "client", "connectionId", "backendVersion", "displayScale",
    ]
    var details: [String: String] = [:]
    for key in allowed { if let value = event[key] { details[key] = String(describing: value) } }
    return DiagnosticRecord(at: at, source: "native-ios:terminal", message: name, details: details)
  }
}
