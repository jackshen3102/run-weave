import SwiftUI
import AppKit

@MainActor final class JournalPlaybackModel: ObservableObject {
    @Published private(set) var view: JournalView?
    @Published private(set) var image: NSImage?
    @Published private(set) var current: JournalCapture?
    @Published private(set) var state = "loading"
    @Published private(set) var message = ""
    @Published var position: Double = 0
    @Published var speed = 20
    private let service: JournalReadService
    private var generation = 0
    private var request: Task<Void, Never>?
    private var clock: Task<Void, Never>?
    private var validity: Task<Void, Never>?
    private var invalidations: Task<Void, Never>?
    private var scrubDispatch: Task<Void, Never>?
    private var controlGeneration = 0
    private var wasPlaying = false
    private var isScrubbing = false
    private var resumeAfterLoad = false
    private var lastTick = ContinuousClock.now
    private var closed = false
    init(service: JournalReadService) {
        self.service = service
        let saved = UserDefaults.standard.integer(forKey: "journalPlaybackSpeed")
        speed = [20,40,60].contains(saved) ? saved : 20
    }
    func open(_ range: JournalRange, revision: String) async {
        do {
            let result = try await service.open(rangeID: range.rangeID, catalogRevision: revision)
            if closed { await service.close(viewID: result.viewID); return }
            view = result; position = Double(range.startMs)
            seek(position, resume: false)
            clock = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(50))
                    guard let self, !self.closed else { return }; self.tick()
                }
            }
            invalidations = Task { [weak self] in
                let stream = await service.invalidations()
                var initial = true
                for await _ in stream {
                    guard let self, !Task.isCancelled else { return }
                    if initial { initial = false; continue }
                    self.invalidate("记录可用性已变化，请返回刷新")
                }
            }
            validity = Task { [weak self] in
                while !Task.isCancelled {
                    guard let self, !self.closed else { return }
                    do {
                        let available = try await self.service.availability(viewID: result.viewID)
                        guard !self.closed, !Task.isCancelled else { return }
                        if !available.invalidCaptureIDs.isEmpty {
                            self.invalidate("记录已过期或清理")
                        }
                    } catch { self.invalidate("记录暂不可用") }
                    try? await Task.sleep(for: .seconds(2))
                }
            }
        } catch { state = "unavailable"; message = (error as? JournalReadError)?.code == "CATALOG_CHANGED" ? "记录已更新，请返回刷新" : "记录暂不可用" }
    }
    func setSpeed(_ value: Int) {
        guard [20,40,60].contains(value) else { return }
        speed = value; UserDefaults.standard.set(value, forKey: "journalPlaybackSpeed"); lastTick = .now
    }
    func pause() { controlGeneration += 1; resumeAfterLoad = false; if state == "playing" || state == "buffering" { state = "paused" } }
    func toggle() {
        guard let view else { return }
        if state == "playing" || state == "buffering" { pause(); return }
        if state == "unavailable" { return }
        controlGeneration += 1; let control = controlGeneration
        resumeAfterLoad = true; state = "buffering"
        Task {
            do {
                let validity = try await service.availability(viewID: view.viewID)
                guard !closed, state != "unavailable", control == controlGeneration else { return }
                guard validity.invalidCaptureIDs.isEmpty else { invalidate("记录已过期或清理"); return }
                if position >= Double(view.range.endMs) { seek(Double(view.range.startMs), resume: true) }
                else { state = "playing"; lastTick = .now }
            } catch { invalidate("记录暂不可用") }
        }
    }
    private func tick() {
        guard !closed, state != "unavailable" else { return }
        if let view, view.expiresAt <= journalNowMs() { invalidate("记录已过期，请返回刷新"); return }
        guard state == "playing", let view else { return }
        let now = ContinuousClock.now
        let duration = lastTick.duration(to: now).components
        let delta = Double(duration.seconds) + Double(duration.attoseconds) / 1e18
        lastTick = now
        let target = min(Double(view.range.endMs), position + delta * Double(speed) * 1000)
        seek(target, resume: target < Double(view.range.endMs))
    }
    func beginScrub() {
        guard !closed, state != "unavailable" else { return }
        wasPlaying = state == "playing" || (state == "buffering" && resumeAfterLoad)
        isScrubbing = true; pause(); generation += 1; request?.cancel()
        state = "scrubbing"
    }
    func scrub(_ value: Double) {
        guard !closed, state != "unavailable" else { return }
        position = value
        // SwiftUI can deliver the final binding value after editing ends.
        // Such a value is a final seek, never another scrubbing request.
        guard isScrubbing else {
            seek(value, resume: state == "playing" || (state == "buffering" && resumeAfterLoad)); return
        }
        if scrubDispatch == nil {
            scrubDispatch = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(67))
                guard let self, !Task.isCancelled, self.isScrubbing else { return }
                self.scrubDispatch = nil; self.seek(self.position, resume: false, scrubbing: true)
            }
        }
    }
    func endScrub() {
        guard !closed, state != "unavailable" else { isScrubbing = false; return }
        isScrubbing = false; scrubDispatch?.cancel(); scrubDispatch = nil
        resumeAfterLoad = wasPlaying
        state = wasPlaying ? "buffering" : "paused"
        seek(position, resume: wasPlaying)
    }
    func step(_ direction: Int) {
        guard let view, !view.captures.isEmpty else { return }
        pause(); let index = current.flatMap { c in view.captures.firstIndex { $0.id == c.id } } ?? 0
        let target = view.captures[max(0, min(view.captures.count - 1, index + direction))]
        seek(Double(target.capturedAtMs), resume: false, exact: target)
    }
    func select(_ capture: JournalCapture) { pause(); seek(Double(capture.capturedAtMs), resume: false, exact: capture) }
    private func seek(_ value: Double, resume: Bool, scrubbing: Bool = false, exact: JournalCapture? = nil) {
        guard let view, !closed, state != "unavailable" else { return }
        position = max(Double(view.range.startMs), min(Double(view.range.endMs), value))
        let ms = Int64(position)
        let gap = view.intervals.first { $0.kind != "privacy" && $0.kind != "unknown" && ms >= $0.startMs && ms < $0.endMs }
            ?? view.intervals.first { $0.kind == "unknown" && ms >= $0.startMs && ms < $0.endMs }
        if let gap, exact == nil {
            generation += 1; request?.cancel(); image = nil; current = nil
            message = gap.kind == "unknown" ? "此区间无采样" : "此区间暂停或不可记录"
            state = scrubbing ? "scrubbing" : resume ? "playing" : "paused"; return
        }
        guard let target = exact ?? view.captures.last(where: { $0.capturedAtMs <= ms }) else { return }
        if target.availableUntilMs <= journalNowMs() { invalidate("记录已过期"); return }
        if current?.id == target.id, image != nil || target.privacyPlaceholder {
            state = scrubbing ? "scrubbing" : resume ? "playing" : "paused"; return
        }
        generation += 1; let token = generation; request?.cancel(); current = target; image = nil
        message = target.privacyPlaceholder ? "隐私保护 · 未记录应用内容" : "加载画面…"
        if target.privacyPlaceholder { state = scrubbing ? "scrubbing" : resume ? "playing" : "paused"; return }
        state = scrubbing ? "scrubbing" : "buffering"; resumeAfterLoad = resume
        let presentationStart = ContinuousClock.now
        request = Task {
            do {
                var data: Data?
                let deadline = ContinuousClock.now.advanced(by: .seconds(5))
                while data == nil {
                    try Task.checkCancellation()
                    do { data = try await service.frame(viewID: view.viewID, captureID: target.id, variant: .full) }
                    catch let error as JournalReadError where error.code == "BUSY" && ContinuousClock.now < deadline {
                        try await Task.sleep(for: .milliseconds(50))
                    }
                }
                guard let data else { return }
                guard !Task.isCancelled, !closed, generation == token else { return }
                image = NSImage(data: data); message = image == nil ? "画面不可用" : ""
                if resumeAfterLoad && !scrubbing { position = Double(target.capturedAtMs) }
                state = scrubbing ? "scrubbing" : resumeAfterLoad ? "playing" : "paused"; lastTick = .now
                #if DEBUG
                let elapsed = presentationStart.duration(to: .now).components
                await service.recordPresentation(milliseconds: Int(elapsed.seconds * 1000 + elapsed.attoseconds / 1_000_000_000_000_000))
                #endif
            } catch {
                guard !Task.isCancelled, !closed, generation == token else { return }
                state = "unavailable"; image = nil; message = "画面暂不可用"
            }
        }
    }
    private func invalidate(_ reason: String) {
        generation += 1; request?.cancel(); scrubDispatch?.cancel(); scrubDispatch = nil
        pause(); image = nil; current = nil; state = "unavailable"; message = reason
    }
    func close() {
        closed = true; state = "unavailable"; generation += 1; request?.cancel(); clock?.cancel(); validity?.cancel(); invalidations?.cancel(); scrubDispatch?.cancel(); image = nil
        if let view { Task { await service.close(viewID: view.viewID) } }; view = nil
    }
}
