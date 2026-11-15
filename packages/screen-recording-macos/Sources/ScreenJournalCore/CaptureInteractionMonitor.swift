import AppKit
import CoreGraphics

// Observe event occurrence only: no key contents, pointer positions, event tap or AX tree.
@MainActor final class CaptureInteractionMonitor {
    private struct Snapshot: Equatable {
        let counters: [UInt32]
        let application: pid_t?
        let display: CGDirectDisplayID?
    }
    private let types: [CGEventType] = [
        .leftMouseDown, .rightMouseDown, .otherMouseDown,
        .leftMouseUp, .rightMouseUp, .otherMouseUp,
        .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
        .scrollWheel, .keyDown, .keyUp, .flagsChanged,
    ]
    private var previous: Snapshot?
    private var revision = 0
    private var pendingSince: ContinuousClock.Instant?
    private var lastInteraction = ContinuousClock.now
    private var nextCapture = ContinuousClock.now
    private var localMonitor: Any?
    private var globalMonitor: Any?

    init() {
        let mouse: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown,
            .leftMouseUp, .rightMouseUp, .otherMouseUp, .leftMouseDragged, .rightMouseDragged,
            .otherMouseDragged, .scrollWheel]
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: mouse.union([.keyDown, .keyUp, .flagsChanged])) { [weak self] event in
            MainActor.assumeIsolated { self?.request(at: .now) }
            return event
        }
        // Global key monitoring requires additional access. Hardware keyboard
        // counts remain available through the metadata poll without reading keys.
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: mouse) { [weak self] _ in
            MainActor.assumeIsolated { self?.request(at: .now) }
        }
    }
    deinit {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
    }

    func reset() {
        previous = nil
        pendingSince = nil
        nextCapture = .now
        request(at: .now)
    }
    func observe(displayID: CGDirectDisplayID?) {
        let snapshot = Snapshot(counters: types.map { CGEventSource.counterForEventType(.combinedSessionState, eventType: $0) },
            application: NSWorkspace.shared.frontmostApplication?.processIdentifier, display: displayID)
        if let previous, previous != snapshot { request(at: .now) }
        previous = snapshot
    }
    private func request(at now: ContinuousClock.Instant) {
        if pendingSince == nil { pendingSince = now }
        lastInteraction = now
        revision += 1
    }
    func due(at now: ContinuousClock.Instant) -> Int? {
        guard let pendingSince, now >= nextCapture else { return nil }
        // Let a click/scroll settle, but sustained interaction must not starve capture.
        let settled = min(lastInteraction.advanced(by: .milliseconds(250)), pendingSince.advanced(by: .seconds(1)))
        return now >= settled ? revision : nil
    }
    func started(at now: ContinuousClock.Instant, interval: Double) {
        nextCapture = now.advanced(by: .milliseconds(Int64(interval * 1000)))
    }
    func isQuiet(at now: ContinuousClock.Instant) -> Bool {
        pendingSince == nil && lastInteraction.duration(to: now) >= .seconds(1)
    }
    func completed(_ capturedRevision: Int) {
        // Input arriving during capture remains pending for the next eligible sample.
        if revision == capturedRevision { pendingSince = nil }
    }
}
