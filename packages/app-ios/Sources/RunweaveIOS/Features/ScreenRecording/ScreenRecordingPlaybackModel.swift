import SwiftUI
import UIKit
import os

@available(iOS 17.0, *)
@MainActor final class ScreenRecordingPlaybackModel: ObservableObject {
    @Published private(set) var view: ScreenRecordingView?
    @Published private(set) var image: UIImage?
    @Published private(set) var current: ScreenRecordingCapture?
    @Published private(set) var state = "loading"
    @Published private(set) var message = ""
    @Published var position: Double = 0
    @Published var speed = 20
    let service: ScreenRecordingSource
    private var generation = 0
    private var request: Task<Void, Never>?
    private var pendingCapture: ScreenRecordingCapture?
    private var clock: Task<Void, Never>?
    private var validity: Task<Void, Never>?
    private var scrubDispatch: Task<Void, Never>?
    private var wasPlaying = false
    private var isScrubbing = false
    private var resumeAfterLoad = false
    private var lastTick = ContinuousClock.now
    private var closed = false
    private var pendingClose: Task<Void, Never>?
    private var pendingInvalidation: Task<Void, Never>?
    private var recoveringConnection = false
    private var lastConfirmed: ContinuousClock.Instant?
    init(service: ScreenRecordingSource) {
        self.service = service
        let saved = UserDefaults.standard.integer(forKey: "journalPlaybackSpeed")
        speed = [20,40,60].contains(saved) ? saved : 20
    }
    func activate(_ range: ScreenRecordingRange, revision: String) async {
        await pendingClose?.value
        guard !Task.isCancelled, view == nil else { return }
        closed = false; recoveringConnection = false; state = "loading"; current = nil; message = "正在下载录屏包…"
        await open(range, revision: revision)
    }
    private func open(_ range: ScreenRecordingRange, revision: String) async {
        let openingGeneration = generation
        do {
            let result = try await service.open(rangeID: range.rangeID, catalogRevision: revision)
            if closed || Task.isCancelled || openingGeneration != generation { await service.close(viewID: result.viewID); return }
            lastConfirmed = .now
            view = result; position = Double(range.startMs)
            seek(position, resume: false)
            clock = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(50))
                    guard let self, !self.closed else { return }; self.tick()
                }
            }
            validity = Task { [weak self] in
                while !Task.isCancelled {
                    guard let self, !self.closed else { return }
                    do {
                        await self.pendingInvalidation?.value
                        let available = try await self.service.availability(viewID: result.viewID)
                        guard !self.closed, !Task.isCancelled else { return }
                        self.lastConfirmed = .now
                        guard available.invalidCaptureIDs.isEmpty else { self.invalidate("记录已过期或清理"); return }
                        if self.recoveringConnection {
                            try await self.service.preparePackage(viewID: result.viewID)
                            guard !self.closed, !Task.isCancelled else { return }
                            self.lastConfirmed = .now; self.recoveringConnection = false; self.state = "paused"
                            self.seek(self.position, resume: false)
                        }
                    } catch {
                        guard !self.closed, !Task.isCancelled else { return }
                        self.connectionFailure(error)
                    }
                    try? await Task.sleep(for: .seconds(2))
                }
            }
        } catch { guard !closed, !Task.isCancelled, openingGeneration == generation else { return }; state = "unavailable"; message = (error as? ScreenRecordingReadError)?.code == "CATALOG_CHANGED" ? "记录已更新，请返回刷新" : (error as? ScreenRecordingReadError)?.code == "UPDATE_REQUIRED" ? "请更新这台 Mac 的 Runweave 和 ScreenJournal 后重试" : "录屏包下载失败，请返回重试" }
    }
    func setSpeed(_ value: Int) {
        guard [20,40,60].contains(value) else { return }
        speed = value; UserDefaults.standard.set(value, forKey: "journalPlaybackSpeed"); lastTick = .now
    }
    func pause() { resumeAfterLoad = false; if state == "playing" || state == "buffering" { state = "paused" } }
    func toggle() {
        guard let view else { return }
        if state == "playing" || state == "buffering" { pause(); return }
        if state == "unavailable" { return }
        guard let confirmed = lastConfirmed, confirmed.duration(to: .now) <= .seconds(5) else {
            invalidate("连接暂时中断，正在重新连接…", recoverable: true); return
        }
        resumeAfterLoad = true
        if position >= Double(view.range.endMs) { seek(Double(view.range.startMs), resume: true) }
        else { state = "playing"; lastTick = .now }
    }

    private func tick() {
        guard !closed, state != "unavailable" else { return }
        if let view, view.expiresAt <= screenRecordingNowMs() { invalidate("记录已过期，请返回刷新"); return }
        if let confirmed = lastConfirmed, confirmed.duration(to: .now) > .seconds(5) {
            invalidate("连接暂时中断，正在重新连接…", recoverable: true); return
        }
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
        #if DEBUG
        Logger(subsystem: "com.runweave.app.native", category: "ScreenRecording").debug("scrubBegin state=\(self.state, privacy: .public) resume=\(self.wasPlaying, privacy: .public)")
        #endif
        isScrubbing = true; pause(); generation += 1; request?.cancel(); pendingCapture = nil
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
        #if DEBUG
        Logger(subsystem: "com.runweave.app.native", category: "ScreenRecording").debug("scrubEnd state=\(self.state, privacy: .public) resume=\(self.wasPlaying, privacy: .public)")
        #endif
        isScrubbing = false; scrubDispatch?.cancel(); scrubDispatch = nil
        resumeAfterLoad = wasPlaying
        state = wasPlaying ? "buffering" : "paused"
        seek(position, resume: wasPlaying)
    }
    func step(_ direction: Int) {
        guard let view, !view.captures.isEmpty else { return }
        pause(); let index = (pendingCapture ?? current).flatMap { c in view.captures.firstIndex { $0.id == c.id } } ?? 0
        let target = view.captures[max(0, min(view.captures.count - 1, index + direction))]
        seek(Double(target.capturedAtMs), resume: false, exact: target)
    }
    func select(_ capture: ScreenRecordingCapture) { pause(); seek(Double(capture.capturedAtMs), resume: false, exact: capture) }
    private func seek(_ value: Double, resume: Bool, scrubbing: Bool = false, exact: ScreenRecordingCapture? = nil) {
        guard let view, !closed, state != "unavailable" else { return }
        guard let confirmed = lastConfirmed, confirmed.duration(to: .now) <= .seconds(5) else {
            invalidate("连接暂时中断，正在重新连接…", recoverable: true); return
        }
        position = max(Double(view.range.startMs), min(Double(view.range.endMs), value))
        let ms = Int64(position)
        let gap = view.intervals.first { $0.kind != "privacy" && $0.kind != "unknown" && ms >= $0.startMs && ms < $0.endMs }
            ?? view.intervals.first { $0.kind == "unknown" && ms >= $0.startMs && ms < $0.endMs }
        if let gap, exact == nil {
            generation += 1; request?.cancel(); pendingCapture = nil; image = nil; current = nil
            message = gap.kind == "unknown" ? "此区间无采样" : "此区间暂停或不可记录"
            state = scrubbing ? "scrubbing" : resume ? "playing" : "paused"; return
        }
        guard let target = exact ?? view.captures.last(where: { $0.capturedAtMs <= ms }) else { return }
        if target.availableUntilMs <= screenRecordingNowMs() { invalidate("记录已过期"); return }
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
        // is ready, matching Mac playback. Privacy, gaps and invalidation clear it.
        pendingCapture = target
        state = scrubbing ? "scrubbing" : "buffering"; resumeAfterLoad = resume
        let presentationStart = ContinuousClock.now
        request = Task {
            do {
                let data = try await service.frame(viewID: view.viewID, captureID: target.id, variant: .full)
                guard !Task.isCancelled, !closed, generation == token else { return }
                guard let nextImage = UIImage(data: data) else { throw ScreenRecordingReadError("MEDIA_UNAVAILABLE") }
                image = nextImage; current = target; pendingCapture = nil; message = ""
                if resumeAfterLoad && !scrubbing { position = Double(target.capturedAtMs) }
                state = scrubbing ? "scrubbing" : resumeAfterLoad ? "playing" : "paused"; lastTick = .now
                #if DEBUG
                let elapsed = presentationStart.duration(to: .now).components
                let milliseconds = Int(elapsed.seconds * 1000 + elapsed.attoseconds / 1_000_000_000_000_000)
                Logger(subsystem: "com.runweave.app.native", category: "ScreenRecording").debug("imageAssignedMs=\(milliseconds, privacy: .public) bytes=\(data.count, privacy: .public)")
                #endif
            } catch {
                guard !Task.isCancelled, !closed, generation == token else { return }
                invalidate("本地录屏无法读取，请返回重新下载")
            }
        }
    }
    private func connectionFailure(_ error: Error) {
        if screenRecordingTransient(error) {
            if let confirmed = lastConfirmed, confirmed.duration(to: .now) <= .seconds(5) { return }
            invalidate("连接暂时中断，正在重新连接…", recoverable: true)
        } else { invalidate("记录暂不可用，请返回刷新") }
    }
    private func invalidate(_ reason: String, recoverable: Bool = false) {
        // Keep polling only for transport recovery. Expired/auth-invalid views stay closed.
        if state == "unavailable", recoveringConnection, recoverable { return }
        recoveringConnection = recoverable
        if !recoverable { validity?.cancel() }
        generation += 1; request?.cancel(); scrubDispatch?.cancel(); scrubDispatch = nil
        pendingCapture = nil
        pause(); image = nil; current = nil; state = "unavailable"; message = reason
        let previous = pendingInvalidation
        pendingInvalidation = Task { await previous?.value; await service.invalidate() }
    }
    func close() {
        closed = true; recoveringConnection = false; state = "unavailable"; generation += 1; request?.cancel(); pendingCapture = nil; clock?.cancel(); validity?.cancel(); scrubDispatch?.cancel(); image = nil; current = nil; lastConfirmed = nil
        let closingView = view; view = nil
        let previousClose = pendingClose
        let invalidation = pendingInvalidation
        pendingClose = Task {
            await invalidation?.value
            await service.invalidate()
            await previousClose?.value
            if let closingView { await service.close(viewID: closingView.viewID) }
            else { await service.invalidate() }
        }
    }
}
