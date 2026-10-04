import Foundation

/// Client observations only. Sending input is not proof that the Mac applied it.
/// No target identity, input payload, screen content or free-form error is included.
public enum RemoteDesktopObservation {
    case attemptStarted
    case firstVisibleFrame(milliseconds: Double, readOnly: Bool)
    case firstInputSent
    case controlBecameReadOnly
    case attemptEnded(RemoteAttemptObservation)
}

public struct RemoteAttemptObservation: Codable {
    public let endedAt: Date
    public let durationMilliseconds: Double
    public let firstVisibleFrameMilliseconds: Double?
    public let sentInputMessages: UInt64
    public let receivedFrames: UInt64
    public let droppedFrames: UInt64
    public let reason: String
}

extension RemoteDesktopSession {
    /// Accept only known lifecycle labels. Never persist callers' arbitrary reason strings.
    static func observationStopReason(_ reason: String) -> String {
        switch reason {
        case "user_closed", "background", "hidden", "target_changed", "pairing_removed",
             "backend_session_changed", "backend_logged_out", "computer_changed": return reason
        case "target changed": return "connection_replaced"
        case "presentation inactive": return "presentation_inactive"
        case "video surface detached": return "surface_detached"
        default: return "stopped_unknown"
        }
    }
}
