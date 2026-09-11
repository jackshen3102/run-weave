import UIKit
import UserNotifications

public final class NotificationAppDelegate: NSObject, UIApplicationDelegate,
  UNUserNotificationCenterDelegate
{
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return true
  }
  public func application(
    _ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    Task { @MainActor in NotificationCoordinator.shared.registered(deviceToken) }
  }
  public func application(
    _ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    Task { @MainActor in NotificationCoordinator.shared.registrationFailed() }
  }
  public func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    Task { @MainActor in
      let show = NotificationCoordinator.shared.received(
        notification.request.content.userInfo, tapped: false)
      completionHandler(show ? [.banner, .sound, .list] : [])
    }
  }
  public func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    Task { @MainActor in
      _ = NotificationCoordinator.shared.received(
        response.notification.request.content.userInfo, tapped: true)
      completionHandler()
    }
  }
}
