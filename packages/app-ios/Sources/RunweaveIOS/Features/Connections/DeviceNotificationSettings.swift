import SwiftUI

struct DeviceNotificationSettings: View {
  let connection: BackendConnection
  @ObservedObject private var notifications = NotificationCoordinator.shared
  @State private var busy = false
  @State private var failure: String?
  let availability: DeviceNotificationStatus?

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Toggle("低电量提醒", isOn: Binding(
        get: { notifications.binding(connection, kind: .battery)?.enabled == true },
        set: { enabled in
          busy = true
          failure = nil
          Task {
            if enabled {
              do { try await notifications.enable(connection) } catch {
                failure = displayError(error)
              }
            } else {
              await notifications.disable(connection, kind: .battery)
            }
            busy = false
          }
        }
      ))
      .disabled(busy)
      .accessibilityIdentifier("device.notifications.enabled")
      if notifications.binding(connection, kind: .battery)?.pendingRevoke == true {
        Text("远端提醒关闭尚未确认").foregroundColor(.orange)
      } else if let failure {
        Text(failure).foregroundColor(.orange)
      } else if let reason = availability?.reason {
        Text(reason).foregroundColor(.secondary)
      } else if let failure = notifications.refreshFailure(connection, kind: .battery) {
        Text(failure).foregroundColor(.orange)
      } else if notifications.binding(connection, kind: .battery)?.subscription?.state == "pending" {
        Text("提醒正在同步，尚未启用").foregroundColor(.secondary)
      }
    }
    .font(.caption)
  }
}
