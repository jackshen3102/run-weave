import SwiftUI

struct DeviceNotificationSettings: View {
  let connection: BackendConnection
  @ObservedObject private var notifications = NotificationCoordinator.shared
  @State private var busy = false
  @State private var failure: String?
  let availability: DeviceNotificationStatus?

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Toggle(
        "低电量提醒",
        isOn: Binding(
          get: { notifications.bindings[connection.scope]?.enabled == true },
          set: { enabled in
            busy = true
            failure = nil
            Task {
              if enabled {
                do { try await notifications.enable(connection) } catch {
                  failure = displayError(error)
                }
              } else {
                await notifications.disable(connection)
              }
              busy = false
            }
          })
      )
      .disabled(
        busy
          || (availability?.available != true
            && notifications.bindings[connection.scope]?.enabled != true)
      )
      .accessibilityIdentifier("device.notifications.enabled")
      if notifications.bindings[connection.scope]?.pendingRevoke == true {
        Text("远端提醒关闭尚未确认").foregroundColor(.orange)
      } else if let failure {
        Text(failure).foregroundColor(.orange)
      } else if let reason = availability?.reason {
        Text(reason).foregroundColor(.secondary)
      } else if notifications.bindings[connection.scope]?.subscription?.state == "pending" {
        Text("提醒正在同步，尚未启用").foregroundColor(.secondary)
      }
    }
    .font(.caption)

  }
}
