import AppKit
import CoreGraphics

@MainActor final class SystemStateObserver {
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var sleeping = false
    private var inactive = false
    private var locked = false
    var onChange: (() -> Void)?
    var paused: Bool { sleeping || inactive || locked || !Self.consoleActive }
    static var consoleActive: Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        return session[kCGSessionOnConsoleKey as String] as? Bool == true && session["CGSSessionScreenIsLocked"] as? Bool != true
    }
    init() {
        let workspace = NSWorkspace.shared.notificationCenter
        observe(workspace, NSWorkspace.willSleepNotification) { $0.sleeping = true }
        observe(workspace, NSWorkspace.didWakeNotification) { $0.sleeping = false }
        observe(workspace, NSWorkspace.sessionDidResignActiveNotification) { $0.inactive = true }
        observe(workspace, NSWorkspace.sessionDidBecomeActiveNotification) { $0.inactive = false }
        let distributed = DistributedNotificationCenter.default()
        observe(distributed, Notification.Name("com.apple.screenIsLocked")) { $0.locked = true }
        observe(distributed, Notification.Name("com.apple.screenIsUnlocked")) { $0.locked = false }
    }
    private func observe(_ center: NotificationCenter, _ name: Notification.Name, _ update: @escaping (SystemStateObserver) -> Void) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { guard let self else { return }; update(self); self.onChange?() }
        }
        observers.append((center, token))
    }
    deinit { for (center, observer) in observers { center.removeObserver(observer) } }
}
