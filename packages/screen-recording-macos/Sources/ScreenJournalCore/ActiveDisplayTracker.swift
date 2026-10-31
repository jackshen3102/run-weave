// Mouse-following with debounce, based on Dayflow ActiveDisplayTracker.swift at
// 730d6f84b919998158ff7fdab15e3f032f7d8135. Copyright (c) 2025 Jerry Liu, MIT.
import CoreGraphics
import Foundation

@MainActor final class ActiveDisplayTracker {
    private var candidate: CGDirectDisplayID?
    private var candidateSince = ContinuousClock.now
    private(set) var selected: CGDirectDisplayID?
    func poll() {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { selected = nil; return }
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &displays, &count) == .success,
              let point = CGEvent(source: nil)?.location else { selected = nil; return }
        let target = displays.first { CGDisplayBounds($0).contains(point) }
        if let selected, !displays.contains(selected) { self.selected = nil }
        if candidate != target { candidate = target; candidateSince = .now }
        if candidateSince.duration(to: .now) >= .milliseconds(500) { selected = candidate }
    }
}
