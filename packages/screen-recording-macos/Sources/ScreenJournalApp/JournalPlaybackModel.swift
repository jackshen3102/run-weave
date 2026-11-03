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
    @Published private(set) var loadingPage = false
    private var queuedPageSeek = false
    var timelineRange: JournalRange? { view?.timelineRange ?? view?.range }
    private var pendingCapture: JournalCapture?
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
    func open(_ range: JournalRange, revision: String, captureID: String? = nil) async {
        do {
            let result = try await service.open(rangeID: range.rangeID, catalogRevision: revision, captureID: captureID)
            if closed { await service.close(viewID: result.viewID); return }
            view = result; position = Double(result.captures.first(where: { $0.id == captureID })?.capturedAtMs ?? result.range.startMs)
            seek(position, resume: false)
            clock = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(50))
                    guard let self, !self.closed else { return }; self.tick()
                }
            }
            let stream = await service.invalidations()
            invalidations = Task { [weak self] in
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
                    let checkingViewID = self.view?.viewID
                    do {
                        guard !self.loadingPage, let currentView = self.view else {
                            try await Task.sleep(for: .milliseconds(100)); continue
                        }
                        let available = try await self.service.availability(viewID: currentView.viewID)
                        guard self.view?.viewID == currentView.viewID, !self.loadingPage else { continue }
                        guard !self.closed, !Task.isCancelled else { return }
                        if !available.invalidCaptureIDs.isEmpty {
                            self.invalidate("记录已过期或清理")
                        }
                    } catch { if !self.loadingPage, self.view?.viewID == checkingViewID { self.invalidate("记录暂不可用") } }
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
        guard let view, let range = timelineRange else { return }
        if state == "playing" || state == "buffering" { pause(); return }
        if state == "unavailable" || loadingPage { return }
        controlGeneration += 1; let control = controlGeneration
        resumeAfterLoad = true; state = "buffering"
        Task {
            do {
                let validity = try await service.availability(viewID: view.viewID)
                guard !closed, state != "unavailable", control == controlGeneration else { return }
                guard validity.invalidCaptureIDs.isEmpty else { invalidate("记录已过期或清理"); return }
                if position >= Double(range.endMs) { seek(Double(range.startMs), resume: true) }
                else { state = "playing"; lastTick = .now }
            } catch { invalidate("记录暂不可用") }
        }
    }
    private func tick() {
        guard !closed, state != "unavailable", !loadingPage else { return }
        if let view, view.expiresAt <= journalNowMs() { invalidate("记录已过期，请返回刷新"); return }
        guard state == "playing", let range = timelineRange else { return }
        let now = ContinuousClock.now
        let duration = lastTick.duration(to: now).components
        let delta = Double(duration.seconds) + Double(duration.attoseconds) / 1e18
        lastTick = now
        let target = min(Double(range.endMs), position + delta * Double(speed) * 1000)
        seek(target, resume: target < Double(range.endMs))
    }
    func beginScrub() {
        guard !closed, state != "unavailable" else { return }
        wasPlaying = state == "playing" || (state == "buffering" && resumeAfterLoad)
        isScrubbing = true; pause()
        if !loadingPage { generation += 1; request?.cancel(); pendingCapture = nil }
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
        guard let view, !view.captures.isEmpty, !loadingPage else { return }
        pause(); let index = (pendingCapture ?? current).flatMap { c in view.captures.firstIndex { $0.id == c.id } } ?? 0
        if index + direction < 0, (view.pageOffset ?? 0) > 0 {
            loadPage(offset: (view.pageOffset ?? 0) - 900, resume: false, edge: -1); return
        }
        if index + direction >= view.captures.count, let range = view.timelineRange,
           (view.pageOffset ?? 0) + view.captures.count < range.sampleCount {
            loadPage(offset: (view.pageOffset ?? 0) + 900, resume: false, edge: 1); return
        }
        let target = view.captures[max(0, min(view.captures.count - 1, index + direction))]
        seek(Double(target.capturedAtMs), resume: false, exact: target)
    }
    func select(_ capture: JournalCapture) { pause(); seek(Double(capture.capturedAtMs), resume: false, exact: capture) }
    private func seek(_ value: Double, resume: Bool, scrubbing: Bool = false, exact: JournalCapture? = nil) {
        guard let view, let range = timelineRange, !closed, state != "unavailable" else { return }
        position = max(Double(range.startMs), min(Double(range.endMs), value))
        if loadingPage { resumeAfterLoad = resume; queuedPageSeek = true; return }
        let ms = Int64(position)
        let gap = view.intervals.first { $0.kind != "privacy" && $0.kind != "unknown" && ms >= $0.startMs && ms < $0.endMs }
            ?? view.intervals.first { $0.kind == "unknown" && ms >= $0.startMs && ms < $0.endMs }
        if let gap, exact == nil {
            generation += 1; request?.cancel(); pendingCapture = nil; image = nil; current = nil
            message = gap.kind == "unknown" ? "此区间无采样" : "此区间暂停或不可记录"
            state = scrubbing ? "scrubbing" : resume ? "playing" : "paused"; return
        }
        if let first = view.captures.first, let last = view.captures.last, let full = view.timelineRange,
           ms < first.capturedAtMs || (ms > last.capturedAtMs && (view.pageOffset ?? 0) + view.captures.count < full.sampleCount) {
            loadPage(atMs: ms, resume: resume, scrubbing: scrubbing); return
        }
        guard let target = exact ?? view.captures.last(where: { $0.capturedAtMs <= ms }) else { return }
        if target.availableUntilMs <= journalNowMs() { invalidate("记录已过期"); return }
        if current?.id == target.id, image != nil || target.privacyPlaceholder {
            generation += 1; request?.cancel(); pendingCapture = nil
            state = scrubbing ? "scrubbing" : resume ? "playing" : "paused"; return
        }
        generation += 1; let token = generation; request?.cancel(); pendingCapture = nil
        message = target.privacyPlaceholder ? "隐私保护 · 未记录应用内容" : "加载画面…"
        if target.privacyPlaceholder {
            image = nil; current = target
            state = scrubbing ? "scrubbing" : resume ? "playing" : "paused"; return
        }
        // Keep the displayed frame and its metadata together until the replacement
        // is ready. Privacy, gaps and invalidation still clear the image immediately.
        pendingCapture = target
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
                guard let nextImage = NSImage(data: data) else { throw JournalReadError("MEDIA_UNAVAILABLE") }
                image = nextImage; current = target; pendingCapture = nil; message = ""
                if resumeAfterLoad && !scrubbing { position = Double(target.capturedAtMs) }
                state = scrubbing ? "scrubbing" : resumeAfterLoad ? "playing" : "paused"; lastTick = .now
                #if DEBUG
                let elapsed = presentationStart.duration(to: .now).components
                await service.recordPresentation(milliseconds: Int(elapsed.seconds * 1000 + elapsed.attoseconds / 1_000_000_000_000_000))
                #endif
            } catch {
                guard !Task.isCancelled, !closed, generation == token else { return }
                state = "unavailable"; pendingCapture = nil; image = nil; message = "画面暂不可用"
            }
        }
    }
    func filmstripCaptures(all: Bool) -> [JournalCapture] {
        guard state != "unavailable", let captures = view?.captures, !captures.isEmpty else { return [] }
        if all { return captures }
        var candidates = [0]
        for index in captures.indices.dropFirst() {
            let current = captures[index], previous = captures[index - 1]
            if current.visualChanged != false || current.privacyPlaceholder != previous.privacyPlaceholder ||
               current.frontmostApplication?.id != previous.frontmostApplication?.id { candidates.append(index) }
        }
        if candidates.last != captures.count - 1 { candidates.append(captures.count - 1) }
        if candidates.count > 24 {
            candidates = (0..<24).map { candidates[Int((Double($0) * Double(candidates.count - 1) / 23).rounded())] }
        }
        return candidates.map { captures[$0] }
    }
    func pageBy(_ direction: Int) {
        guard let view, let range = view.timelineRange, !loadingPage else { return }
        let offset = (view.pageOffset ?? 0) + direction * 900
        guard offset >= 0, offset < range.sampleCount else { return }
        pause(); loadPage(offset: offset, resume: false, edge: direction)
    }
    private func loadPage(atMs: Int64? = nil, offset: Int? = nil, resume: Bool, scrubbing: Bool = false, edge: Int = 0) {
        guard let previous = view, !closed, state != "unavailable" else { return }
        generation += 1; let token = generation
        request?.cancel(); pendingCapture = nil; loadingPage = true; queuedPageSeek = false
        image = nil; current = nil; resumeAfterLoad = resume
        message = "正在读取这个时段…"; state = scrubbing ? "scrubbing" : "buffering"
        request = Task {
            do {
                let next = try await service.page(viewID: previous.viewID, offset: offset, atMs: atMs)
                guard !Task.isCancelled, !closed, generation == token else { await service.close(viewID: next.viewID); return }
                view = next
                await service.close(viewID: previous.viewID)
                guard !Task.isCancelled, !closed, generation == token else { return }
                loadingPage = false
                let exact = queuedPageSeek ? nil : edge < 0 ? next.captures.last : edge > 0 ? next.captures.first : nil
                let time = queuedPageSeek ? Int64(position) : exact?.capturedAtMs ?? max(next.range.startMs, atMs ?? next.range.startMs)
                queuedPageSeek = false
                seek(Double(time), resume: resumeAfterLoad, scrubbing: isScrubbing, exact: exact)
            } catch {
                guard !Task.isCancelled, !closed, generation == token else { return }
                loadingPage = false; invalidate("这个时段暂不可用，请返回刷新")
            }
        }
    }
    private func invalidate(_ reason: String) {
        generation += 1; request?.cancel(); pendingCapture = nil; loadingPage = false; scrubDispatch?.cancel(); scrubDispatch = nil
        pause(); image = nil; current = nil; state = "unavailable"; message = reason
    }
    func close() {
        closed = true; state = "unavailable"; generation += 1; request?.cancel(); pendingCapture = nil; clock?.cancel(); validity?.cancel(); invalidations?.cancel(); scrubDispatch?.cancel(); image = nil
        if let view { Task { await service.close(viewID: view.viewID) } }; view = nil
    }
}
