import Foundation
import SwiftUI

/// One active connection owns its requests, overview, event stream and terminal route.
@MainActor
final class AppSession: ObservableObject {
  @Published private(set) var connection: BackendConnection?
  @Published private(set) var authenticated = false
  @Published private(set) var checking = false
  @Published private(set) var loading = false
  @Published private(set) var writing = false
  @Published private(set) var overview: HomeOverview?
  @Published private(set) var health = DeviceHealthSnapshot()
  @Published var error: String?
  @Published var terminal: TerminalDetails?
  @Published private(set) var terminalController: SessionController?
  // Retained when expired authentication dismisses the terminal, scoped to the active connection.
  @Published private(set) var terminalDrafts: [String: String] = [:]
  private(set) var api: APIClient?
  private var generation = 0
  private var overviewRevision = 0
  private var pendingOverviewEvents: [TerminalEvent] = []
  private var overviewTask: Task<Void, Never>?
  private var probeTask: Task<Void, Never>?
  private var resumeTask: Task<Void, Never>?
  private var routeRequest = 0
  private var events: EventStream?
  private var foreground = true
  private var loadingRequest = 0
  var canWrite: Bool { authenticated && health.status == .online && foreground && !writing }

  func activate(_ connection: BackendConnection?) async {
    generation += 1
    let epoch = generation
    let previous = api
    api = nil
    stopResources()
    terminalDrafts.removeAll()
    self.connection = connection
    authenticated = false
    overview = nil
    error = nil
    checking = true
    loading = false
    writing = false
    health = DeviceHealthSnapshot()
    await previous?.close()
    guard generation == epoch else { return }
    guard let connection else {
      checking = false
      return
    }
    do {
      let client = try APIClient(base: connection.url, connectionID: connection.id)
      api = client
      authenticated = await client.hasCredentials()
      guard generation == epoch, !Task.isCancelled else { return }
      checking = false
      await probe(epoch: epoch)
      guard generation == epoch, !Task.isCancelled else { return }
      if authenticated { await reload() }
    } catch {
      guard generation == epoch else { return }
      checking = false
      self.error = displayError(error)
    }
  }

