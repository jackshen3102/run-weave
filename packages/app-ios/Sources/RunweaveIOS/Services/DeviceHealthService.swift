import Foundation

struct DeviceHealthSnapshot {
  enum Status: String { case checking, online, offline }
  var status: Status = .checking
  var latencyMilliseconds: Int?
  var message = "Checking computer"
  var serviceInstanceID: String?
  var runtimeReleaseID: String?
}

enum DeviceHealthService {
  private struct Identity: Decodable {
    let serviceInstanceId: String?
    let runtimeReleaseId: String?
  }
  static func check(base: URL, connectionID: String) async -> DeviceHealthSnapshot {
    let start = ProcessInfo.processInfo.systemUptime
    var fields = ["attemptId": UUID().uuidString]
    defer {
      fields["durationMs"] = String(Int((ProcessInfo.processInfo.systemUptime - start) * 1000))
      DiagnosticStore.shared.append(scope: connectionID, .connection("health.probe.finished", details: fields))
    }
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 2.5
    config.timeoutIntervalForResource = 2.5
    config.httpCookieStorage = nil
    let session = URLSession(configuration: config)
    defer { session.invalidateAndCancel() }
    do {
      var request = URLRequest(url: base.appendingPathComponent("health"))
      request.setValue(connectionID, forHTTPHeaderField: "X-Connection-ID")
      request.setValue(fields["attemptId"], forHTTPHeaderField: "X-Connection-Attempt-ID")
      let (data, response) = try await session.data(for: request)
      guard let response = response as? HTTPURLResponse else { throw APIError.invalidResponse }
      fields["status"] = String(response.statusCode)
      guard (200..<300).contains(response.statusCode) else {
        throw APIError.http(response.statusCode)
      }
      let identity = try? JSONDecoder().decode(Identity.self, from: data)
      fields["outcome"] = "online"
      fields["serviceInstanceId"] = identity?.serviceInstanceId
      fields["runtimeReleaseId"] = identity?.runtimeReleaseId
      return DeviceHealthSnapshot(
        status: .online,
        latencyMilliseconds: Int((ProcessInfo.processInfo.systemUptime - start) * 1000),
        message: "Computer online", serviceInstanceID: identity?.serviceInstanceId,
        runtimeReleaseID: identity?.runtimeReleaseId)
    } catch {
      fields["outcome"] = "offline"
      fields.merge(DiagnosticRecord.errorFields(error)) { _, next in next }
      return DeviceHealthSnapshot(status: .offline, message: displayError(error))
    }
  }
}
