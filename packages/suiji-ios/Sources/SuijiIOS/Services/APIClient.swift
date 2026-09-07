import Foundation
actor APIClient {
  nonisolated let endpoint: URL
  private let session: URLSession
  private var credentials: SavedCredentials?
  private var refreshTask: Task<SavedCredentials, Error>?
  private var active = true
  init(endpoint: URL) throws {
    self.endpoint = endpoint
    let config = URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCache = nil
    config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 60
    session = URLSession(configuration: config)
    credentials = try Credentials.read(endpoint: endpoint.absoluteString)
  }
  static func normalize(_ value: String) throws -> URL {
    guard var c = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
      let scheme = c.scheme?.lowercased(), ["https", "http"].contains(scheme), let host = c.host, !host.isEmpty,
      c.user == nil, c.password == nil, c.query == nil, c.fragment == nil else { throw MessageError(message: "请输入完整的云服务地址") }
    #if !DEBUG
    guard scheme == "https" else { throw MessageError(message: "正式版本需要 HTTPS 云服务") }
    #endif
    c.scheme = scheme; c.host = host.lowercased()
    if (scheme == "https" && c.port == 443) || (scheme == "http" && c.port == 80) { c.port = nil }
    while c.path.hasSuffix("/") { c.path.removeLast() }
    guard let url = c.url else { throw MessageError(message: "服务地址无效") }; return url
  }
  func cancel() { active = false; refreshTask?.cancel(); session.invalidateAndCancel() }
  private func assertActive() throws { if !active { throw CancellationError() } }
  private func raw(path: String, method: String, data: Data? = nil, token: String? = nil, key: String? = nil, contentType: String = "application/json") async throws -> Data {
    try assertActive()
    guard let url = URL(string: endpoint.absoluteString + "/" + path) else { throw MessageError(message: "请求地址无效") }
    var request = URLRequest(url: url); request.httpMethod = method; request.httpBody = data
    request.setValue(contentType, forHTTPHeaderField: "Content-Type")
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let key { request.setValue(key, forHTTPHeaderField: "Idempotency-Key") }
    let (body, response) = try await session.data(for: request); try assertActive()
    guard let response = response as? HTTPURLResponse else { throw MessageError(message: "未收到有效响应，保存结果可能待确认") }
    guard (200..<300).contains(response.statusCode) else {
      if let error = try? JSONDecoder().decode(APIError.self, from: body) { throw error }
      throw MessageError(message: "服务器响应无效（\(response.statusCode)），请手动重试确认")
    }
    return body
  }
  func login(username: String, password: String) async throws -> ServiceInfo {
    let body = try JSONSerialization.data(withJSONObject: ["username": username, "password": password])
    let tokens = try JSONDecoder().decode(Tokens.self, from: await raw(path: "api/auth/login", method: "POST", data: body))
    try assertActive(); try store(tokens)
    return try await info()
  }
  private func store(_ tokens: Tokens) throws {
    let value = SavedCredentials(tokens: tokens, expiresAt: Date().addingTimeInterval(TimeInterval(tokens.expiresIn)))
    try Credentials.write(value, endpoint: endpoint.absoluteString); credentials = value
  }
  private func refresh() async throws -> SavedCredentials {
    if let task = refreshTask { return try await task.value }
    guard let old = credentials else { throw MessageError(message: "请登录随记") }
    let task = Task { () throws -> SavedCredentials in
      let body = try JSONSerialization.data(withJSONObject: ["refreshToken": old.tokens.refreshToken])
      let tokens = try JSONDecoder().decode(Tokens.self, from: await self.raw(path: "api/auth/refresh", method: "POST", data: body))
      guard tokens.ownerId == old.tokens.ownerId, tokens.serverId == old.tokens.serverId else { throw MessageError(message: "服务身份已改变，请重新登录") }
      return SavedCredentials(tokens: tokens, expiresAt: Date().addingTimeInterval(TimeInterval(tokens.expiresIn)))
    }
    refreshTask = task
    defer { refreshTask = nil }
    let result = try await task.value; try assertActive()
    try Credentials.write(result, endpoint: endpoint.absoluteString); credentials = result; return result
  }
  func request<T: Decodable>(_ type: T.Type, path: String, method: String = "GET", data: Data? = nil, key: String? = nil, contentType: String = "application/json") async throws -> T {
    let body = try await bytes(path: path, method: method, data: data, key: key, contentType: contentType)
    return try JSONDecoder().decode(type, from: body)
  }
  func bytes(path: String, method: String = "GET", data: Data? = nil, key: String? = nil, contentType: String = "application/json") async throws -> Data {
    guard var saved = credentials else { throw MessageError(message: "请登录随记") }
    if saved.expiresAt.timeIntervalSinceNow < 60 { saved = try await refresh() }
    do { return try await raw(path: path, method: method, data: data, token: saved.tokens.accessToken, key: key, contentType: contentType) }
    catch let error as APIError where error.error.code == "UNAUTHENTICATED" && method == "GET" {
      let renewed = try await refresh()
      return try await raw(path: path, method: method, token: renewed.tokens.accessToken)
    }
  }
  func info() async throws -> ServiceInfo {
    let info = try await request(ServiceInfo.self, path: "api/suiji/v1/info")
    guard info.protocolVersion == 1, let tokens = credentials?.tokens, info.ownerId == tokens.ownerId, info.serverId == tokens.serverId else {
      throw MessageError(message: "服务身份或协议已改变，请重新登录；旧草稿保留在原身份下")
    }
    return info
  }
  func logout() async throws {
    let saved = credentials
    active = false; refreshTask?.cancel(); session.invalidateAndCancel()
    try Credentials.remove(endpoint: endpoint.absoluteString); credentials = nil
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
