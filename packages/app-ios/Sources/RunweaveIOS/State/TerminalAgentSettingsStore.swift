import CryptoKit
import Foundation

/// Per-connection, per-terminal cache for terminal agent model settings.
/// Step 1 serves the cached snapshot synchronously; Step 2 refreshes from Backend and writes only on diff.
@MainActor
final class TerminalAgentSettingsStore {
  private struct Archive: Codable {
    struct Entry: Codable {
      let response: TerminalAgentSettingsResponse
      var updatedAt: TimeInterval
    }
    var schemaVersion = 1
    var entries: [String: Entry] = [:]
  }

  private final class Flight {
    let task: Task<TerminalAgentSettingsResponse, Error>
    init(task: Task<TerminalAgentSettingsResponse, Error>) { self.task = task }
  }

  private static let maxEntriesPerScope = 100
  private var memory: [String: [String: Archive.Entry]] = [:]
  private var mutations: [String: Int] = [:]
  private var flights: [String: Flight] = [:]

  static func normalizedProvider(_ raw: String?) -> String? {
    guard let raw else { return nil }
    if raw == "codex" || raw == "agy" { return raw }
    if raw == "trae" || raw == "traex" || raw == "traecli" { return "traex" }
    return nil
  }

  static func isAuthoritativelyUnavailable(_ error: Error) -> Bool {
    guard let failure = error as? TerminalAgentSettingsFailure,
      failure.code == "agent_settings_unavailable" else { return false }
    guard let status = failure.status else { return true }
    return status == 404 || status == 409
  }

  func cached(session: AppSession, terminalID: String) -> TerminalAgentSettingsResponse? {
    guard session.authenticated, let scope = session.connection?.scope else { return nil }
    guard let entry = loadScope(scope)[terminalID],
      entry.response.settings.terminalSessionId == terminalID else { return nil }
    if let known = session.home.terminal(terminalID) {
      if known.status == "exited" || known.terminalState.state == "shell_idle" { return nil }
      if let provider = Self.normalizedProvider(known.terminalState.agent),
        provider != entry.response.settings.provider {
        return nil
      }
    }
    return entry.response
  }

  @discardableResult
  func refresh(session: AppSession, terminalID: String) async throws -> TerminalAgentSettingsResponse {
    guard session.authenticated, let api = session.api,
      let scope = session.connection?.scope else { throw APIError.offline }
    let generation = session.generation
    let flightKey = "\(generation)\u{0}\(scope)\u{0}\(terminalID)"
    if let existing = flights[flightKey] {
      return try await existing.task.value
    }
    let mutationKey = "\(scope)\u{0}\(terminalID)"
    let startedMutation = mutations[mutationKey] ?? 0
    let flight = Flight(task: Task { @MainActor [weak self, weak session] in
      let result: Result<TerminalAgentSettingsResponse, Error>
      do {
        result = .success(try await api.terminalAgentSettings(id: terminalID))
      } catch {
        result = .failure(error)
      }
      guard let self, let session, session.generation == generation,
        session.connection?.scope == scope, session.api === api else {
        return try result.get()
      }
      switch result {
      case .success(let next):
        guard next.settings.terminalSessionId == terminalID else { throw APIError.invalidResponse }
        if (self.mutations[mutationKey] ?? 0) == startedMutation {
          self.upsertIfChanged(next, scope: scope, terminalID: terminalID)
        }
        return next
      case .failure(let error):
        if Self.isAuthoritativelyUnavailable(error),
          (self.mutations[mutationKey] ?? 0) == startedMutation {
          self.removeEntryIfPresent(scope: scope, terminalID: terminalID)
        }
        throw error
      }
    })
    flights[flightKey] = flight
    defer {
      if flights[flightKey] === flight { flights.removeValue(forKey: flightKey) }
    }
    return try await flight.task.value
  }

  func store(_ response: TerminalAgentSettingsResponse, session: AppSession, terminalID: String) {
    guard let scope = session.connection?.scope,
      response.settings.terminalSessionId == terminalID else { return }
    bumpMutation(scope: scope, terminalID: terminalID)
    upsertIfChanged(response, scope: scope, terminalID: terminalID)
  }

