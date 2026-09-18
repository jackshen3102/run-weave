import Foundation
import Network
import RunweaveBrowser

private enum LocalPreviewError: LocalizedError {
  case unavailable(String)
  var errorDescription: String? {
    switch self { case .unavailable(let message): return message }
  }
}

/// Native-only CONNECT endpoint. Each connection is one bounded, non-replaying WS stream.
@MainActor
final class BrowserLocalTransport {
  private let api: APIClient
  private let target: BrowserLocalTarget
  private let terminalID: String
  private let identity = UUID()
  private let password = UUID().uuidString + UUID().uuidString
  private var listener: NWListener?
  private var streams: [UUID: BrowserLocalStream] = [:]
  private var closed = false
  private var startup: CheckedContinuation<UInt16, Error>?
  private var startupTimeout: Task<Void, Never>?
  private weak var preview: BrowserLocalPreview?

  init(api: APIClient, target: BrowserLocalTarget, terminalID: String) {
    self.api = api; self.target = target; self.terminalID = terminalID
  }

  func prepare() async throws -> BrowserLocalPreview {
    let capabilities: BrowserLocalCapabilities
    do { capabilities = try await api.authorized("/api/browser/local/capabilities") }
    catch APIError.http(404) { throw LocalPreviewError.unavailable("电脑版本不支持本地预览，请更新电脑端。") }
    catch APIError.http(503) { throw LocalPreviewError.unavailable("电脑端尚未启用本地预览。") }
    guard capabilities.protocolVersion == 1, capabilities.maxFrameBytes >= 65536 else {
      throw LocalPreviewError.unavailable("电脑版本不支持本地预览，请更新电脑端。")
    }
    try Task.checkCancellation()
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let listener = try NWListener(using: parameters)
    self.listener = listener
    listener.newConnectionHandler = { [weak self] connection in
      Task { @MainActor in self?.accept(connection) }
    }
    listener.stateUpdateHandler = { [weak self, weak listener] state in
      Task { @MainActor in
        guard let self else { return }
        switch state {
        case .ready:
          if let port = listener?.port { self.finishStartup(.success(port.rawValue)) }
        case .failed(let error):
          self.finishStartup(.failure(error)); self.close()
        default: break
        }
      }
    }
    let port: UInt16 = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        startup = continuation
        startupTimeout = Task { [weak self] in
          try? await Task.sleep(nanoseconds: 10_000_000_000)
          guard !Task.isCancelled else { return }
          self?.finishStartup(.failure(LocalPreviewError.unavailable("本地预览启动超时。")))
          self?.close()
        }
        listener.start(queue: .main)
      }
    } onCancel: { Task { @MainActor in self.close() } }
    let value = BrowserLocalPreview(url: target.previewURL(identity: identity), originalURL: target.url,
      port: port, password: password, close: { [self] in close() })
    preview = value
    return value
  }

  private func finishStartup(_ result: Result<UInt16, Error>) {
    let continuation = startup; startup = nil
    startupTimeout?.cancel(); startupTimeout = nil
    continuation?.resume(with: result)
  }

  private func accept(_ incoming: NWConnection) {
    guard !closed, streams.count < 32 else { incoming.cancel(); return }
    let id = UUID()
    let stream = BrowserLocalStream(incoming: incoming, api: api,
      previewURL: target.previewURL(identity: identity), password: password,
      open: BrowserLocalOpen(terminalSessionId: terminalID, browserSessionId: identity.uuidString,
        host: target.host, port: target.port, secure: target.secure))
    streams[id] = stream
    stream.onClose = { [weak self] in self?.streams.removeValue(forKey: id) }
    stream.onFailure = { [weak self] message in self?.preview?.onFailure?(message) }
    stream.start()
  }

  func close() {
    guard !closed else { return }
    closed = true
    finishStartup(.failure(CancellationError()))
    listener?.cancel(); listener = nil
    for stream in Array(streams.values) { stream.close() }
    streams.removeAll()
  }
}

@MainActor
private final class BrowserLocalStream {
  let incoming: NWConnection
  let api: APIClient
  let previewURL: URL
  let password: String
  let open: BrowserLocalOpen
  var onClose: (() -> Void)?
  var onFailure: ((String) -> Void)?
  private var task: Task<Void, Never>?
  private var input: Task<Void, Never>?
  private var deadline: Task<Void, Never>?
  private var ws: URLSessionWebSocketTask?
  private let session: URLSession
  private var closed = false
  private var requested = false
  private var inputEOF = false
  private var outputEOF = false

