import Foundation

/// Browser-only device preference; each host retains its own app sandbox.
enum BrowserPreferences {
  private static let store = UserDefaults.standard
  private static let noticeKey = "runweave.browser.localPreviewNoticeShown"
  static var localPreviewNoticeShown: Bool {
    get { store.bool(forKey: noticeKey) }
    set { store.set(newValue, forKey: noticeKey) }
  }
}
