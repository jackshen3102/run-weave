import UIKit
import UserNotifications

@MainActor
enum NotificationBadgeSettings {
  static func requestIfNeeded(canRegister: Bool) async {
    guard UIApplication.shared.applicationState == .active else { return }
    let center = UNUserNotificationCenter.current()
    let settings = await center.notificationSettings()
    guard settings.authorizationStatus == .notDetermined,
      (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) == true,
      canRegister else { return }
    UIApplication.shared.registerForRemoteNotifications()
  }

  static func currentIssue() async -> (message: String, code: String)? {
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    if settings.authorizationStatus == .denied {
      return ("系统通知未允许，桌面图标无法显示小红点；请在 iOS 设置中开启", "notifications.badge.denied")
    }
    if settings.authorizationStatus != .notDetermined, settings.badgeSetting != .enabled {
      return (
        "系统「标记」未开启，桌面图标不会显示小红点；请在 iOS「设置 → 通知 → Runweave」中开启「标记」",
        "notifications.badge.disabled"
      )
    }
    return nil
  }
  static func setCount(_ count: Int) async throws {
    if #available(iOS 16.0, *) {
      try await UNUserNotificationCenter.current().setBadgeCount(count)
    } else {
      UIApplication.shared.applicationIconBadgeNumber = count
    }
  }
}
