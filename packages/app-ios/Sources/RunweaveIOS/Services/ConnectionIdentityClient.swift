import Foundation
import Security

/// Identity, credentials and tickets never follow a server-controlled redirect.
final class ConnectionRedirectGuard: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}
enum ConnectionIdentityClient {
  static func verify(base: URL, trust: ConnectionIdentity) async throws {
    var random = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else { throw ConnectionIdentityFailure.invalidProof }
    let nonce = Data(random).base64URL
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.timeoutIntervalForRequest = 2.5
    config.timeoutIntervalForResource = 2.5
    let session = URLSession(configuration: config, delegate: ConnectionRedirectGuard(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    var request = URLRequest(url: base.appendingPathComponent("api/connection/probe"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: ["version": 1, "nonce": nonce])
    let (stream, response) = try await session.bytes(for: request)
    guard let http = response as? HTTPURLResponse else { throw ConnectionIdentityFailure.invalidProof }
    if http.statusCode == 404 { throw ConnectionIdentityFailure.unsupported }
    if (300..<400).contains(http.statusCode) { throw ConnectionIdentityFailure.redirectRejected }
    guard http.statusCode == 200 else { throw ConnectionIdentityFailure.unavailable }
    var data = Data()
    for try await byte in stream {
      guard data.count < 4096 else { throw ConnectionIdentityFailure.invalidProof }
      data.append(byte)
    }
    try Task.checkCancellation()
    guard let proof = try? JSONDecoder().decode(ConnectionProof.self, from: data) else { throw ConnectionIdentityFailure.invalidProof }
    try proof.verify(trust: trust, nonce: nonce)
  }
}

/// Synchronous invalidation prevents auxiliary actors from sending during route/scene changes.
final class ConnectionTransportAccess: @unchecked Sendable {
  private let lock = NSLock()
  private var value = true
  var enabled: Bool { lock.lock(); defer { lock.unlock() }; return value }
  func set(_ next: Bool) { lock.lock(); defer { lock.unlock() }; value = next }
}
