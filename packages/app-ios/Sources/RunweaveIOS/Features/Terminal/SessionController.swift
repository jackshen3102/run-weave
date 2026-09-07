import Foundation
import SwiftUI

/// Owns one client's socket. Closing it never deletes or interrupts the remote runtime.
@MainActor
public final class SessionController: ObservableObject {
  public let surface = SwiftTermSurface()
  @Published public private(set) var connectionStatus = "未连接"
  @Published public private(set) var runtimeKind: String?
  @Published public private(set) var runtimeStatus: String?
  @Published public private(set) var receivedBytes = 0
  @Published public private(set) var queuedBytes = 0
  @Published public private(set) var failure: String?
  @Published public private(set) var inputBusy = false
  @Published private(set) var metadata: Metadata?
  struct Metadata {
    let cwd: String
    let activeCommand: String?
  }
  @Published private(set) var scrolledBack = false
  private var tmuxScrollRows = 0
  private var localAtBottom = true
  public private(set) var events: [[String: Any]] = []
  func clearDiagnosticEvents() { events.removeAll() }
  func recordUserAction(_ action: String) { record("action.\(action)") }

  func recordScenePhase(_ phase: ScenePhase) {
    switch phase {
    case .active: record("scene.active")
    case .inactive: record("scene.inactive")
    case .background: record("scene.background")
    @unknown default: record("scene.unknown")
    }
  }
  private let api: APIClient
  private let terminalID: String
  private let readOnly: Bool
  private var generation = 0
  private var task: Task<Void, Never>?
  private var inputTask: Task<Void, Never>?
  private var commandTask: Task<Void, Error>?
  private var socket: URLSessionWebSocketTask?
  private let networking = URLSession(configuration: .ephemeral)
  private var connected = false
  private var hasSnapshot = false
  private var stopped = true
  private var queue: [[UInt8]] = []
  private var drainTask: Task<Void, Never>?
  private var drainGeneration = 0
  private var size: (Int, Int)?
  private var sentSize: (Int, Int)?
  private static let highWater = 1024 * 1024

  public var canSend: Bool {
    !readOnly && connected && hasSnapshot && !stopped && !inputBusy && runtimeStatus != "exited"
  }

  public init(api: APIClient, terminalID: String, readOnly: Bool = false) {
    self.api = api
    self.terminalID = terminalID
    self.readOnly = readOnly
    surface.rawInput = { [weak self] bytes in
      guard let text = String(bytes: bytes, encoding: .utf8) else { return }
      self?.sendRaw(text)
    }
    surface.isTmux = { [weak self] in self?.runtimeKind == "tmux" }
    surface.tmuxScroll = { [weak self] input, rows in
      guard let self, self.canSend else { return false }
      self.sendRaw(input)
      self.tmuxScrollRows = max(0, self.tmuxScrollRows + rows)
      self.scrolledBack = !self.localAtBottom || self.tmuxScrollRows >= 4
      self.record("scroll.tmux", extra: ["deltaRows": rows])
      return true
    }
    surface.scrollState = { [weak self] position in
      guard let self else { return }
      self.localAtBottom = !self.surface.terminalView.canScroll || position >= 1
      self.scrolledBack = !self.localAtBottom || self.tmuxScrollRows >= 4
    }
    surface.viewportChanged = { [weak self] cols, rows in
      self?.size = (cols, rows)
      self?.sendSize()
    }
  }

