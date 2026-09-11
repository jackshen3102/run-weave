import Foundation

struct DeviceNotificationSubscription: Codable {
  let subscriptionId: String
  let hostId: String
  let installationId: String
  let environment: String
  let state: String
  let version: Int
  let gatewayURL: String?
  let revokeToken: String?
}
struct DeviceNotificationStatus: Decodable {
  let available: Bool
  let reason: String?
  let subscriptions: [DeviceNotificationSubscription]
}
struct NotificationBinding: Codable {
  let connection: BackendConnection
  var subscription: DeviceNotificationSubscription?
  var enabled: Bool
  var pendingRevoke: Bool
}
struct BatteryPush {
  let hostID: String
  let notificationID: String
  init?(_ info: [AnyHashable: Any]) {
    guard (info["protocolVersion"] as? Int) == 1,
      let host = info["hostId"] as? String, UUID(uuidString: host) != nil,
      let id = info["notificationId"] as? String, id.count == 64,
      id.allSatisfy({ $0.isHexDigit })
    else { return nil }
    hostID = host
    notificationID = id
  }
}
extension APIClient {
  func notificationStatus() async throws -> DeviceNotificationStatus {
    try await authorized("/api/device/notifications/status")
  }
  func registerNotifications(
    installation: String, token: String, environment: String,
    name: String, explicit: Bool
  ) async throws -> DeviceNotificationSubscription {
    try await authorized(
      "/api/device/notifications/subscriptions/\(Self.pathComponent(installation))", method: "PUT",
      body: [
        "connectionId": connectionID, "deviceToken": token, "environment": environment,
        "displayName": String(name.prefix(80)), "enabled": true, "explicitEnable": explicit,
      ])
  }
  func confirmNotifications(_ subscription: DeviceNotificationSubscription) async throws
    -> DeviceNotificationSubscription
  {
    try await authorized(
      "/api/device/notifications/subscriptions/\(Self.pathComponent(subscription.installationId))/confirm",
      method: "POST",
      body: ["subscriptionId": subscription.subscriptionId, "version": subscription.version])
  }
  func revokeNotifications(installation: String) async throws {
    let _: NotificationEmptyResponse = try await authorized(
      "/api/device/notifications/subscriptions/\(Self.pathComponent(installation))",
      method: "DELETE")
  }
}

private struct NotificationEmptyResponse: Decodable {}
