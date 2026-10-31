import AppKit
import Combine

@MainActor final class CaptureCoordinator: ObservableObject {
    @Published private(set) var status = RuntimeStatus()
    @Published private(set) var settings = RecordingSettings()
    let paths: StorePaths
    private var engine: StorageEngine?
    private let displays = ActiveDisplayTracker()
    private let system = SystemStateObserver()
    private var timer: Timer?
    private var worker: Task<Void, Never>?
    private var pendingFinalize = false
    private var closing = false
    private var ready = false
    private var fatal = false
    private var nextTick = ContinuousClock.now
    private var retryAt = ContinuousClock.now
    private var resumeAt = ContinuousClock.now
    private var failureSince: ContinuousClock.Instant?
    private var failureCount = 0
    private var lastMaintenance = ContinuousClock.now
    private var lastSnapshot = ContinuousClock.now
    private var systemPaused = false
    private let permit = CapturePermit()
    private var events: [(String, String, Date)] = []
    private var sequence = 0
    private var stoppedWaiters: [CheckedContinuation<Void, Never>] = []
    init(paths: StorePaths) {
        self.paths = paths
        status.validation = paths.validation; status.maxBytesOverride = paths.maxBytesOverride; status.freeBytesOverride = paths.freeBytesOverride
    }
    func initialize() async {
        do {
            // Lock and schema compatibility are checked before changing settings or runtime files.
            let engine = try StorageEngine(paths: paths)
            self.engine = engine
            settings = try RecordingSettings.load(paths)
            status.desiredRecording = settings.desiredRecording; status.privacyRevision = settings.privacyRevision
            status.sessionID = engine.sessionID
            status.diskBytes = try await engine.prepare(settings: settings)
            systemPaused = system.paused
            system.onChange = { [weak self] in self?.systemChanged() }
            ready = true; nextTick = .now; resumeAt = .now.advanced(by: .seconds(systemPaused ? 5 : 0))
            transition(settings.desiredRecording ? (systemPaused ? "pausedSystem" : "starting") : "stopped", "startup")
            timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
        } catch { status.state = "failed"; status.reason = error.localizedDescription; fatal = true }
    }
    func start() {
        guard ready, !closing else { return }
        do {
            settings.desiredRecording = true; try paths.write(settings, to: "settings.json")
            status.desiredRecording = true; invalidate(); fatal = false
            failureSince = nil; failureCount = 0; retryAt = .now; nextTick = .now
            transition(systemPaused ? "pausedSystem" : "starting", systemPaused ? "system_inactive" : "user_started"); tick()
        } catch { fail(error) }
    }
    func pause() {
        guard ready, !closing else { return }
        invalidate(); settings.desiredRecording = false; status.desiredRecording = false
        do { try paths.write(settings, to: "settings.json") } catch { fail(error) }
        pendingFinalize = true; transition("stopped", "manual_pause"); tick()
    }
    func apply(_ proposed: RecordingSettings) throws {
        guard ready, !closing else { throw journalError("recorder_not_ready") }
        var next = try proposed.validated()
        next.desiredRecording = settings.desiredRecording
        next.privacyRevision = settings.privacyRevision + 1
        try paths.write(next, to: "settings.json")
        invalidate(); settings = next; status.privacyRevision = next.privacyRevision
        pendingFinalize = true; lastMaintenance = .now.advanced(by: .seconds(-60)); nextTick = .now
        transition(status.state, "settings_changed"); tick()
    }
    func shutdown() async -> Bool {
        guard ready, let engine else { return true }
        closing = true; timer?.invalidate(); timer = nil
        invalidate(); settings.desiredRecording = false; status.desiredRecording = false
        do {
            try paths.write(settings, to: "settings.json")
            if worker != nil { await withCheckedContinuation { stoppedWaiters.append($0) } }
            await flushEvents()
            status.diskBytes = try await timed("finalize_timeout") { try await engine.shutdown(settings: self.settings) }
            transition("stopped", "normal_exit")
            try snapshot()
            return true
        } catch { fail(error); closing = false; return false }
    }
    private func systemChanged() {
        let paused = system.paused
        if paused == systemPaused { return }
        systemPaused = paused; invalidate(); pendingFinalize = true
        if paused { transition(settings.desiredRecording ? "pausedSystem" : "stopped", "system_inactive") }
        else {
            resumeAt = .now.advanced(by: .seconds(5))
            // System-paused time and the recovery delay are not eligible sampling ticks.
            nextTick = resumeAt
            transition(settings.desiredRecording ? "starting" : "stopped", "system_resuming")
        }
        tick()
    }
    private func tick() {
        guard ready, !closing, let engine else { return }
        displays.poll()
        if system.paused != systemPaused { systemChanged(); return }
        let now = ContinuousClock.now
        if lastSnapshot.duration(to: now) >= .seconds(5) { do { try snapshot() } catch { fail(error) }; lastSnapshot = now }
        var sampleDue = false
        var elapsedTicks = 0
        if settings.desiredRecording && !systemPaused && now >= resumeAt && now >= nextTick {
            // Preserve elapsed ticks even while capture/encoding is busy or retrying.
            repeat { elapsedTicks += 1; status.expectedTicks += 1; nextTick = nextTick.advanced(by: .milliseconds(Int64(settings.interval * 1000))) } while nextTick <= now
            sampleDue = true
        }
        if worker != nil {
            if sampleDue { status.busySkipped += elapsedTicks }
            return
        }
        if pendingFinalize || lastMaintenance.duration(to: now) >= .seconds(60) {
            let mustFinalize = pendingFinalize
            pendingFinalize = false; lastMaintenance = now
            if sampleDue { status.busySkipped += elapsedTicks }
            launch {
                do {
                    if mustFinalize { try await self.timed("finalize_timeout") { try await engine.finalize() } }
                    self.status.diskBytes = try await self.timed("maintenance_timeout") { try await engine.maintain(settings: self.settings) }
                } catch { self.fail(error, storage: true) }
            }
            return
        }
        guard sampleDue else {
            if !events.isEmpty { launch {} }
            return
        }
        status.busySkipped += max(0, elapsedTicks - 1)
        if let since = failureSince, since.duration(to: now) >= .seconds(600) { fatal = true; transition("failed", "capture_failed_for_10_minutes") }
        guard !fatal, now >= retryAt else { status.failedSamples += 1; return }
        if systemPaused { transition("pausedSystem", "system_inactive"); return }
        guard CGPreflightScreenCaptureAccess() else {
            status.failedSamples += 1; invalidate(); pendingFinalize = true; fatal = true
            transition("blockedPermission", "screen_permission_required"); return
        }
        guard let display = displays.selected else {
            status.failedSamples += 1; transition("starting", "display_unavailable"); return
        }
        let generation = status.generation; let currentSettings = settings
        launch {
            var captureCompleted = false
            do {
                guard generation == self.status.generation, self.settings.desiredRecording, !self.system.paused else { self.status.discarded += 1; return }
                guard try self.paths.freeBytes() >= gib else { throw journalError("storage_free_space_below_1GiB") }
                self.transition("recording", "sampling")
                let frame = try await self.timed("capture_timeout") {
                    try await ScreenCaptureAdapter().capture(displayID: display, settings: currentSettings)
                }
                captureCompleted = true
                guard generation == self.status.generation, self.settings.desiredRecording, !self.system.paused,
                      currentSettings.privacyRevision == self.settings.privacyRevision,
                      !PrivacyFilter.blocked(PrivacyFilter.frontmostID(), settings: self.settings) || frame.placeholder else {
                    self.status.discarded += 1; try await engine.event("gap", "stale_or_private_capture", affected: 1); return
                }
                // Recheck permission and active display after the asynchronous platform request.
                guard CGPreflightScreenCaptureAccess(), self.displays.selected == display, CGDisplayIsActive(display) != 0 else {
                    self.status.discarded += 1; return
                }
                try await self.timed("finalize_timeout") { try await engine.prepareAppend(frame) }
                guard generation == self.status.generation, !self.system.paused,
                      !PrivacyFilter.blocked(PrivacyFilter.frontmostID(), settings: self.settings) || frame.placeholder else { self.status.discarded += 1; return }
                self.sequence += 1
                if try await self.timed("encoding_timeout", operation: { try await engine.append(frame, sequence: self.sequence, permit: self.permit, generation: generation) }) {
                    self.status.successfulSamples += 1; self.status.lastSuccess = frame.capturedAt.timeIntervalSince1970
                    if frame.placeholder { self.status.privacySamples += 1 }
                    self.failureCount = 0; self.failureSince = nil; self.retryAt = .now
                } else { self.status.busySkipped += 1; try await engine.event("gap", "encoder_busy", affected: 1) }
                if await engine.needsRotation() {
                    try await self.timed("finalize_timeout") { try await engine.finalize() }
                    self.status.diskBytes = try await engine.maintain(settings: self.settings)
                }
            } catch {
                self.status.failedSamples += 1
                if self.closing || generation != self.status.generation { return }
                if !CGPreflightScreenCaptureAccess() { self.fatal = true; self.pendingFinalize = true; self.transition("blockedPermission", "screen_permission_required") }
                else if error.localizedDescription.contains("storage_") { self.fail(error, storage: true); self.pendingFinalize = true }
                else if captureCompleted { self.fail(error) }
                else {
                    self.failureCount += 1
                    if self.failureSince == nil { self.failureSince = .now }
                    let delays = [60, 120, 300, 600]
                    self.retryAt = .now.advanced(by: .seconds(delays[min(self.failureCount - 1, 3)]))
                    self.transition("starting", error.localizedDescription)
                    if let since = self.failureSince, since.duration(to: .now) >= .seconds(600) { self.fail(error) }
                }
                try? await engine.event(self.status.state, self.status.reason, affected: 1)
            }
        }
    }
    private func launch(_ action: @escaping @MainActor () async -> Void) {
        status.inFlight = true
        worker = Task {
            await self.flushEvents()
            await action()
            await self.flushEvents()
            self.status.inFlight = false; self.worker = nil
            do { try self.snapshot() } catch { self.fail(error) }
            let waiters = self.stoppedWaiters; self.stoppedWaiters.removeAll()
            for waiter in waiters { waiter.resume() }
        }
    }
    private func timed<T>(_ reason: String, operation: () async throws -> T) async throws -> T {
        var expired = false
        let watchdog = Task { @MainActor in
            do { try await Task.sleep(for: .seconds(30)) } catch { return }
            expired = true; self.invalidate(); self.fatal = true
            self.transition("failed", reason)
        }
        defer { watchdog.cancel() }
        let result = try await operation()
        if expired { throw journalError(reason) }
        return result
    }
    private func transition(_ state: String, _ reason: String) {
        status.state = state; status.reason = reason
        if events.last?.0 != state || events.last?.1 != reason {
            if events.count < 256 { events.append((state, reason, Date())) }
            else { fatal = true; status.state = "failed"; status.reason = "state_event_queue_full" }
        }
        do { try snapshot() } catch { status.state = "blockedStorage"; status.reason = error.localizedDescription; fatal = true }
    }
    private func fail(_ error: Error, storage: Bool = false) {
        fatal = true; invalidate()
        transition(storage ? "blockedStorage" : "failed", error.localizedDescription)
    }
    private func invalidate() { status.generation = permit.invalidate() }
    private func flushEvents() async {
        guard let engine else { return }
        let batch = events; events.removeAll()
        do { for event in batch { try await engine.event(event.0, event.1, at: event.2) } }
        catch { fail(error, storage: true) }
    }
    private func snapshot() throws {
        guard ready else { return }
        status.updatedAt = Date().timeIntervalSince1970
        try paths.write(status, to: "runtime/status.json")
    }
}
