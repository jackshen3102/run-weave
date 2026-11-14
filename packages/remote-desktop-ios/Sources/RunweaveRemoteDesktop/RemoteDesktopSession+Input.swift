import Foundation
import CoreGraphics
import RunweaveRemoteDesktopProtocol

extension RemoteDesktopSession {
    func makeVideoProgressReporter(isCurrent: @escaping () -> Bool) -> VideoReceiveProgress {
        VideoReceiveProgress(onReceive: { [weak self] in
            guard isCurrent(), let self else { return }
            self.videoInputFreshness.began(now: ProcessInfo.processInfo.systemUptime)
        }) { [weak self] bytes in
            guard isCurrent(), let self, self.videoProgressEnabled, let control = self.control,
                  let geometry = self.geometry else { return }
            var receipt = RemoteControlMessage(kind: .stats, sessionID: self.wireSessionID,
                displayID: geometry.displayID, displayRevision: geometry.revision)
            receipt.videoReceivedBytes = bytes
            try control.sendBestEffort(receipt)
        }
    }

    /// Receipt feedback is not a claim that decoding or display has succeeded.
    func acknowledgeVideo(_ packet: RemoteVideoPacket, roundTripMilliseconds: Double) throws {
        guard let control else { throw RemoteTransportError.closed }
        var receipt = RemoteControlMessage(kind: .stats, sessionID: wireSessionID,
            displayID: packet.header.displayID, displayRevision: packet.header.displayRevision)
        receipt.frames = packet.header.sequence
        receipt.networkRoundTripMilliseconds = roundTripMilliseconds
        try control.sendBestEffort(receipt)
    }

    public func releaseAllInputs(reason: String = "released") {
        inputQueue.removeAll()
        guard active, let control else { return }
        let sessionID = wireSessionID, expected = attempt
        Task { [weak self] in
            do { try await control.send(.init(kind: .releaseAll, sessionID: sessionID, reason: reason)) }
            catch { self?.handleDrop(error, attempt: expected) }
        }
    }

    public func resetViewport() { viewportReset &+= 1 }
    func setTextEntryActive(_ value: Bool) {
        textEntryActive = value
        releaseAllInputs(reason: "keyboard focus changed")
    }

    public func click(at point: CGPoint? = nil, button: Int = 0, count: Int = 1) {
        let position = point ?? cursor
        cursor = position
        for index in 1...max(1, min(count, 2)) {
            sendInput(.init(kind: .pointerDown, x: Double(position.x), y: Double(position.y), button: button == 0 ? 0 : 1, clickCount: index))
            sendInput(.init(kind: .pointerUp, x: Double(position.x), y: Double(position.y), button: button == 0 ? 0 : 1, clickCount: index))
        }
    }
    public func pointerButton(down: Bool, at point: CGPoint, button: Int) {
        cursor = point
        sendInput(.init(kind: down ? .pointerDown : .pointerUp, x: Double(point.x), y: Double(point.y), button: button == 0 ? 0 : 1))
    }
    public func movePointer(to point: CGPoint, dragging: Bool = false) {
        cursor = point
        sendInput(.init(kind: .pointerMove, x: Double(point.x), y: Double(point.y), button: dragging ? 0 : nil))
    }
    public func scroll(at point: CGPoint, deltaX: CGFloat, deltaY: CGFloat) {
        cursor = point
        sendInput(.init(kind: .scroll, x: Double(point.x), y: Double(point.y), deltaX: Double(deltaX), deltaY: Double(deltaY)))
    }
    public func sendText(_ text: String) {
        guard !text.isEmpty, text.utf8.count <= 4096 else { return }
        sendInput(.init(kind: .text, text: text))
    }
    public func sendKey(down: Bool, code: UInt16, modifiers: RemoteModifiers = []) {
        sendInput(.init(kind: down ? .keyDown : .keyUp, keyCode: code, modifiers: UInt8(modifiers.rawValue & 15)))
    }
    public func sendKeyChord(code: UInt16, modifiers: RemoteModifiers = []) {
        let keys: [(RemoteModifiers, UInt16)] = [(.shift, 56), (.control, 59), (.option, 58), (.command, 55)]
        for (flag, key) in keys where modifiers.contains(flag) { sendKey(down: true, code: key, modifiers: modifiers) }
        sendKey(down: true, code: code, modifiers: modifiers); sendKey(down: false, code: code, modifiers: modifiers)
        for (flag, key) in keys.reversed() where modifiers.contains(flag) { sendKey(down: false, code: key) }
    }

}

/// At most two progress receipts per second; full-frame ACKs remain independent.
final class VideoReceiveProgress {
    private var bytes: UInt64 = 0
    private var lastReport: TimeInterval = 0
    private let report: (UInt64) throws -> Void
    private let onReceive: () -> Void
    init(onReceive: @escaping () -> Void = {}, report: @escaping (UInt64) throws -> Void) {
        self.onReceive = onReceive; self.report = report
    }
    func received(_ count: Int) throws {
        onReceive()
        bytes += UInt64(count)
        let now = ProcessInfo.processInfo.systemUptime
        if now - lastReport >= 0.5 { try report(bytes); lastReport = now }
    }
}
