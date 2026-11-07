import Foundation
import SuijiCaptureCore
actor APIClient {
  nonisolated let endpoint: URL
  let transport: CaptureAPI
  init(endpoint: URL, environment: ConnectionEnvironment) throws {
    self.endpoint = endpoint; transport = try CaptureAPI(endpoint: endpoint, environment: environment)
  }
  static func normalize(_ value: String) throws -> URL { try CaptureAPI.normalize(value) }
  func cancel() async { await transport.cancel() }
  func login(username: String, password: String) async throws -> ServiceInfo {
    _ = try await transport.login(username: username, password: password); return try await info()
  }
  func info() async throws -> ServiceInfo {
    let identity = try await transport.info()
    let value = try await request(ServiceInfo.self, path: "api/suiji/v1/info")
    guard value.ownerId == identity.ownerId, value.serverId == identity.serverId else { throw MessageError(message: "服务身份已改变") }
    return value
  }
  func logout() async throws { try await transport.logout() }
  func request<T: Decodable>(_ type: T.Type, path: String, method: String = "GET", data: Data? = nil, key: String? = nil, contentType: String = "application/json") async throws -> T {
    try await transport.request(type, path: path, method: method, data: data, key: key, contentType: contentType)
  }
  func bytes(path: String, method: String = "GET", data: Data? = nil, key: String? = nil, contentType: String = "application/json") async throws -> Data {
    try await transport.bytes(path: path, method: method, data: data, key: key, contentType: contentType)
  }
}
