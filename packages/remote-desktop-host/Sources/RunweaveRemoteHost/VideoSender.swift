// Extracted from DesktopCapture.swift; capture setup derives from Mirador@4cc5c0faddcf4ed87599fbd7cba96e5d9bd4285d.
// Copyright (c) 2026 Arnab Saha. MIT; see ThirdPartyLicenses/Mirador-MIT.txt.
import Foundation
import RunweaveRemoteDesktopProtocol

/// Serial media sends with a bounded receipt window. Encoding reservations end at send completion;
/// acknowledgement records retain metadata only, and gate capture before encoding.
final class VideoSender: @unchecked Sendable {
    static func initialBitrate(maximum: Int, feedbackEnabled: Bool) -> Int {
        feedbackEnabled ? min(maximum, 2_000_000) : maximum
    }
    private struct Pending {
        let sequence: UInt64
        let bytes: Int
        var startedAt: UInt64
        var complete: (() -> Void)?
        var sent = false
        var acknowledged = false
    }
    private let lock = NSLock()
    private let channel: RemoteTLSConnection
    private let sessionID: UUID
    private let display: RemoteDisplay
    private let requestKeyframe: () -> Void
    private let onFailure: (Error) -> Void
    private let feedbackEnabled: Bool
    private let onBitrateChanged: (Int) -> Void
    private var pending: [UInt64: Pending] = [:]
    private var sendTask: Task<Void, Never>?
    private var feedbackWatchdog: Task<Void, Never>?
    private var feedbackEpoch = UUID()
    private var lastFeedbackAt: UInt64 = 0
    private var stopped = false
    private var waitingForKeyframe = true
    private var sequence: UInt64 = 0
    private var frames: UInt64 = 0
    private var dropped: UInt64 = 0
    private var encodeMilliseconds = 0.0
    private var encodeSamples: [Double] = []
    private var maximumSendDepth = 0
    private var bitrate: Int
    private var fastAcknowledgements = 0
    private var startupProbeAvailable = true
    private var acknowledgementWindow = RemoteVideoPacket.maximumInFlight
    private var receivedBytes: UInt64 = 0
    private let maximumWindow = 12
    private let maximumPendingBytes = 2 * 1024 * 1024

    init(channel: RemoteTLSConnection, sessionID: UUID, display: RemoteDisplay,
         feedbackEnabled: Bool = false, onBitrateChanged: @escaping (Int) -> Void = { _ in },
         requestKeyframe: @escaping () -> Void, onFailure: @escaping (Error) -> Void) {
        self.channel = channel; self.sessionID = sessionID; self.display = display
        self.feedbackEnabled = feedbackEnabled; self.onBitrateChanged = onBitrateChanged
        self.requestKeyframe = requestKeyframe; self.onFailure = onFailure
        self.bitrate = Self.initialBitrate(maximum: display.bitrate, feedbackEnabled: feedbackEnabled)
    }

    func offer(_ data: Data, keyframe: Bool, milliseconds: Double, complete: @escaping () -> Void) {
        lock.lock()
        guard !stopped else { lock.unlock(); complete(); return }
        sequence &+= 1
        if milliseconds.isFinite, milliseconds >= 0 {
            encodeSamples.append(milliseconds)
            if encodeSamples.count > 256 { encodeSamples.removeFirst() }
        }
        if !hasCapacity() || (waitingForKeyframe && !keyframe) {
            dropped &+= 1; waitingForKeyframe = true
            lock.unlock(); requestKeyframe(); complete(); return
        }
        waitingForKeyframe = false; encodeMilliseconds = milliseconds
        maximumSendDepth = max(maximumSendDepth, pending.count + 1)
        let current = sequence
        pending[current] = Pending(sequence: current, bytes: data.count, startedAt: DispatchTime.now().uptimeNanoseconds, complete: complete)
        if feedbackEnabled && feedbackWatchdog == nil {
            lastFeedbackAt = DispatchTime.now().uptimeNanoseconds; feedbackEpoch = UUID()
            let epoch = feedbackEpoch
            feedbackWatchdog = Task { [weak self] in
                while let wait = self?.feedbackWait(epoch) {
                    if wait == 0 {
                        if self?.expireFeedback(epoch) == true { return }
                    } else {
                        do { try await Task.sleep(nanoseconds: wait) } catch { return }
                    }
                }
            }
        }
        let header = RemoteVideoHeader(sessionID: sessionID, displayID: display.displayID, displayRevision: display.revision,
                                       sequence: current, keyframe: keyframe, encodeMilliseconds: milliseconds)
        let previousSend = sendTask
        sendTask = Task {
            await previousSend?.value
            guard canSend(current) else { return }
            do {
                try await channel.sendData(RemoteVideoPacket(header: header, annexB: data).encoded())
                sent(current)
            } catch { fail(current, error: error) }
        }
        lock.unlock()
    }

    /// Checked before encoding as well as on offer; the encoder still has only three reservations.
    func canSubmit() -> Bool {
        lock.lock(); defer { lock.unlock() }; return !stopped && hasCapacity()
    }
    private func hasCapacity() -> Bool {
        pending.count < (feedbackEnabled ? acknowledgementWindow : 1) &&
            (!feedbackEnabled || pending.values.reduce(0, { $0 + $1.bytes }) < maximumPendingBytes)
    }
    private func canSend(_ sequence: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !stopped, pending[sequence] != nil else { return false }
        pending[sequence]?.startedAt = DispatchTime.now().uptimeNanoseconds
        return true
    }

