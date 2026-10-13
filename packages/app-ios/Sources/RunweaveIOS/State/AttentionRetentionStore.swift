import CryptoKit
import Foundation

/// Device-local attention order and grace periods, isolated by Backend connection.
@MainActor
final class AttentionRetentionStore: ObservableObject {
  private struct Entry: Codable {
    let acknowledgedRevision: Int
    var until: Date?
  }

  @Published private(set) var retainedUntil: [String: Date] = [:]
  @Published private(set) var orderedIDs: [String] = []
  private var entries: [String: Entry] = [:]
  private var overview: HomeOverview?
  private var key: String?
  private var orderKey: String?
  private var readable = true
  private var orderReadable = true
  private var foreground = true
  private var expiryTask: Task<Void, Never>?

  func activate(scope: String?) {
    expiryTask?.cancel()
    entries = [:]
    overview = nil
    orderedIDs = []
    readable = true
    orderReadable = true
    key = scope.map {
      let digest = SHA256.hash(data: Data($0.utf8)).map { String(format: "%02x", $0) }.joined()
      return "native.attentionRetention.v1." + digest
    }
    orderKey = key.map { $0.replacingOccurrences(of: "attentionRetention", with: "attentionOrder") }
    if let key, let data = DevicePreferences.store.data(forKey: key) {
      do { entries = try JSONDecoder().decode([String: Entry].self, from: data) }
      catch { readable = false } // Preserve unreadable data rather than overwriting it.
    }
    if let orderKey, let data = DevicePreferences.store.data(forKey: orderKey) {
      do { orderedIDs = try JSONDecoder().decode([String].self, from: data) }
      catch { orderReadable = false }
    }
    expire()
  }

  func observe(from previous: HomeOverview?, to next: HomeOverview?) {
    overview = next
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
    if let orderKey { DevicePreferences.store.removeObject(forKey: orderKey) }
    entries = [:]
    overview = nil
    orderedIDs = []
    readable = true
    orderReadable = true
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
    reconcileOrder()
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

  private func reconcileOrder() {
    guard key != nil, let overview else { return }
    // Preserve an active terminal's position while offline; HomeView only hides it.
    // Reconcile against the full overview so search never changes stored order.
    let candidates = overview.groups(matching: "").flatMap(\.sessions).filter {
      $0.hasUnreadCompletion || $0.isAgentActive || $0.pinnedAt != nil
        || retainedUntil[$0.id] != nil
    }
    let terminals = Dictionary(uniqueKeysWithValues: candidates.map { ($0.id, $0) })
    let existing = orderedIDs.filter { terminals[$0] != nil }
    let existingIDs = Set(existing)
    let ids = existing + candidates.map(\.id).filter { !existingIDs.contains($0) }

    var projects: [String] = []
    var contexts: [String: [String]] = [:]
    var members: [String: [String]] = [:]
    for id in ids {
      guard let terminal = terminals[id] else { continue }
      let project = HomeOverview.parentProjectID(terminal.projectId)
      if contexts[project] == nil {
        projects.append(project)
        contexts[project] = []
      }
      if members[terminal.projectId] == nil {
        contexts[project, default: []].append(terminal.projectId)
        members[terminal.projectId] = []
      }
      members[terminal.projectId, default: []].append(id)
    }
    let next = projects.flatMap { project in
      (contexts[project] ?? []).flatMap { members[$0] ?? [] }
    }
    guard next != orderedIDs else { return }
    orderedIDs = next
    if orderReadable, let orderKey, let data = try? JSONEncoder().encode(next) {
      DevicePreferences.store.set(data, forKey: orderKey)
    }
  }

  private func save() {
    guard readable, let key, let data = try? JSONEncoder().encode(entries) else { return }
    DevicePreferences.store.set(data, forKey: key)
  }
}
