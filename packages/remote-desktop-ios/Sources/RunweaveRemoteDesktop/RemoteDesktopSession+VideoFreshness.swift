import Foundation
import RunweaveRemoteDesktopProtocol

/// A static desktop is not stale. Only a frame whose receipt/decode has begun starts this clock.
/// Suspension is latched for the wire session: queued old frames cannot silently reopen input.
struct RemoteVideoInputFreshness {
    static let maximumPendingTime: TimeInterval = 3
    private(set) var pendingSince: TimeInterval?
    private(set) var isSuspended = false
    mutating func began(now: TimeInterval) { if pendingSince == nil { pendingSince = now } }
    mutating func suspendIfDelayed(now: TimeInterval) -> Bool {
        guard !isSuspended, let started = pendingSince, now - started >= Self.maximumPendingTime else { return false }
        isSuspended = true; return true
    }
    mutating func finished() { pendingSince = nil }
}

extension RemoteDesktopSession {
    func pauseControlForStaleVideoIfNeeded() {
        guard active, controlAllowed, videoInputFreshness.suspendIfDelayed(now: ProcessInfo.processInfo.systemUptime) else { return }
        markControlPaused()
        inputQueue.removeAll()
        guard let control else { return }
        let expected = attempt, sessionID = wireSessionID
        do { try control.sendBestEffort(.init(kind: .releaseAll, sessionID: sessionID, reason: "video update delayed")) }
        catch { handleDrop(error, attempt: expected); return }
        // Never cancel the in-flight send: that closes the control connection. Release again after it drains.
        if let pendingInput = inputTask {
            Task { [weak self] in
                await pendingInput.value
                guard let self, self.active, self.attempt == expected, self.control === control else { return }
                do { try control.sendBestEffort(.init(kind: .releaseAll, sessionID: sessionID, reason: "delayed video drained input")) }
                catch { self.handleDrop(error, attempt: expected) }
            }
        }
    }

    func finishReceivedVideoFrame() {
        pauseControlForStaleVideoIfNeeded()
        videoInputFreshness.finished()
    }

    /// Explicit user recovery starts a new authenticated stream; no queued input is replayed.
    public func reconnectControl() {
        guard active, videoInputFreshness.isSuspended, let target, let context else { return }
        connect(target: target, context: context)
    }
}