  func login(username: String, password: String) async throws {
    guard let api else { throw APIError.invalidURL }
    let epoch = generation
    try await api.login(
      username: username.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
    guard epoch == generation, !Task.isCancelled else { throw CancellationError() }
    authenticated = true
    health.status = .online
    error = nil
    await reload()
  }

  func logout() async {
    guard let api else { return }
    generation += 1
    stopResources()
    terminalDrafts.removeAll()
    authenticated = false
    overview = nil
    loading = false
    writing = false
    do { try await api.logout() } catch { self.error = displayError(error) }
  }

  func refresh() async {
    let epoch = generation
    await probe(epoch: epoch)
    guard generation == epoch else { return }
    if authenticated, health.status == .online { await reload() }
  }

  func reload() async {
    guard let api, authenticated, foreground else { return }
    let epoch = generation
    loadingRequest += 1
    let request = loadingRequest
    let revision = overviewRevision
    pendingOverviewEvents.removeAll(keepingCapacity: true)
    loading = true
    do {
      var value = try await api.overview()
      guard generation == epoch, request == loadingRequest, !Task.isCancelled else { return }
      // Structural changes require a fresh snapshot. State/metadata updates are replayed below,
      // so a busy real Backend cannot indefinitely invalidate otherwise usable snapshots.
      if revision != overviewRevision {
        loading = false
        scheduleReload()
        return
      }
      Self.patch(pendingOverviewEvents, into: &value)
      pendingOverviewEvents.removeAll(keepingCapacity: true)
      overview = value
      health.status = .online
      error = nil
      startEvents()
    } catch {
      guard generation == epoch, request == loadingRequest, !Task.isCancelled else { return }
      await handle(error, epoch: epoch)
    }
    if generation == epoch, request == loadingRequest { loading = false }
  }

  func createProject(name: String, path: String?) async throws -> TerminalProject {
    guard canWrite, let api else { throw APIError.offline }
    let epoch = generation
    writing = true
    defer { if epoch == generation { writing = false } }
    do {
      let value = try await api.createProject(name: name, path: path)
      guard epoch == generation, !Task.isCancelled else { throw CancellationError() }
      await reload()
      return value
    } catch {
      if epoch == generation { await handle(error, epoch: epoch) }
      throw error
    }
  }

  func createTerminal(projectID: String) async {
    guard canWrite, let api else {
      error = APIError.offline.localizedDescription
      return
    }
    let epoch = generation
    writing = true
    defer { if epoch == generation { writing = false } }
    do {
      let value = try await api.createTerminal(projectID: projectID)
      guard epoch == generation, !Task.isCancelled else { return }
      await reload()
      guard epoch == generation else { return }
      await openTerminal(value.terminalSessionId)
    } catch { if epoch == generation { await handle(error, epoch: epoch) } }
  }

  func openTerminal(_ id: String) async {
    guard let api else { return }
    let epoch = generation
    routeRequest += 1
    let route = routeRequest
    do {
      let details = try await api.details(id: id)
      guard epoch == generation, !Task.isCancelled else { return }
      guard routeRequest == route else { return }
      closeTerminal()
      let controller = SessionController(api: api, terminalID: id)
      terminalController = controller
      terminal = details
      if health.status == .online, foreground { controller.connect() }
    } catch { if epoch == generation { await handle(error, epoch: epoch) } }
  }

  func deleteTerminal(_ id: String) async {
    guard canWrite, let api else {
      error = APIError.offline.localizedDescription
      return
    }
    let epoch = generation
    writing = true
    defer { if epoch == generation { writing = false } }
    do {
      try await api.deleteTerminal(id: id)
      guard epoch == generation, !Task.isCancelled else { return }
      terminalDrafts.removeValue(forKey: id)
      if terminal?.id == id { closeTerminal() }
      await reload()
    } catch { if epoch == generation { await handle(error, epoch: epoch) } }
  }

  func closeTerminal() {
    routeRequest += 1
    terminalController?.dispose()
    terminalController = nil
    terminal = nil
  }

  func setDraft(_ text: String, terminalID: String) {
    if text.isEmpty {
      terminalDrafts.removeValue(forKey: terminalID)
    } else {
      terminalDrafts[terminalID] = text
    }
  }

  func sendCommand(terminalID: String) async throws {
    guard canWrite, terminal?.id == terminalID, let controller = terminalController else {
      throw APIError.offline
    }
    let draft = terminalDrafts[terminalID] ?? ""
    let text = draft.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
    guard !text.isEmpty else { return }
    let epoch = generation
    let agent = overview?.sessions.first { $0.id == terminalID }?.terminalState.agent
    let isSlash = text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/")
    let mode = agent == "codex" && isSlash ? "codex_slash_command" : "line"
    do {
      try await controller.sendCommand(text, mode: mode)
      guard generation == epoch, !Task.isCancelled else { throw CancellationError() }
      if terminalDrafts[terminalID] == draft { terminalDrafts.removeValue(forKey: terminalID) }
    } catch {
      if generation == epoch, !(error is CancellationError) { await handle(error, epoch: epoch) }
      throw error
    }
  }

  func withConnection<T>(
    reportFailure: Bool = true, _ operation: (APIClient) async throws -> T
  ) async throws -> T {
    guard authenticated, let api else { throw APIError.credentialsUnavailable }
    guard foreground, health.status == .online else { throw APIError.offline }
    let epoch = generation
    do {
      let value = try await operation(api)
      guard epoch == generation, !Task.isCancelled else { throw CancellationError() }
      return value
    } catch {
      if epoch == generation, !Task.isCancelled {
        await handle(error, epoch: epoch, reportFailure: reportFailure)
      }
      throw error
    }
  }

  func isCommandActive(_ id: String) -> Bool {
    overview?.sessions.first { $0.id == id }?.terminalState.state == "agent_running"
  }

  func stopCommand(_ id: String) async throws {
    guard canWrite, terminal?.id == id else { throw APIError.offline }
    try await withConnection { try await $0.interrupt(id: id) }
    // The authoritative terminal-state event decides whether the Agent stopped.
  }

  func appendDraft(_ text: String, terminalID: String) {
    guard !text.isEmpty else { return }
    let previous = terminalDrafts[terminalID] ?? ""
    setDraft(
      previous
        + (previous.isEmpty || previous.hasSuffix(" ") || previous.hasSuffix("\n") ? "" : " ")
        + text,
      terminalID: terminalID)
  }

  func recordUserAction(_ action: String, terminalID: String) {
    guard terminal?.id == terminalID else { return }
    terminalController?.recordUserAction(action)
  }

  func setScenePhase(_ phase: ScenePhase) {
    terminalController?.recordScenePhase(phase)
    setForeground(phase == .active)
  }

  private func setForeground(_ value: Bool) {
    guard foreground != value else { return }
    foreground = value
    if !value {
      Task { await DiagnosticStore.shared.flush() }
      resumeTask?.cancel()
      resumeTask = nil
      events?.stop()
      probeTask?.cancel()
      probeTask = nil
      overviewTask?.cancel()
      overviewTask = nil
      terminalController?.disconnect()
    } else {
      let epoch = generation
      resumeTask?.cancel()
      resumeTask = Task { [weak self] in
        guard let self else { return }
        await self.refresh()
        guard self.generation == epoch, self.foreground, !Task.isCancelled else { return }
        if self.health.status == .online { self.terminalController?.connect() }
      }
    }
  }

  private func probe(epoch: Int) async {
    guard let api, foreground else { return }
    let result = await DeviceHealthService.check(base: api.baseURL)
    guard generation == epoch, foreground, !Task.isCancelled else { return }
    health = result
    if result.status == .offline {
      events?.stop()
      terminalController?.disconnect()
      scheduleProbe(epoch: epoch)
    } else {
      probeTask?.cancel()
      probeTask = nil
      startEvents()
    }
  }

  private func scheduleProbe(epoch: Int) {
    probeTask?.cancel()
    probeTask = Task { [weak self] in
      guard let self else { return }
      let delays = [5, 15, 30, 60, 120]
      var attempt = 0
      while !Task.isCancelled {
        let delay = delays[min(attempt, delays.count - 1)]
        attempt = min(attempt + 1, delays.count - 1)
        do { try await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000_000) } catch { return }
        guard self.generation == epoch, self.foreground, let api = self.api else { return }
        let result = await DeviceHealthService.check(base: api.baseURL)
        guard self.generation == epoch, self.foreground, !Task.isCancelled else { return }
        self.health = result
        if result.status == .online {
          await self.reload()
          self.terminalController?.connect()
          return
        }
      }
    }
  }