  init(incoming: NWConnection, api: APIClient, previewURL: URL, password: String, open: BrowserLocalOpen) {
    self.incoming = incoming; self.api = api; self.previewURL = previewURL; self.password = password; self.open = open
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.timeoutIntervalForRequest = 20
    session = URLSession(configuration: config)
  }

  func start() {
    incoming.start(queue: .main)
    deadline = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 15_000_000_000)
      guard !Task.isCancelled else { return }
      if self?.requested == true { self?.onFailure?("电脑本地页面连接超时，请检查服务后主动重试。") }
      self?.close()
    }
    task = Task { [self] in
      do {
        var header = Data()
        var delimiter: Range<Data.Index>?
        while delimiter == nil {
          let (data, eof) = try await receive()
          header.append(data)
          guard !eof, header.count <= 16384 else { throw CancellationError() }
          delimiter = header.range(of: Data("\r\n\r\n".utf8))
        }
        let end = delimiter!.upperBound
        let lines = String(decoding: header[..<end], as: UTF8.self).components(separatedBy: "\r\n")
        let credentials = "Basic " + Data("preview:\(password)".utf8).base64EncodedString()
        let authorized = lines.dropFirst().contains { line in
          guard let colon = line.firstIndex(of: ":") else { return false }
          return line[..<colon].lowercased() == "proxy-authorization"
            && line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces) == credentials
        }
        guard authorized else {
          try await send(Data("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"preview\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8))
          close(); return
        }
        let authority = "\(previewURL.host!):\(previewURL.port!)"
        guard lines.first == "CONNECT \(authority) HTTP/1.1" else { throw CancellationError() }
        requested = true
        let request = try await api.localBrowserSocketRequest()
        try Task.checkCancellation()
        let socket = session.webSocketTask(with: request)
        socket.maximumMessageSize = 65536
        ws = socket; socket.resume()
        try await socket.send(.string(String(data: JSONEncoder().encode(open), encoding: .utf8)!))
        guard case .string(let text) = try await socket.receive(),
          let control = try? JSONDecoder().decode(BrowserLocalControl.self, from: Data(text.utf8)), control.type == "ready"
        else { throw LocalPreviewError.unavailable("无法连接电脑本地服务，请确认端口、终端和证书有效。") }
        deadline?.cancel(); deadline = nil
        try await send(Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8))
        if header.count > end { try await socket.send(.data(Data(header[end...]))) }
        input = Task { [self] in
          do {
            while !Task.isCancelled {
              let (data, eof) = try await receive()
              if !data.isEmpty { try await socket.send(.data(data)) }
              if eof {
                try await socket.send(.string("{\"type\":\"eof\"}"))
                inputEOF = true
                if outputEOF { close() }
                return
              }
            }
          } catch { close() }
        }
        while !Task.isCancelled {
          switch try await socket.receive() {
          case .data(let data):
            guard !outputEOF, data.count <= 65536 else { throw CancellationError() }
            try await send(data)
          case .string(let value):
            let message = try JSONDecoder().decode(BrowserLocalControl.self, from: Data(value.utf8))
            guard message.type == "eof", !outputEOF else {
              throw LocalPreviewError.unavailable("电脑连接已失效，请返回终端后主动重新打开页面。")
            }
            outputEOF = true
            try await send(nil, complete: true)
            if inputEOF { close(); return }
          @unknown default: throw CancellationError()
          }
        }
      } catch {
        if requested && !closed && !Task.isCancelled && !outputEOF && ws?.closeCode != .normalClosure {
          onFailure?("本地预览连接中断或服务不可用。请检查电脑连接、端口和证书后主动重试。")
        }
        close()
      }
    }
  }

  private func receive() async throws -> (Data, Bool) {
    try await withCheckedThrowingContinuation { continuation in
      incoming.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, complete, error in
        if let error { continuation.resume(throwing: error) }
        else { continuation.resume(returning: (data ?? Data(), complete)) }
      }
    }
  }

  private func send(_ data: Data?, complete: Bool = false) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      incoming.send(content: data, isComplete: complete, completion: .contentProcessed { error in
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
      })
    }
  }

  func close() {
    guard !closed else { return }
    closed = true
    deadline?.cancel(); task?.cancel(); input?.cancel()
    ws?.cancel(with: .goingAway, reason: nil)
    incoming.cancel(); session.invalidateAndCancel()
    onClose?(); onClose = nil; onFailure = nil
  }
}
