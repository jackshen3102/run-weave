import Foundation
public actor CaptureAPI {
  public nonisolated let endpoint: URL
  private let environment: ConnectionEnvironment
  private let session: URLSession
  private var credentials: SavedCredentials?
  private var refreshTask: Task<SavedCredentials, Error>?
  private var active = true
  public init(endpoint: URL, environment: ConnectionEnvironment) throws {
    self.endpoint = endpoint; self.environment = environment
    let config = URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCache = nil
    config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 60
    session = URLSession(configuration: config)
    credentials = try Credentials.read(endpoint: endpoint.absoluteString, environment: environment)
  }
  public static func normalize(_ value: String) throws -> URL {
    guard var c = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
      let scheme = c.scheme?.lowercased(), ["https", "http"].contains(scheme), let host = c.host, !host.isEmpty,
      c.user == nil, c.password == nil, c.query == nil, c.fragment == nil else { throw CaptureError("请输入完整的云服务地址") }
    #if !DEBUG
    guard scheme == "https" else { throw CaptureError("正式版本需要 HTTPS 云服务") }
    #endif
    c.scheme = scheme; c.host = host.lowercased()
    if (scheme == "https" && c.port == 443) || (scheme == "http" && c.port == 80) { c.port = nil }
    while c.path.hasSuffix("/") { c.path.removeLast() }
    guard let url = c.url else { throw CaptureError("服务地址无效") }; return url
  }
  public func cancel() { active = false; refreshTask?.cancel(); session.invalidateAndCancel() }
  private func assertActive() throws { if !active { throw CancellationError() } }
  private func raw(path: String, method: String, data: Data? = nil, token: String? = nil, key: String? = nil, contentType: String = "application/json") async throws -> Data {
    try assertActive()
    guard let url = URL(string: endpoint.absoluteString + "/" + path) else { throw CaptureError("请求地址无效") }
    var request = URLRequest(url: url); request.httpMethod = method; request.httpBody = data
    request.setValue(contentType, forHTTPHeaderField: "Content-Type")
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
    let (body, response) = try await session.data(for: request); try assertActive()
    guard let response = response as? HTTPURLResponse else { throw CaptureError("未收到有效响应，保存结果可能待确认") }
    guard (200..<300).contains(response.statusCode) else {
      if let error = try? JSONDecoder().decode(APIError.self, from: body) { throw error }
      throw CaptureError("服务器响应无效（\(response.statusCode)），请手动重试确认")
    }
    return body
  }
  public func login(username: String, password: String) async throws -> CaptureServiceInfo {
    let body = try JSONSerialization.data(withJSONObject: ["username": username, "password": password])
    let tokens = try JSONDecoder().decode(Tokens.self, from: await raw(path: "api/auth/login", method: "POST", data: body))
    try assertActive()
    let lock = try await CaptureFileLock.acquire(environment.scoped(endpoint.absoluteString) + ":credentials")
    defer { withExtendedLifetime(lock) {} }
    try assertActive()
    try store(tokens)
    return try await info()
  }
  private func store(_ tokens: Tokens) throws {
    let value = SavedCredentials(tokens: tokens, expiresAt: Date().addingTimeInterval(TimeInterval(tokens.expiresIn)))
    try Credentials.write(value, endpoint: endpoint.absoluteString, environment: environment); credentials = value
  }
  private func refresh(rejectedToken: String? = nil) async throws -> SavedCredentials {
    if let task = refreshTask { return try await task.value }
    guard let old = credentials else { throw CaptureError("请登录随记") }
    let task = Task { () throws -> SavedCredentials in
      let lock = try await CaptureFileLock.acquire(self.environment.scoped(self.endpoint.absoluteString) + ":credentials")
      defer { withExtendedLifetime(lock) {} }
      try self.assertActive()
      guard let latest = try Credentials.read(endpoint: self.endpoint.absoluteString, environment: self.environment),
        latest.tokens.sessionId == old.tokens.sessionId else { throw CaptureError("登录已改变，请重新打开随记") }
      if latest.expiresAt.timeIntervalSinceNow >= 60 && latest.tokens.accessToken != rejectedToken { return latest }
      let body = try JSONSerialization.data(withJSONObject: ["refreshToken": latest.tokens.refreshToken])
      let tokens = try JSONDecoder().decode(Tokens.self, from: await self.raw(path: "api/auth/refresh", method: "POST", data: body))
      guard tokens.ownerId == old.tokens.ownerId, tokens.serverId == old.tokens.serverId else { throw CaptureError("服务身份已改变，请重新登录") }
      let result = SavedCredentials(tokens: tokens, expiresAt: Date().addingTimeInterval(TimeInterval(tokens.expiresIn)))
      // Persist a rotated token while holding the process lock, before another reader can refresh.
      try Credentials.write(result, endpoint: self.endpoint.absoluteString, environment: self.environment)
      return result
    }
    refreshTask = task
    defer { refreshTask = nil }
    let result = try await task.value; try assertActive(); credentials = result; return result
  }
  public func request<T: Decodable>(_ type: T.Type, path: String, method: String = "GET", data: Data? = nil, key: String? = nil, contentType: String = "application/json") async throws -> T {
    let body = try await bytes(path: path, method: method, data: data, key: key, contentType: contentType)
    return try JSONDecoder().decode(type, from: body)
  }
  public func bytes(path: String, method: String = "GET", data: Data? = nil, key: String? = nil, contentType: String = "application/json") async throws -> Data {
    try assertActive()
    if credentials == nil {
      let lock = try await CaptureFileLock.acquire(environment.scoped(endpoint.absoluteString) + ":credentials")
      defer { withExtendedLifetime(lock) {} }
      try assertActive(); credentials = try Credentials.migrate(endpoint: endpoint.absoluteString, environment: environment)
    }
    guard let prior = credentials,
      var saved = try Credentials.read(endpoint: endpoint.absoluteString, environment: environment),
      prior.tokens.sessionId == saved.tokens.sessionId else { throw CaptureError("请登录随记") }
    credentials = saved
    if saved.expiresAt.timeIntervalSinceNow < 60 { saved = try await refresh() }
    do { return try await raw(path: path, method: method, data: data, token: saved.tokens.accessToken, key: key, contentType: contentType) }
    catch let error as APIError where error.error.code == "UNAUTHENTICATED" && method == "GET" {
      let renewed = try await refresh(rejectedToken: saved.tokens.accessToken)
      return try await raw(path: path, method: method, token: renewed.tokens.accessToken)
    }
  }
  public func info() async throws -> CaptureServiceInfo {
    let info = try await request(CaptureServiceInfo.self, path: "api/suiji/v1/info")
    guard info.protocolVersion == 1, let tokens = credentials?.tokens, info.ownerId == tokens.ownerId, info.serverId == tokens.serverId else {
      throw CaptureError("服务身份或协议已改变，请重新登录；旧草稿保留在原身份下")
    }
    return info
  }
  public func logout() async throws {
    active = false; refreshTask?.cancel(); session.invalidateAndCancel()
    let lock = try await CaptureFileLock.acquire(environment.scoped(endpoint.absoluteString) + ":credentials")
    defer { withExtendedLifetime(lock) {} }
    let latest = try Credentials.read(endpoint: endpoint.absoluteString, environment: environment)
    let saved = latest?.tokens.sessionId == credentials?.tokens.sessionId ? latest : credentials
    if latest?.tokens.sessionId == credentials?.tokens.sessionId {
      try Credentials.remove(endpoint: endpoint.absoluteString, environment: environment)
    }
    credentials = nil
    guard let saved, let url = URL(string: endpoint.absoluteString + "/api/auth/logout") else { return }
    let config = URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCache = nil
    config.timeoutIntervalForRequest = 10
    let revocation = URLSession(configuration: config); defer { revocation.invalidateAndCancel() }
    var request = URLRequest(url: url); request.httpMethod = "POST"
    request.setValue("Bearer \(saved.tokens.accessToken)", forHTTPHeaderField: "Authorization")
    _ = try? await revocation.data(for: request)
  }
}