  public func connect() {
    disconnect()
    stopped = false
    surface.setActive(true)
    failure = nil
    let epoch = generation
    task = Task { [weak self] in
      guard let self else { return }
      var retries = 0
      while !Task.isCancelled && !self.stopped && self.generation == epoch {
        do {
          self.connectionStatus = retries == 0 ? "连接中" : "重新连接中"
          let ticket = try await self.api.terminalTicket(id: self.terminalID)
          guard self.generation == epoch, !Task.isCancelled else { return }
          self.record("ticket.acquired")
          let ws = self.networking.webSocketTask(
            with: try self.api.webSocketURL(terminalID: self.terminalID, ticket: ticket))
          ws.maximumMessageSize = 2 * Self.highWater
          self.socket = ws
          self.connected = false
          self.hasSnapshot = false
          self.sentSize = nil
          ws.resume()
          while !Task.isCancelled, self.socket === ws {
            let message = try await ws.receive()
            guard self.generation == epoch, self.socket === ws else { return }
            let bytes: Data
            switch message {
            case .string(let text): bytes = Data(text.utf8)
            case .data(let data): bytes = data
            @unknown default: throw APIError.invalidResponse
            }
            do { try self.consume(JSONDecoder().decode(TerminalMessage.self, from: bytes)) } catch {
              self.halt("终端协议错误，连接已停止")
              return
            }
            if self.stopped { return }
          }
        } catch {
          guard self.generation == epoch, !Task.isCancelled, !self.stopped else { return }
          self.connected = false
          self.socket?.cancel(with: .goingAway, reason: nil)
          self.socket = nil
          if let error = error as? APIError {
            self.halt(error.localizedDescription)
            return
          }
          self.connectionStatus = "离线"
          self.record("socket.disconnected")
          retries += 1
          try? await Task.sleep(nanoseconds: UInt64(min(30, retries * 2)) * 1_000_000_000)
        }
      }
    }
  }

  public func disconnect() {
    generation += 1
    stopped = true
    connected = false
    task?.cancel()
    task = nil
    inputTask?.cancel()
    inputTask = nil
    commandTask?.cancel()
    commandTask = nil
    inputBusy = false
    socket?.cancel(with: .normalClosure, reason: nil)
    socket = nil
    clearQueue()
    surface.setActive(false)
    connectionStatus = "已断开"
  }

  public func sendRaw(_ text: String) {
    guard canSend else { return }
    send(["type": "input", "data": text])
  }

  public func sendVerificationLine(_ text: String) {
    performInput(text, mode: "line", returnToBottom: false)
  }

  public func returnToBottom() {
    guard canSend else { return }
    if runtimeKind == "tmux" {
      performInput("", mode: "tmux_exit_copy_mode", returnToBottom: true)
    } else if runtimeKind == "pty" {
      surface.terminalView.scroll(toPosition: 1)
      scrolledBack = false
    }
  }

  private func performInput(_ text: String, mode: String, returnToBottom: Bool) {
    guard canSend else { return }
    inputTask = Task { [weak self] in
      guard let self else { return }
      do {
        try await self.sendCommand(text, mode: mode)
        if returnToBottom {
          self.tmuxScrollRows = 0
          self.localAtBottom = true
          self.scrolledBack = false
          self.surface.terminalView.scroll(toPosition: 1)
          self.record("scroll.live")
        }
      } catch {
        // sendCommand exposes the failure; verification never retries.
      }
    }
  }

  func sendCommand(_ text: String, mode: String) async throws {
    guard canSend else { throw APIError.offline }
    let epoch = generation
    inputBusy = true
    failure = nil
    let operation = Task { try await api.terminalInput(id: terminalID, data: text, mode: mode) }
    commandTask = operation
    defer {
      if generation == epoch {
        inputBusy = false
        commandTask = nil
      }
    }
    do {
      try await operation.value
      guard generation == epoch, !Task.isCancelled else { throw CancellationError() }
      record("input.accepted", extra: ["mode": mode])
    } catch {
      guard generation == epoch, !Task.isCancelled else { throw CancellationError() }
      failure = displayInputError(error)
      record("input.unconfirmed", extra: ["mode": mode])
      throw error
    }
  }

  public func dispose() {
    disconnect()
    surface.dispose()
    networking.invalidateAndCancel()
  }

