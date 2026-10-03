import Foundation
import CoreGraphics
@_exported import RunweaveRemoteDesktopProtocol

public struct RemoteSessionContext: Equatable, Sendable {
    public let targetID: UUID
    public let generation: UInt64
    public let presentationID: UUID

    public init(targetID: UUID, generation: UInt64, presentationID: UUID) {
        self.targetID = targetID; self.generation = generation; self.presentationID = presentationID
    }
}

public enum RemoteDesktopState: Equatable {
    case idle, connecting, waitingForAuthorization, waitingForFirstFrame
    case controllable, readOnly, disconnected(String), permissionDenied(String), failed(String)

    public var label: String {
        switch self {
        case .idle: return "桌面已停止"
        case .connecting: return "正在连接 Mac"
        case .waitingForAuthorization: return "等待 Mac 本地授权"
        case .waitingForFirstFrame: return "等待桌面首帧"
        case .controllable: return "可以控制"
        case .readOnly: return "只读"
        case .disconnected(let reason): return "连接已断开 · \(reason)"
        case .permissionDenied(let reason), .failed(let reason): return reason
        }
    }
}

public struct RemoteDesktopStatistics: Equatable {
    public internal(set) var receivedFrames: UInt64 = 0
    public internal(set) var decodedFrames: UInt64 = 0
    public internal(set) var submittedFrames: UInt64 = 0
    public internal(set) var droppedFrames: UInt64 = 0
    public internal(set) var recoveryRequests: UInt64 = 0
    public let decoderQueueCapacity: Int = 3
    public internal(set) var decoderQueueDepth: Int = 0
    public internal(set) var maximumDecoderQueueDepth: Int = 0
    public internal(set) var decodeMilliseconds: Double = 0
    public internal(set) var networkRoundTripMilliseconds: Double = 0
    public internal(set) var hardwareDecoder: Bool?
    public internal(set) var displayStatus = "unknown"
    public internal(set) var displayRenderer = "unknown"
    public internal(set) var displayAcceptsMediaData = false
    public internal(set) var displayIngressState = "等待视频"
    public internal(set) var displayStallRecoveries: UInt64 = 0
    public internal(set) var displayReady: Bool?
    public internal(set) var displayFailures: UInt64 = 0
    public internal(set) var displayErrorDomain: String?
    public internal(set) var displayErrorCode: Int?
    public internal(set) var displayRequiresFlush = false
    public internal(set) var surfaceInWindow = false
    public internal(set) var viewportSize: CGSize = .zero
    public internal(set) var videoLayerSize: CGSize = .zero
    public internal(set) var preventsCapture = true
    public internal(set) var outputObscured = false
    public internal(set) var decodedPixelFormat: UInt32?
    public internal(set) var decodedHasIOSurface: Bool?
    public internal(set) var decodedLuminance: RemoteLuminanceSummary?
    public internal(set) var decodeTiming = RemoteTimingSummary()
    public internal(set) var networkTiming = RemoteTimingSummary()
    public init() {}
}

/// Only aggregate 8-bit Y values from a fixed 16×16 grid in a 420v image.
/// No image or individual sample values are retained.
public struct RemoteLuminanceSummary: Equatable, Sendable {
    public let minimum: UInt8
    public let mean: Double
    public let maximum: UInt8
}

/// Percentiles are for the most recent 256 local timing samples. They do not
/// measure input-to-visible-pixel latency or compare clocks across devices.
public struct RemoteTimingSummary: Equatable {
    public internal(set) var totalSamples: UInt64 = 0
    public internal(set) var windowSamples: Int = 0
    public internal(set) var p50Milliseconds: Double = 0
    public internal(set) var p95Milliseconds: Double = 0
    public init() {}
    init(samples: [Double], total: UInt64) {
        let sorted = samples.sorted()
        totalSamples = total; windowSamples = sorted.count
        if !sorted.isEmpty {
            p50Milliseconds = sorted[Int(Double(sorted.count - 1) * 0.5)]
            p95Milliseconds = sorted[Int(Double(sorted.count - 1) * 0.95)]
        }
    }
}

public enum RemoteInputMode: String, CaseIterable, Identifiable {
    case trackpad, direct
    public var id: String { rawValue }
    public var label: String { self == .trackpad ? "触控板" : "直接点击" }
}

/// Mac virtual key codes. Text submission is deliberately a separate operation.
public enum RemoteKey: UInt16, CaseIterable {
    case enter = 36, tab = 48, space = 49, backspace = 51, escape = 53
    case command = 55, shift = 56, option = 58, control = 59
    case left = 123, right = 124, down = 125, up = 126
    public var label: String {
        switch self {
        case .enter: return "↵"
        case .tab: return "Tab"
        case .space: return "空格"
        case .backspace: return "⌫"
        case .escape: return "Esc"
        case .command: return "⌘"
        case .shift: return "⇧"
        case .option: return "⌥"
        case .control: return "⌃"
        case .left: return "←"
        case .right: return "→"
        case .down: return "↓"
        case .up: return "↑"
        }
    }
}

public struct RemoteModifiers: OptionSet, Equatable, Sendable {
    public let rawValue: UInt32
    public init(rawValue: UInt32) { self.rawValue = rawValue }
    public static let shift = Self(rawValue: 1 << 0)
    public static let control = Self(rawValue: 1 << 1)
    public static let option = Self(rawValue: 1 << 2)
    public static let command = Self(rawValue: 1 << 3)
}

/// Encoded content and logical display coordinates are explicit and revision bound.
public struct RemoteDisplayGeometry: Equatable {
    public let displayID: UInt32
    public let revision: UInt64
    public let logicalBounds: CGRect
    public let pixelSize: CGSize
    public let contentRect: CGRect

    public init(displayID: UInt32, revision: UInt64, logicalBounds: CGRect, pixelSize: CGSize, contentRect: CGRect) {
        self.displayID = displayID; self.revision = revision; self.logicalBounds = logicalBounds
        self.pixelSize = pixelSize; self.contentRect = contentRect
    }

    public var isValid: Bool {
        logicalBounds.width > 0 && logicalBounds.height > 0 && pixelSize.width > 0 && pixelSize.height > 0 &&
        contentRect.width > 0 && contentRect.height > 0 && contentRect.minX >= 0 && contentRect.minY >= 0 &&
        contentRect.maxX <= pixelSize.width && contentRect.maxY <= pixelSize.height &&
        [logicalBounds.origin.x, logicalBounds.origin.y, logicalBounds.width, logicalBounds.height,
         pixelSize.width, pixelSize.height, contentRect.minX, contentRect.minY,
         contentRect.width, contentRect.height].allSatisfy(\.isFinite)
    }
}