  func remove(scope: String?, terminalID: String) {
    guard let scope else { return }
    bumpMutation(scope: scope, terminalID: terminalID)
    let suffix = "\u{0}\(scope)\u{0}\(terminalID)"
    for (key, flight) in flights where key.hasSuffix(suffix) {
      flight.task.cancel()
      flights.removeValue(forKey: key)
    }
    removeEntryIfPresent(scope: scope, terminalID: terminalID)
  }

  func removeScope(_ scope: String?) {
    guard let scope else { return }
    let infix = "\u{0}\(scope)\u{0}"
    for (key, flight) in flights where key.contains(infix) {
      flight.task.cancel()
      flights.removeValue(forKey: key)
    }
    let prefix = "\(scope)\u{0}"
    for key in mutations.keys where key.hasPrefix(prefix) {
      mutations[key] = (mutations[key] ?? 0) + 1
    }
    memory.removeValue(forKey: scope)
    if let url = try? file(scope), FileManager.default.fileExists(atPath: url.path) {
      try? FileManager.default.removeItem(at: url)
    }
  }

  func apply(_ batch: [TerminalEvent], scope: String?) {
    guard let scope else { return }
    for event in batch {
      if event.kind == "terminal_session_deleted", let id = event.terminalSessionId {
        remove(scope: scope, terminalID: id)
      } else if event.kind == "project_deleted", let ids = event.payload.terminalSessionIds {
        for id in ids { remove(scope: scope, terminalID: id) }
      } else if event.kind == "terminal_state_changed", event.payload.next?.state == "shell_idle",
        let id = event.terminalSessionId {
        remove(scope: scope, terminalID: id)
      }
    }
  }

  private func bumpMutation(scope: String, terminalID: String) {
    let key = "\(scope)\u{0}\(terminalID)"
    mutations[key] = (mutations[key] ?? 0) + 1
  }

  private func upsertIfChanged(_ next: TerminalAgentSettingsResponse, scope: String, terminalID: String) {
    var entries = loadScope(scope)
    if entries[terminalID]?.response == next { return }
    entries[terminalID] = Archive.Entry(response: next, updatedAt: Date().timeIntervalSince1970)
    if entries.count > Self.maxEntriesPerScope {
      let overflow = entries.count - Self.maxEntriesPerScope
      for item in entries.sorted(by: { $0.value.updatedAt < $1.value.updatedAt }).prefix(overflow) {
        entries.removeValue(forKey: item.key)
      }
    }
    memory[scope] = entries
    persist(scope: scope, entries: entries)
  }

  private func removeEntryIfPresent(scope: String, terminalID: String) {
    var entries = loadScope(scope)
    guard entries.removeValue(forKey: terminalID) != nil else { return }
    memory[scope] = entries
    persist(scope: scope, entries: entries)
  }

  private func loadScope(_ scope: String) -> [String: Archive.Entry] {
    if let cached = memory[scope] { return cached }
    guard let url = try? file(scope), FileManager.default.fileExists(atPath: url.path),
      let data = try? Data(contentsOf: url),
      let archive = try? JSONDecoder().decode(Archive.self, from: data),
      archive.schemaVersion == 1 else {
      memory[scope] = [:]
      return [:]
    }
    let valid = archive.entries.filter { $0.value.response.settings.terminalSessionId == $0.key }
    memory[scope] = valid
    return valid
  }

  private func persist(scope: String, entries: [String: Archive.Entry]) {
    guard let url = try? file(scope) else { return }
    if entries.isEmpty {
      if FileManager.default.fileExists(atPath: url.path) {
        try? FileManager.default.removeItem(at: url)
      }
      return
    }
    let archive = Archive(schemaVersion: 1, entries: entries)
    try? JSONEncoder().encode(archive).write(
      to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  private func file(_ scope: String) throws -> URL {
    var root = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true
    ).appendingPathComponent("terminal-agent-settings-v1", isDirectory: true)
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try root.setResourceValues(values)
    let key = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
    return root.appendingPathComponent(key + ".json")
  }
}