  private func startEvents() {
    guard authenticated, foreground, health.status == .online, let api else { return }
    if events == nil {
      let epoch = generation
      let stream = EventStream(api: api)
      stream.onConnected = { [weak self] in
        guard let self, self.generation == epoch else { return }
        self.health.status = .online
      }
      stream.onResync = { [weak self] in
        guard let self, self.generation == epoch else { return }
        self.scheduleReload()
      }
      stream.onEvents = { [weak self] batch in
        guard let self, self.generation == epoch else { return }
        self.apply(batch)
      }
      stream.onFailure = { [weak self] error in
        guard let self, self.generation == epoch else { return false }
        await self.handle(error, epoch: epoch)
        guard self.generation == epoch, self.authenticated, self.foreground else { return false }
        if case APIError.invalidResponse = error { return false }
        if !(error is URLError) { await self.probe(epoch: epoch) }
        return self.health.status == .online
      }
      events = stream
    }
    events?.start()
  }

  private func apply(_ batch: [TerminalEvent]) {
    let structural = Set([
      "project_created", "project_deleted", "terminal_session_created", "terminal_session_deleted",
    ])
    if batch.contains(where: { structural.contains($0.kind) }) {
      overviewRevision += 1
      scheduleReload()
    }
    let updates = batch.filter {
      $0.kind == "terminal_state_changed" || $0.kind == "terminal_session_metadata_changed"
    }
    if loading {
      if pendingOverviewEvents.count + updates.count > 10000 {
        // Bound memory if the Backend stalls while events keep arriving; resync after this read.
        pendingOverviewEvents.removeAll(keepingCapacity: true)
        overviewRevision += 1
      } else {
        pendingOverviewEvents.append(contentsOf: updates)
      }
    }
    if !updates.isEmpty, var value = overview {
      Self.patch(updates, into: &value)
      overview = value
    }
  }

  private static func patch(_ batch: [TerminalEvent], into overview: inout HomeOverview) {
    for event in batch {
      guard let id = event.terminalSessionId,
        let index = overview.sessions.firstIndex(where: { $0.id == id }),
        let next = event.payload.next
      else { continue }
      if event.kind == "terminal_state_changed", let state = next.state {
        overview.sessions[index].terminalState = TerminalState(state: state, agent: next.agent)
        let exited = overview.sessions[index].status == "exited"
        let labels = [
          "agent_running": ("running", "Agent Running"),
          "agent_starting": ("agent-starting", "Agent Starting"),
          "agent_idle": ("agent-idle", "Agent Idle"),
        ]
        let pair = exited ? ("exited", "Exited") : (labels[state] ?? ("idle", "Idle"))
        overview.sessions[index].displayStatus = pair.0
        overview.sessions[index].displayStatusLabel = pair.1
      } else if event.kind == "terminal_session_metadata_changed", let cwd = next.cwd {
        if overview.sessions[index].subtitle == event.payload.previous?.cwd {
          overview.sessions[index].subtitle = cwd
        }
        overview.sessions[index].cwd = cwd
        overview.sessions[index].activeCommand = next.activeCommand
      }
    }
  }

  private func scheduleReload() {
    overviewTask?.cancel()
    overviewTask = Task { [weak self] in
      do { try await Task.sleep(nanoseconds: 50_000_000) } catch { return }
      await self?.reload()
    }
  }

  private func handle(_ failure: Error, epoch: Int, reportFailure: Bool = true) async {
    guard generation == epoch else { return }
    if reportFailure { error = displayError(failure) }
    if case APIError.credentialsUnavailable = failure {
      authenticated = false
      overview = nil
      events?.stop()
      closeTerminal()
    } else if failure is URLError {
      await probe(epoch: epoch)
    }
  }

  private func stopResources() {
    pendingOverviewEvents.removeAll()
    resumeTask?.cancel()
    resumeTask = nil
    events?.dispose()
    events = nil
    probeTask?.cancel()
    probeTask = nil
    overviewTask?.cancel()
    overviewTask = nil
    closeTerminal()
  }
}