  private func consume(_ message: TerminalMessage) throws {
    switch message {
    case .connected(let id, let kind):
      guard id == terminalID else { throw APIError.invalidResponse }
      connected = true
      runtimeKind = kind
      connectionStatus = "已连接"
      record("connected")
      sendSize()
    case .snapshot(let text, let bracketed):
      guard connected else { throw APIError.invalidResponse }
      clearQueue()
      surface.reset()
      tmuxScrollRows = 0
      localAtBottom = true
      scrolledBack = false
      hasSnapshot = true
      enqueue(text, event: "snapshot")
      if let bracketed { enqueue(bracketed ? "\u{1b}[?2004h" : "\u{1b}[?2004l", event: "modes") }
    case .output(let text):
      guard hasSnapshot else { throw APIError.invalidResponse }
      enqueue(text, event: "output")
    case .status(let status, _):
      runtimeStatus = status
      record("runtime.status")
    case .exit:
      runtimeStatus = "exited"
      record("runtime.exit")
    case .metadata(let cwd, let activeCommand):
      metadata = Metadata(cwd: cwd, activeCommand: activeCommand)
      record("metadata")
    case .error: halt("终端服务返回错误，请查看后端诊断")
    case .unknown: record("protocol.unknown")
    }
  }

  private func enqueue(_ text: String, event: String) {
    let bytes = Array(text.utf8)
    guard queuedBytes + bytes.count <= Self.highWater else {
      halt("输出积压超过 1 MiB，需要重同步；连接已停止")
      return
    }
    receivedBytes += bytes.count
    queuedBytes += bytes.count
    for offset in stride(from: 0, to: bytes.count, by: 16384) {
      queue.append(Array(bytes[offset..<min(offset + 16384, bytes.count)]))
    }
    record(event, bytes: bytes.count)
    guard drainTask == nil else { return }
    let epoch = generation
    let drainEpoch = drainGeneration
    drainTask = Task { [weak self] in
      guard let self else { return }
      while !Task.isCancelled, self.generation == epoch, self.drainGeneration == drainEpoch,
        !self.queue.isEmpty
      {
        let next = self.queue.removeFirst()
        self.surface.feed(next)
        self.queuedBytes -= next.count
        self.record("consume", bytes: next.count)
        await Task.yield()
      }
      if self.generation == epoch, self.drainGeneration == drainEpoch { self.drainTask = nil }
    }
  }

  private func clearQueue() {
    drainGeneration += 1
    drainTask?.cancel()
    drainTask = nil
    queue.removeAll(keepingCapacity: false)
    queuedBytes = 0
  }

  private func halt(_ message: String) {
    disconnect()
    failure = message
    connectionStatus = "连接停止"
    record("connection.halted")
  }

  private func sendSize() {
    guard !readOnly, connected, let size, size.0 > 0, size.1 > 0 else { return }
    if let sentSize, sentSize == size { return }
    sentSize = size
    record(
      "resize",
      extra: [
        "cols": size.0, "rows": size.1,
        "widthPoints": surface.view.bounds.width, "heightPoints": surface.view.bounds.height,
        "displayScale": surface.view.traitCollection.displayScale,
      ])
    send(["type": "resize", "cols": size.0, "rows": size.1])
  }

  private func send(_ payload: [String: Any]) {
    guard let socket, let data = try? JSONSerialization.data(withJSONObject: payload),
      let text = String(data: data, encoding: .utf8)
    else { return }
    let epoch = generation
    socket.send(.string(text)) { [weak self] error in
      guard error != nil else { return }
      Task { @MainActor in
        guard let self, self.generation == epoch else { return }
        self.halt("发送结果未确认；不会自动重发")
      }
    }
  }

  private func record(_ event: String, bytes: Int = 0, extra: [String: Any] = [:]) {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var value: [String: Any] = [
      "at": formatter.string(from: Date()),
      "client": "native-ios", "event": event, "bytes": bytes,
      "connectionId": api.connectionID, "backendVersion": "unknown",
      "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        ?? "unknown",
      "terminalSessionId": terminalID, "generation": generation,
      "uptime": ProcessInfo.processInfo.systemUptime, "queuedBytes": queuedBytes,
      "renderer": surface.renderer, "rendererVersion": "1.19.0",
    ]
    value.merge(extra) { _, next in next }
    if let entry = DiagnosticRecord.terminal(value) {
      DiagnosticStore.shared.append(scope: api.connectionID, entry)
    }
    events.append(value)
    if events.count > 2000 { events.removeFirst(events.count - 2000) }
  }
}
