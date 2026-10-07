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

@MainActor
final class RemoteObservationRecorder {
    private let observe: (RemoteDesktopObservation) -> Void
    private var startTime: TimeInterval?
    private var firstFrame: Double?
    private var inputs: UInt64 = 0
    private var receivedBaseline: UInt64 = 0
    private var droppedBaseline: UInt64 = 0

    init(_ observe: @escaping (RemoteDesktopObservation) -> Void) { self.observe = observe }

    func start(counters: RemoteDesktopStatistics) {
        startTime = ProcessInfo.processInfo.systemUptime
        firstFrame = nil; inputs = 0
        receivedBaseline = counters.receivedFrames
        droppedBaseline = counters.droppedFrames
        observe(.attemptStarted)
    }

    func visible(now: TimeInterval, readOnly: Bool) {
        guard firstFrame == nil, let startTime else { return }
        let milliseconds = max(0, now - startTime) * 1_000
        firstFrame = milliseconds
        observe(.firstVisibleFrame(milliseconds: milliseconds, readOnly: readOnly))
    }

    func inputSent() {
        inputs &+= 1
        if inputs == 1 { observe(.firstInputSent) }
    }

    func controlBecameReadOnly() { observe(.controlBecameReadOnly) }

    func end(reason: String, counters: RemoteDesktopStatistics) {
        guard let startTime else { return }
        self.startTime = nil // Repeated lifecycle stops must not duplicate a summary.
        observe(.attemptEnded(.init(
            endedAt: Date(),
            durationMilliseconds: max(0, ProcessInfo.processInfo.systemUptime - startTime) * 1_000,
            firstVisibleFrameMilliseconds: firstFrame, sentInputMessages: inputs,
            receivedFrames: counters.receivedFrames &- receivedBaseline,
            droppedFrames: counters.droppedFrames &- droppedBaseline, reason: reason)))
    }

    static func failureReason(_ error: Error) -> String {
        if let failure = error as? RemoteHostFailure {
            return "host_" + (failure.code?.rawValue ?? "unknown")
        } else if error is RemotePairingError { return "credential_error" }
        else if error is DecodingError { return "protocol_decode_error" }
        else if let transport = error as? RemoteTransportError {
            switch transport {
            case .closed: return "connection_lost"
            case .connectionTimedOut: return "connection_timeout"
            case .keychain: return "credential_storage_error"
            case .invalidCertificate: return "certificate_rejected"
            case .invalidEndpoint: return "endpoint_invalid"
            case .invalidMessage, .oversizedMessage: return "protocol_invalid"
            }
        } else { return "connection_or_stream_error" }
    }
}

extension RemoteDesktopStatistics {
    mutating func updateTiming(queueDepth: Int, decode: [Double], decodeTotal: UInt64,
                               network: [Double], networkTotal: UInt64) {
        decoderQueueDepth = queueDepth
        decodeTiming = .init(samples: decode, total: decodeTotal)
        networkTiming = .init(samples: network, total: networkTotal)
    }
}