    private func sent(_ sequence: UInt64) {
        lock.lock()
        guard pending[sequence] != nil else { lock.unlock(); return }
        let complete = pending[sequence]?.complete
        pending[sequence]?.complete = nil; pending[sequence]?.sent = true
        _ = takeCompleted(sequence)
        lock.unlock()
        // ACK records retain metadata only; raw encoder reservations end at send completion.
        complete?()
    }

    func acknowledge(sequence: UInt64, roundTripMilliseconds: Double?) {
        lock.lock()
        guard feedbackEnabled, let frame = pending[sequence], !frame.acknowledged else { lock.unlock(); return }
        // TCP delivers complete frames in order; a receipt also covers earlier sequences.
        lastFeedbackAt = DispatchTime.now().uptimeNanoseconds
        for key in pending.keys.filter({ $0 <= sequence }) { pending[key]?.acknowledged = true }
        let rttMilliseconds = max(0, min(roundTripMilliseconds ?? 0, 10_000))
        acknowledgementWindow = min(maximumWindow, max(RemoteVideoPacket.maximumInFlight,
            Int(ceil(rttMilliseconds / 1000 * Double(display.fps))) + 2))
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - frame.startedAt) / 1_000_000_000
        // Subtract measured control RTT so a distant but fast link is not mistaken for low bandwidth.
        let rtt = rttMilliseconds / 1000
        let transfer = max(0.001, elapsed - rtt)
        let previousBitrate = bitrate
        if transfer > 0.12 {
            bitrate = max(250_000, min(bitrate * 3 / 4, Int(Double(frame.bytes * 8) / transfer * 0.75)))
            fastAcknowledgements = 0
        } else if transfer < 0.06 {
            fastAcknowledgements += 1
            if startupProbeAvailable && fastAcknowledgements >= 3 {
                bitrate = display.bitrate; startupProbeAvailable = false; fastAcknowledgements = 0
            } else if fastAcknowledgements >= 30 {
                bitrate = min(display.bitrate, bitrate * 5 / 4); fastAcknowledgements = 0
            }
        } else { fastAcknowledgements = 0 }
        let newBitrate = bitrate
        let completed = pending.keys.sorted().compactMap { takeCompleted($0) }
        lock.unlock()
        if newBitrate != previousBitrate { onBitrateChanged(newBitrate) }
        for frame in completed { frame.complete?() }
    }

    func acknowledgeProgress(bytes: UInt64) {
        lock.lock(); defer { lock.unlock() }
        guard feedbackEnabled, !stopped, !pending.isEmpty, bytes > receivedBytes else { return }
        receivedBytes = bytes; lastFeedbackAt = DispatchTime.now().uptimeNanoseconds
    }

    /// Called under lock. A fast ACK can arrive before the send callback.
    private func takeCompleted(_ sequence: UInt64) -> Pending? {
        guard let frame = pending[sequence], frame.sent, !feedbackEnabled || frame.acknowledged else { return nil }
        pending.removeValue(forKey: sequence); frames &+= 1
        if pending.isEmpty { feedbackWatchdog?.cancel(); feedbackWatchdog = nil; feedbackEpoch = UUID() }
        return frame
    }

    private func feedbackWait(_ epoch: UUID) -> UInt64? {
        lock.lock(); defer { lock.unlock() }
        guard !stopped, feedbackEpoch == epoch, !pending.isEmpty else { return nil }
        let budget = UInt64(RemoteVideoPacket.completionTimeout * 1_000_000_000)
        let elapsed = DispatchTime.now().uptimeNanoseconds - lastFeedbackAt
        return elapsed >= budget ? 0 : budget - elapsed
    }

    private func expireFeedback(_ epoch: UUID) -> Bool {
        lock.lock()
        guard !stopped, feedbackEpoch == epoch, !pending.isEmpty,
              DispatchTime.now().uptimeNanoseconds - lastFeedbackAt >= UInt64(RemoteVideoPacket.completionTimeout * 1_000_000_000)
        else { lock.unlock(); return false }
        let frames = Array(pending.values); pending.removeAll(); stopped = true; feedbackWatchdog = nil
        lock.unlock()
        channel.close(); for frame in frames { frame.complete?() }
        onFailure(RemoteTransportError.connectionTimedOut); return true
    }

    private func fail(_ sequence: UInt64, error: Error) {
        lock.lock()
        guard pending[sequence] != nil else { lock.unlock(); return }
        let frames = Array(pending.values); pending.removeAll(); stopped = true
        feedbackWatchdog?.cancel(); feedbackWatchdog = nil
        lock.unlock()
        channel.close()
        for frame in frames { frame.complete?() }
        onFailure(error)
    }

    func stop() {
        lock.lock(); stopped = true; let frames = Array(pending.values); pending.removeAll()
        feedbackWatchdog?.cancel(); feedbackWatchdog = nil; lock.unlock()
        for frame in frames { frame.complete?() }
    }

    func stats() -> (frames: UInt64, dropped: UInt64, last: Double, samples: Int, p50: Double, p95: Double, maximumSendDepth: Int, bitrate: Int) {
        lock.lock(); defer { lock.unlock() }
        let sorted = encodeSamples.sorted()
        func percentile(_ value: Double) -> Double { sorted.isEmpty ? 0 : sorted[Int(Double(sorted.count - 1) * value)] }
        return (frames, dropped, encodeMilliseconds, sorted.count, percentile(0.5), percentile(0.95), maximumSendDepth, bitrate)
    }
}
