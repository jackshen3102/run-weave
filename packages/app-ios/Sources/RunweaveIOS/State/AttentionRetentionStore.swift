import CryptoKit
import Foundation

/// Device-local grace periods, isolated by the selected Backend connection.
@MainActor
final class AttentionRetentionStore: ObservableObject {
  private struct Entry: Codable {
    let acknowledgedRevision: Int
    var until: Date?
  }

  @Published private(set) var retainedUntil: [String: Date] = [:]
  private var entries: [String: Entry] = [:]
  private var key: String?
  private var readable = true
  private var foreground = true
  private var expiryTask: Task<Void, Never>?

  func activate(scope: String?) {
    expiryTask?.cancel()
    entries = [:]
    readable = true
    key = scope.map {
      let digest = SHA256.hash(data: Data($0.utf8)).map { String(format: "%02x", $0) }.joined()
      return "native.attentionRetention.v1." + digest
    }
    if let key, let data = DevicePreferences.store.data(forKey: key) {
      do { entries = try JSONDecoder().decode([String: Entry].self, from: data) }
      catch { readable = false } // Preserve unreadable data rather than overwriting it.
    }
    expire()
  }

  func observe(from previous: HomeOverview?, to next: HomeOverview?) {
    guard key != nil, let next else { return }
    let old = Dictionary(uniqueKeysWithValues: (previous?.sessions ?? []).map { ($0.id, $0) })
    let known = Set(next.sessions.map(\.id))
    var changed = false
    for id in Array(entries.keys) where !known.contains(id) {
      entries.removeValue(forKey: id)
      changed = true
    }
    for terminal in next.sessions {
      guard let prior = old[terminal.id], prior.hasUnreadCompletion,
        !terminal.hasUnreadCompletion else { continue }
      let revision = terminal.acknowledgedCompletionRevision ?? 0
      guard revision > (prior.acknowledgedCompletionRevision ?? 0),
        revision > (entries[terminal.id]?.acknowledgedRevision ?? 0) else { continue }
      entries[terminal.id] = Entry(acknowledgedRevision: revision, until: Date().addingTimeInterval(3600))
      changed = true
    }
    if changed { save() }
    expire()
  }

  func setForeground(_ value: Bool) {
    foreground = value
    expire()
  }

  func forget() {
    if let key { DevicePreferences.store.removeObject(forKey: key) }
    entries = [:]
    readable = true
    expire()
  }

  private func expire() {
    expiryTask?.cancel()
    expiryTask = nil
    let now = Date()
    var changed = false
    for id in Array(entries.keys) {
      if let until = entries[id]?.until, until <= now {
        // Keep the revision watermark so replayed acknowledgements cannot renew a lease.
        entries[id]?.until = nil
        changed = true
      }
    }
    if changed { save() }
    let deadlines = entries.compactMapValues(\.until)
    if retainedUntil != deadlines { retainedUntil = deadlines }
    guard foreground, let earliest = deadlines.values.min() else { return }
    expiryTask = Task { [weak self] in
      do {
        let delay = min(3600, max(0, earliest.timeIntervalSinceNow))
        try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
      } catch { return }
      guard let self, !Task.isCancelled else { return }
      self.expire()
    }
  }

  private func save() {
    guard readable, let key, let data = try? JSONEncoder().encode(entries) else { return }
    DevicePreferences.store.set(data, forKey: key)
  }
}
