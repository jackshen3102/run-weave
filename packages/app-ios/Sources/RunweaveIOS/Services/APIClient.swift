import CryptoKit
import Foundation

/// Immutable endpoint and credential owner. No cookies or shared authentication state.
public actor APIClient {
  public nonisolated let baseURL: URL
  public nonisolated let connectionID: String
  private let account: String
  private let vault = CredentialStore()
  private let session: URLSession
  private var tokens: AuthTokens?
  private var refreshTask: Task<AuthTokens, Error>?
  private var authEpoch = 0
  var previewCache = ScopedCache()
  func diagnosticSnapshot() async -> DiagnosticStore.Snapshot {
    await DiagnosticStore.shared.snapshot(scope: connectionID)
  }
  func clearDiagnosticRecords() async throws {
    try await DiagnosticStore.shared.clear(scope: connectionID)
  }

  static func normalize(_ base: String) throws -> URL {
    guard var value = URLComponents(string: base.trimmingCharacters(in: .whitespacesAndNewlines)),
      let scheme = value.scheme?.lowercased(), ["http", "https"].contains(scheme),
      let host = value.host, !host.isEmpty, value.user == nil, value.password == nil
    else { throw APIError.invalidURL }
    value.scheme = scheme
    value.host = host.lowercased()
    value.query = nil
    value.fragment = nil
    while value.path.hasSuffix("/") { value.path.removeLast() }
    guard let url = value.url else { throw APIError.invalidURL }
    return url
  }

  public init(base: String, connectionID: String) throws {
    baseURL = try Self.normalize(base)
    account =
      connectionID + ":"
      + SHA256.hash(data: Data(baseURL.absoluteString.utf8)).map { String(format: "%02x", $0) }
      .joined()
    self.connectionID = account
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 20
    config.timeoutIntervalForResource = 30
    config.httpCookieStorage = nil
    session = URLSession(configuration: config)
    if let data = try vault.read(account) {
      tokens = try JSONDecoder().decode(AuthTokens.self, from: data)
    }
  }

  deinit { session.invalidateAndCancel() }
  func hasCredentials() -> Bool { tokens != nil }
  func close() async {
    previewCache.clear()
    authEpoch += 1
    refreshTask?.cancel()
    refreshTask = nil
    session.invalidateAndCancel()
    await DiagnosticStore.shared.flush()
  }

  public func login(username: String, password: String) async throws {
    previewCache.clear()
    authEpoch += 1
    let epoch = authEpoch
    refreshTask?.cancel()
    refreshTask = nil
    do {
      var next: AuthTokens = try await request(
        "/api/auth/login", method: "POST", body: ["username": username, "password": password])
      guard epoch == authEpoch, !Task.isCancelled else { throw CancellationError() }
      next.expiresAt = Date().addingTimeInterval(next.expiresIn)
      try store(next)
    } catch APIError.http(401) { throw APIError.loginRejected }
  }

  func clearCredentials() throws {
    previewCache.clear()
    authEpoch += 1
    refreshTask?.cancel()
    refreshTask = nil
    try vault.delete(account)
    tokens = nil
  }

  func logout() async throws {
    let token = tokens?.accessToken
    try clearCredentials()
    if let token {
      let _: EmptyResponse? = try? await request("/api/auth/logout", method: "POST", bearer: token)
    }
  }

  #if DEBUG
    func revokeRemoteLoginForValidation() async throws {
      guard baseURL.host == "127.0.0.1" || baseURL.host == "localhost" else {
        throw APIError.invalidURL
      }
      // Deliberately retain local credentials to exercise a real 401 + failed refresh on the next write.
      let _: EmptyResponse = try await authorized(
        "/api/auth/logout", method: "POST", retryUnauthorized: false)
    }
  #endif

  func verify() async throws {
    let _: Verification = try await authorized("/api/auth/verify")
  }
  func overview() async throws -> HomeOverview { try await authorized("/api/app/home/overview") }
  func details(id: String) async throws -> TerminalDetails {
    try await authorized("/api/terminal/session/\(Self.pathComponent(id))")
  }
  func history(id: String) async throws -> TerminalDetails {
    try await authorized("/api/terminal/session/\(Self.pathComponent(id))/history")
  }
  func createProject(name: String, path: String?) async throws -> TerminalProject {
    try await authorized(
      "/api/terminal/project", method: "POST",
      body: ["name": name, "path": path as Any? ?? NSNull()], retryUnauthorized: false)
  }
  func createTerminal(projectID: String) async throws -> CreatedTerminal {
    try await authorized(
      "/api/terminal/session", method: "POST", body: ["projectId": projectID],
      retryUnauthorized: false)
  }
  func updateTerminal(id: String, change: TerminalMetadataChange) async throws -> UpdatedTerminal {
    let value: UpdatedTerminal = try await authorized(
      "/api/terminal/session/\(Self.pathComponent(id))", method: "PATCH",
      body: change.body, retryUnauthorized: false)
    guard value.terminalSessionId == id else { throw APIError.invalidResponse }
    return value
  }
  func deleteTerminal(id: String) async throws {
    let _: EmptyResponse = try await authorized(
      "/api/terminal/session/\(Self.pathComponent(id))", method: "DELETE", retryUnauthorized: false)
  }
  public func terminalTicket(id: String) async throws -> String {
    let value: Ticket = try await authorized(
      "/api/terminal/session/\(Self.pathComponent(id))/ws-ticket", method: "POST")
    return value.ticket
  }
  func eventTicket() async throws -> EventTicket {
    try await authorized("/api/terminal/events/ws-ticket", method: "POST")
  }

  /// Acceptance is not process completion. Never automatically retry a business write.
  func terminalInput(id: String, data: String, mode: String) async throws {
    let operationID = UUID().uuidString
    let value: InputAcceptance = try await authorized(
      "/api/terminal/session/\(Self.pathComponent(id))/input", method: "POST",
      body: ["data": data, "mode": mode, "operationId": operationID], retryUnauthorized: false
    )
    guard value.operationId == operationID, value.terminalSessionId == id,
      value.inputAccepted, value.inputEnqueued
    else {
      throw APIError.invalidResponse
    }
  }
  func interrupt(id: String) async throws {
    let operationID = UUID().uuidString
    let value: InputAcceptance = try await authorized(
      "/api/terminal/session/\(Self.pathComponent(id))/interrupt", method: "POST",
      body: ["operationId": operationID],
      retryUnauthorized: false)
    guard value.operationId == operationID, value.terminalSessionId == id,
      value.inputAccepted, value.inputEnqueued, value.interruptAccepted == true
    else {
      throw APIError.invalidResponse
    }
  }

  public nonisolated func webSocketURL(terminalID: String, ticket: String) throws -> URL {
    try socketURL(
      path: "/ws/terminal",
      query: [
        URLQueryItem(name: "terminalSessionId", value: terminalID),
        URLQueryItem(name: "token", value: ticket),
      ])
  }
  nonisolated func eventSocketURL(ticket: String, after: String?) throws -> URL {
    try socketURL(
      path: "/ws/terminal-events",
      query: [
        URLQueryItem(name: "token", value: ticket), URLQueryItem(name: "after", value: after ?? ""),
      ])
  }
  private nonisolated func socketURL(path: String, query: [URLQueryItem]) throws -> URL {
    guard var value = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
      throw APIError.invalidURL
    }
    value.scheme = value.scheme == "https" ? "wss" : "ws"
    value.path += path
    value.queryItems = query
    guard let result = value.url else { throw APIError.invalidURL }
    return result
  }

  func authorized<T: Decodable>(
    _ path: String, method: String = "GET", body: [String: Any]? = nil,
    retryUnauthorized: Bool = true, decode: ((Data) throws -> T)? = nil
  ) async throws -> T {
    guard var current = tokens else { throw APIError.credentialsUnavailable }
    let epoch = authEpoch
    if let expiry = current.expiresAt, expiry.timeIntervalSinceNow < 15 {
      current = try await refresh()
    }
    guard epoch == authEpoch, !Task.isCancelled else { throw CancellationError() }
    do {
      let value: T = try await request(
        path, method: method, body: body, bearer: current.accessToken, decode: decode)
      guard epoch == authEpoch, !Task.isCancelled else { throw CancellationError() }
      return value
    } catch APIError.http(401) {
      guard epoch == authEpoch else { throw CancellationError() }
      // Another request may already have refreshed while this response was in flight.
      let renewed: AuthTokens?
      if tokens?.accessToken != current.accessToken {
        renewed = tokens
      } else {
        renewed = try await refresh()
      }
      guard epoch == authEpoch, !Task.isCancelled else { throw CancellationError() }
      guard let renewed else { throw APIError.credentialsUnavailable }
      guard retryUnauthorized else { throw APIError.writeRequiresRetry }
      do {
        let value: T = try await request(
          path, method: method, body: body, bearer: renewed.accessToken, decode: decode)
        guard epoch == authEpoch, !Task.isCancelled else { throw CancellationError() }
        return value
      } catch APIError.http(401) {
        if epoch == authEpoch { try clearCredentials() }
        throw APIError.credentialsUnavailable
      }
    }
  }

  private func refresh() async throws -> AuthTokens {
    if let task = refreshTask { return try await task.value }
    guard let current = tokens else { throw APIError.credentialsUnavailable }
    let epoch = authEpoch
    let task = Task<AuthTokens, Error> {
      do {
        var renewed: AuthTokens = try await self.request(
          "/api/auth/refresh", method: "POST", body: ["refreshToken": current.refreshToken])
        guard epoch == self.authEpoch, !Task.isCancelled else { throw CancellationError() }
        renewed.expiresAt = Date().addingTimeInterval(renewed.expiresIn)
        try self.store(renewed)
        return renewed
      } catch APIError.http(401) {
        guard epoch == self.authEpoch else { throw CancellationError() }
        try self.clearCredentials()
        throw APIError.credentialsUnavailable
      }
    }
    refreshTask = task
    defer { if epoch == authEpoch { refreshTask = nil } }
    return try await task.value
  }

  private func store(_ value: AuthTokens) throws {
    guard !value.accessToken.isEmpty, !value.refreshToken.isEmpty else {
      throw APIError.invalidResponse
    }
    try vault.write(JSONEncoder().encode(value), account: account)
    tokens = value
  }

  private func request<T: Decodable>(
    _ path: String, method: String, body: [String: Any]? = nil, bearer: String? = nil,
    decode: ((Data) throws -> T)? = nil
  ) async throws -> T {
    let started = ProcessInfo.processInfo.systemUptime
    var responseStatus: Int?
    defer {
      var fields = [
        "method": method, "path": String(path.split(separator: "?").first ?? ""),
        "status": responseStatus.map(String.init) ?? "transport-error",
        "durationMs": String(Int((ProcessInfo.processInfo.systemUptime - started) * 1000)),
      ]
      if let operationID = body?["operationId"] as? String { fields["operationId"] = operationID }
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      DiagnosticStore.shared.append(
        scope: connectionID,
        DiagnosticRecord(
          at: formatter.string(from: Date()), source: "native-ios:http",
          message: "api.request.finished", details: fields))
    }
    guard let url = URL(string: baseURL.absoluteString + path) else { throw APIError.invalidURL }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue("app", forHTTPHeaderField: "X-Auth-Client")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
    if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
    responseStatus = http.statusCode
    if http.statusCode == 401,
      let failure = try? JSONDecoder().decode(ServerFailure.self, from: data),
      failure.message == "Tunnel token required"
    {
      // This precedes App authentication on the Backend; refreshing or deleting App tokens cannot fix it.
      throw APIError.tunnelAuthenticationRequired
    }
    guard (200..<300).contains(http.statusCode) else { throw APIError.http(http.statusCode) }
    if let decode { return try decode(data) }
    if T.self == EmptyResponse.self {
      return try JSONDecoder().decode(T.self, from: Data("{}".utf8))
    }
    do { return try JSONDecoder().decode(T.self, from: data) } catch {
      throw APIError.invalidResponse
    }
  }

  nonisolated static func pathComponent(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
  }
}

private struct AuthTokens: Codable {
  let accessToken: String
  let refreshToken: String
  let expiresIn: Double
  let sessionId: String
  var expiresAt: Date?
}
private struct Ticket: Decodable {
  let ticket: String
  let expiresIn: Double
}
private struct Verification: Decodable { let valid: Bool }
private struct EmptyResponse: Decodable {}
private struct ServerFailure: Decodable { let message: String }
private struct InputAcceptance: Decodable {
  let operationId: String
  let terminalSessionId: String
  let inputAccepted: Bool
  let inputEnqueued: Bool
  let interruptAccepted: Bool?
}
