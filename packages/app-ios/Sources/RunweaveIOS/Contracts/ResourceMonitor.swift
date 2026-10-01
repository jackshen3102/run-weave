import Foundation

struct ResourceMonitorResponse: Decodable {
  let protocolVersion: Int
  let hostId: String
  let hostName: String
  let streamId: String
  let revision: Int
  let sampleAgeMs: Double?
  let status: String
  let snapshot: ResourceSnapshot?
  let settings: ResourceMonitorSettings
  let remoteControl: ResourceRemoteControl?
  let canManageRemoteControl: Bool?
  let canTerminate: Bool
  let alerts: [ResourceAlert]
}
struct ResourceMonitorSettings: Decodable {
  let revision: Int
  let monitorEnabled: Bool
  let alertsEnabled: Bool
}
struct ResourceRemoteControl: Decodable {
  let revision: Int
  let enabled: Bool
}
struct ResourceAlert: Decodable, Identifiable {
  var id: String { alertId }
  let alertId: String
  let appKey: String
  let appName: String
  let ruleId: String
  let mean: Double
  let sampleCount: Int
}
struct ResourceSnapshot: Decodable {
  let sampledAt: Double
  let battery: Battery
  let apps: [ResourceApp]
  let processes: [ResourceProcess]
  struct Battery: Decodable {
    let available: Bool
    let percent: Int?
    let charging: Bool?
    let powerSource: String?
    let dischargePowerW: Double?
  }
}
struct ResourceApp: Decodable, Identifiable {
  var id: String { appKey }
  let appKey: String
  let appName: String
  let processCount: Int
  let cpuPercent: Double?
  let memoryMb: Double
  let energyImpact: Double?
}
struct ResourceProcess: Decodable, Identifiable {
  var id: String { processInstanceId ?? "pid:\(pid)" }
  let processInstanceId: String?
  let pid: Int
  let displayName: String
  let appKey: String
  let cpuPercent: Double?
  let memoryMb: Double
  let actionKind: String?
  let actionReason: String?
  let serviceName: String?
}
struct ResourceProcessResult: Decodable {
  let requestId: String
  let processInstanceId: String
  let state: String
  let forceAllowed: Bool
  let message: String
}
struct ResourceMonitorFailure: Decodable, Error, LocalizedError {
  let code: String?
  let message: String
  var errorDescription: String? { message }
}
extension APIClient {
  func resources() async throws -> ResourceMonitorResponse {
    try await authorized("/api/device/resources")
  }
  func resourceSettings(_ value: ResourceMonitorSettings, monitor: Bool, alerts: Bool) async throws -> ResourceMonitorSettings {
    try await authorized("/api/device/resources/settings", method: "PUT",
      body: ["expectedRevision": value.revision, "monitorEnabled": monitor, "alertsEnabled": alerts],
      retryUnauthorized: false,
      decodeError: { status, data in status == 401 ? nil : try? JSONDecoder().decode(ResourceMonitorFailure.self, from: data) })
  }
  func snoozeResourceAlert(_ id: String) async throws {
    let _: EmptyResponse = try await authorized("/api/device/resources/alerts/\(Self.pathComponent(id))/snooze", method: "POST",
      body: ["durationMinutes": 60], retryUnauthorized: false,
      decodeError: { status, data in status == 401 ? nil : try? JSONDecoder().decode(ResourceMonitorFailure.self, from: data) })
  }
  func terminateResourceProcess(_ id: String, force: Bool, requestID: String) async throws -> ResourceProcessResult {
    try await authorized("/api/device/resources/processes/\(Self.pathComponent(id))/terminate", method: "POST",
      body: ["requestId": requestID, "force": force], retryUnauthorized: false,
      decodeError: { status, data in status == 401 ? nil : try? JSONDecoder().decode(ResourceMonitorFailure.self, from: data) })
  }
}
