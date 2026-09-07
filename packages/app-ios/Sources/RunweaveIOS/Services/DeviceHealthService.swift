import Foundation

struct DeviceHealthSnapshot {
  enum Status: String { case checking, online, offline }
  var status: Status = .checking
  var latencyMilliseconds: Int?
  var message = "Checking computer"
}

enum DeviceHealthService {
  static func check(base: URL) async -> DeviceHealthSnapshot {
    let start = ProcessInfo.processInfo.systemUptime
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 2.5
    config.timeoutIntervalForResource = 2.5
    config.httpCookieStorage = nil
    let session = URLSession(configuration: config)
    defer { session.invalidateAndCancel() }
    do {
      let (_, response) = try await session.data(from: base.appendingPathComponent("health"))
      guard let response = response as? HTTPURLResponse else { throw APIError.invalidResponse }
      guard (200..<300).contains(response.statusCode) else {
        throw APIError.http(response.statusCode)
      }
      return DeviceHealthSnapshot(
        status: .online,
        latencyMilliseconds: Int((ProcessInfo.processInfo.systemUptime - start) * 1000),
        message: "Computer online")
    } catch {
      return DeviceHealthSnapshot(status: .offline, message: displayError(error))
    }
  }
}
