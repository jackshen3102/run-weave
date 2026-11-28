import Foundation

enum NotificationKind: String, Codable, CaseIterable {
  case battery
  case scheduledTask = "scheduled-task"
  case terminalUnread = "terminal-unread"
  case terminalReply = "terminal-reply"
  case terminalQuestion = "terminal-question"
}

struct DeviceNotificationSubscription: Codable {
  let subscriptionId: String
  let hostId: String
  let installationId: String
  let environment: String
  let kind: NotificationKind?
  let state: String
  let version: Int
  let gatewayURL: String?
  let revokeToken: String?
}
struct DeviceNotificationStatus: Decodable {
  let available: Bool
  let reason: String?
  let subscriptions: [DeviceNotificationSubscription]
  let supportedKinds: [NotificationKind]?
}
struct NotificationBinding: Codable {
  let connection: BackendConnection
  var kind: NotificationKind?
  var subscription: DeviceNotificationSubscription?
  var enabled: Bool
  var pendingRevoke: Bool
}
struct TerminalReplyNotificationResponse: Decodable {
  enum Status: String, Decodable { case available, closed }
  let status: Status
  let terminalId: String
  let panelId: String?
}
struct BatteryPush {
  let hostID: String
  let notificationID: String
  let scheduledRunID: String?
  let questionRef: String?
  let replyNotificationID: String?
  init?(_ info: [AnyHashable: Any]) {
    guard (info["protocolVersion"] as? Int) == 1,
      let host = info["hostId"] as? String, UUID(uuidString: host) != nil,
      let id = info["notificationId"] as? String, id.count == 64,
      id.allSatisfy({ $0.isHexDigit })
    else { return nil }
    hostID = host
    notificationID = id
    let category = info["category"] as? String
    let target = info["target"] as? [String: String]
    if category == "terminal.question" {
      guard target?["resourceType"] == "terminal-question",
        let ref = target?["resourceId"], UUID(uuidString: ref) != nil else { return nil }
      questionRef = ref
    } else {
      guard target?["resourceType"] != "terminal-question" else { return nil }
      questionRef = nil
    }
    if let target,
      target["resourceType"] == "scheduled-run",
      let runID = target["resourceId"], UUID(uuidString: runID) != nil {
      scheduledRunID = runID
    } else {
      scheduledRunID = nil
    }
    replyNotificationID = category == "terminal.reply" && target == nil ? id.lowercased() : nil
  }
}
extension APIClient {
  func terminalReplyNotification(id: String, installation: String) async throws
    -> TerminalReplyNotificationResponse
  {
    try await authorized(
      "/api/terminal/replies/notifications/\(Self.pathComponent(id))",
      requestTimeout: 8,
      additionalHeaders: ["X-Runweave-Installation-ID": installation])
  }
  func notificationStatus() async throws -> DeviceNotificationStatus {
    try await authorized("/api/device/notifications/status?unread=1&replies=1&questions=1")
  }
  func registerNotifications(
    installation: String, token: String, environment: String,
    name: String, explicit: Bool, kind: NotificationKind
  ) async throws -> DeviceNotificationSubscription {
    let route = "/api/device/notifications/subscriptions/\(Self.pathComponent(installation))"
      + (kind == .battery ? "" : "/kinds/\(kind.rawValue)")
    return try await authorized(
      route, method: "PUT",
      body: [
        "connectionId": connectionID, "deviceToken": token, "environment": environment,
        "displayName": String(name.prefix(80)), "enabled": true, "explicitEnable": explicit,
        "kind": kind.rawValue,
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
  func revokeNotifications(installation: String, kind: NotificationKind) async throws {
    let route = "/api/device/notifications/subscriptions/\(Self.pathComponent(installation))"
      + (kind == .battery ? "" : "/kinds/\(kind.rawValue)")
    let _: EmptyResponse = try await authorized(
      route,
      method: "DELETE")
  }
}
