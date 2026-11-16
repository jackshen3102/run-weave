import AppKit
import ApplicationServices

/// Optional evidence captured with a frame, never inferred from later application state.
struct CaptureWindowContext: Codable, Equatable {
    let windowID: UInt32
    let windowTitle: String?
    let url: String?
    var accessibility: CaptureAXDelta? = nil
    var accessibilityUnavailableReason: String? = nil
}

struct CaptureWindowObservation {
    var context: CaptureWindowContext
    let accessibility: CaptureAXSnapshot?
}

@MainActor enum CaptureWindowContextReader {
    static func read(pid: pid_t, displayID: UInt32, settings: RecordingSettings, includeText: Bool) -> CaptureWindowObservation? {
        let appID = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
        guard !PrivacyFilter.blocked(appID, settings: settings),
              let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let row = rows.first(where: { row in
                  guard (row[kCGWindowOwnerPID as String] as? Int32) == pid,
                        (row[kCGWindowLayer as String] as? Int) == 0,
                        let bounds = row[kCGWindowBounds as String] as? [String: Any],
                        let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return false }
                  return rect.intersects(CGDisplayBounds(displayID))
              }), let id = row[kCGWindowNumber as String] as? UInt32,
              let bounds = row[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
        let title = bounded(row[kCGWindowName as String] as? String, limit: 512)
        let window = title.flatMap { CaptureAccessibilityReader.focusedWindow(pid: pid, title: $0, bounds: rect) }
        var context = CaptureWindowContext(windowID: id, windowTitle: title, url: window.flatMap(CaptureAccessibilityReader.documentURL))
        var snapshot: CaptureAXSnapshot?
        if includeText, settings.accessibilityTextEnabled == true {
            if let window { snapshot = CaptureAccessibilityReader.snapshot(window, bounds: rect) }
            else { context.accessibilityUnavailableReason = AXIsProcessTrusted() ? "windowUnavailable" : "permissionRequired" }
        }
        return CaptureWindowObservation(context: context, accessibility: snapshot)
    }
    private static func bounded(_ value: String?, limit: Int) -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return String(value.prefix(limit))
    }
}
