import CoreGraphics
import Foundation

// These are capture signals, not a claim that the person stopped working.
enum CaptureActivity {
    static func crossesBreak(_ times: [Int64], after start: Int64, through end: Int64) -> Bool {
        guard end >= start else { return true }
        var low = 0, high = times.count
        while low < high {
            let middle = (low + high) / 2
            if times[middle] <= start { low = middle + 1 } else { high = middle }
        }
        return low < times.count && times[low] <= end
    }
    static func kind(privateFrame: Bool, idleSeconds: Double?, visualChanged: Bool?) -> String {
        if privateFrame { return "privacy" }
        return visualChanged == false && (idleSeconds ?? 0) >= 120 ? "quiet" : "active"
    }
    static func kind(_ capture: JournalCapture) -> String {
        kind(privateFrame: capture.privacyPlaceholder, idleSeconds: capture.idleSeconds, visualChanged: capture.visualChanged)
    }
    static func startsRange(_ next: JournalCapture, after previous: JournalCapture) -> Bool {
        next.sessionID != previous.sessionID || next.displayID != previous.displayID ||
        next.capturedAtMs < previous.capturedAtMs || next.capturedAtMs - previous.capturedAtMs > 120000 ||
        kind(next) != kind(previous)
    }
}

struct CaptureActivityDetector {
    private var reference: [UInt8]?
    private var previous: CaptureMetadata?
    mutating func changed(_ image: CGImage, metadata: CaptureMetadata) -> Bool? {
        defer { previous = metadata }
        guard !metadata.privacyPlaceholder else { reference = nil; return nil }
        // A small luminance grid ignores cursor/clock noise. Compare with the
        // last significant image, so gradual changes cannot disappear forever.
        let width = 64, height = 36
        var pixels = [UInt8](repeating: 0, count: width * height)
        let drawn = pixels.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            context.interpolationQuality = .low
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { reference = nil; return nil }
        let continuous = previous.map {
            $0.sessionID == metadata.sessionID && $0.displayID == metadata.displayID && !$0.privacyPlaceholder &&
            metadata.capturedAt >= $0.capturedAt && metadata.capturedAt.timeIntervalSince($0.capturedAt) <= 120
        } ?? false
        guard continuous, let old = reference else { reference = pixels; return true }
        let changedPixels = zip(old, pixels).filter { abs(Int($0.0) - Int($0.1)) >= 12 }.count
        let changed = changedPixels >= 12
        if changed { reference = pixels }
        return changed
    }
}
