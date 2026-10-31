import AppKit
import ScreenCaptureKit

struct CapturedFrame {
    let image: CGImage
    let capturedAt: Date
    let displayID: UInt32
    let applicationID: String?
    let idleSeconds: Double?
    let placeholder: Bool
}

@MainActor struct ScreenCaptureAdapter {
    private static func excludedPIDs(_ settings: RecordingSettings) -> Set<pid_t> {
        Set(NSWorkspace.shared.runningApplications.filter { PrivacyFilter.blocked($0.bundleIdentifier, settings: settings) }.map(\.processIdentifier))
    }
    func capture(displayID: UInt32, settings: RecordingSettings) async throws -> CapturedFrame {
        guard CGPreflightScreenCaptureAccess() else { throw journalError("screen_permission_required") }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == displayID }) else { throw journalError("display_unavailable") }
        let height = settings.height
        let width = max(2, Int((Double(display.width) / Double(display.height) * Double(height)).rounded()) / 2 * 2)
        let foreground = PrivacyFilter.frontmostID()
        let capturedAt = Date()
        let idle = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: UInt32.max)!)
        let validIdle = idle.isFinite && idle >= 0 ? idle : nil
        if PrivacyFilter.blocked(foreground, settings: settings) {
            return CapturedFrame(image: try PrivacyFilter.placeholder(width: width, height: height), capturedAt: capturedAt,
                displayID: displayID, applicationID: nil, idleSeconds: validIdle, placeholder: true)
        }
        let excluded = content.applications.filter { settings.excludedApplications.contains($0.bundleIdentifier.lowercased()) }
        // A fresh shareable-content snapshot is mandatory. Never fall back to an unfiltered display capture.
        let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.width = width; configuration.height = height
        configuration.showsCursor = false; configuration.capturesAudio = false
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        let excludedPIDs = Set(excluded.map(\.processID))
        guard Self.excludedPIDs(settings).isSubset(of: excludedPIDs) else { throw journalError("privacy_application_list_changed") }
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        guard Self.excludedPIDs(settings).isSubset(of: excludedPIDs) else { throw journalError("privacy_application_list_changed") }
        return CapturedFrame(image: image, capturedAt: capturedAt, displayID: displayID,
            applicationID: foreground, idleSeconds: validIdle, placeholder: false)
    }
}
