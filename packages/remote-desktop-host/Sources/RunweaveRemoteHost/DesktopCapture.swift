// ScreenCaptureKit setup adapted from Mirador@4cc5c0faddcf4ed87599fbd7cba96e5d9bd4285d.
// Copyright (c) 2026 Arnab Saha. MIT; see ThirdPartyLicenses/Mirador-MIT.txt.
import Foundation
import CoreGraphics
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import RunweaveRemoteDesktopProtocol

@MainActor
final class DesktopCapture {
    private var stream: SCStream?
    private var output: CaptureOutput?
    private var encoder: H264Encoder?
    private(set) var hardwareAccelerated = false

    static func geometry(displayID: UInt32, revision: UInt64) throws -> RemoteDisplay {
        guard CGDisplayIsActive(displayID) != 0 else { throw HostError.noDisplay }
        let bounds = CGDisplayBounds(displayID)
        let scale = min(1, min(1920 / bounds.width, 1080 / bounds.height))
        let width = max(2, Int(bounds.width * scale) / 2 * 2)
        let height = max(2, Int(bounds.height * scale) / 2 * 2)
        return RemoteDisplay(displayID: displayID, revision: revision,
                             logicalBounds: .init(x: bounds.minX, y: bounds.minY, width: bounds.width, height: bounds.height),
                             pixelWidth: width, pixelHeight: height,
                             contentRect: .init(width: Double(width), height: Double(height)))
    }

    func start(display geometry: RemoteDisplay, onFrame: @escaping (Data, Bool, Double) -> Void, onFailure: @escaping (Error) -> Void) async throws {
        guard stream == nil else { return }
        guard CGPreflightScreenCaptureAccess() else { throw HostError.screenPermission }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == geometry.displayID }) else { throw HostError.noDisplay }
        guard let encoder = H264Encoder(configuration: .init(width: geometry.pixelWidth, height: geometry.pixelHeight, fps: geometry.fps, bitrate: geometry.bitrate), onAccessUnit: onFrame, onFailure: { _ in onFailure(HostError.encoderUnavailable) }),
              encoder.hardwareAccelerated else { throw HostError.encoderUnavailable }
        let configuration = SCStreamConfiguration()
        configuration.width = geometry.pixelWidth; configuration.height = geometry.pixelHeight
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(geometry.fps))
        configuration.queueDepth = 3; configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.capturesAudio = false; configuration.showsCursor = true
        let output = CaptureOutput(encoder: encoder, onFailure: onFailure)
        let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: configuration, delegate: output)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "runweave.remote.capture", qos: .userInteractive))
        self.stream = stream; self.output = output; self.encoder = encoder
        self.hardwareAccelerated = encoder.hardwareAccelerated
        do { try await stream.startCapture() }
        catch { await stop(); throw error }
        encoder.requestKeyframe()
    }
    func requestKeyframe() { encoder?.requestKeyframe() }
    func stats() -> (current: Int, maximum: Int, skipped: UInt64) { encoder?.stats() ?? (0, 0, 0) }
    func stop() async {
        let oldStream = stream; stream = nil; output = nil
        if let oldStream { try? await oldStream.stopCapture() }
        encoder?.invalidate(); encoder = nil; hardwareAccelerated = false
    }
}

private final class CaptureOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    let encoder: H264Encoder
    let onFailure: (Error) -> Void
    init(encoder: H264Encoder, onFailure: @escaping (Error) -> Void) { self.encoder = encoder; self.onFailure = onFailure }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue,
              let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        encoder.encode(pixels)
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { onFailure(error) }
}

/// At most one access unit enters Network.framework at a time. Dropping any dependent frame
/// invalidates the chain: discard until an IDR and request one, rather than sending broken P frames.
final class VideoSender: @unchecked Sendable {
    private let lock = NSLock()
    private let channel: RemoteTLSConnection
    private let sessionID: UUID
    private let display: RemoteDisplay
    private let requestKeyframe: () -> Void
    private let onFailure: (Error) -> Void
    private var busy = false
    private var stopped = false
    private var waitingForKeyframe = true
    private var sequence: UInt64 = 0
    private var frames: UInt64 = 0
    private var dropped: UInt64 = 0
    private var encodeMilliseconds = 0.0
    private var encodeSamples: [Double] = []
    private var maximumSendDepth = 0
    init(channel: RemoteTLSConnection, sessionID: UUID, display: RemoteDisplay, requestKeyframe: @escaping () -> Void, onFailure: @escaping (Error) -> Void) {
        self.channel = channel; self.sessionID = sessionID; self.display = display
        self.requestKeyframe = requestKeyframe; self.onFailure = onFailure
    }
    func offer(_ data: Data, keyframe: Bool, milliseconds: Double) {
        lock.lock()
        guard !stopped else { lock.unlock(); return }
        sequence += 1
        if milliseconds.isFinite, milliseconds >= 0 {
            encodeSamples.append(milliseconds)
            if encodeSamples.count > 256 { encodeSamples.removeFirst() }
        }
        if busy || (waitingForKeyframe && !keyframe) {
            dropped += 1; waitingForKeyframe = true; lock.unlock(); requestKeyframe(); return
        }
        busy = true; waitingForKeyframe = false; encodeMilliseconds = milliseconds
        maximumSendDepth = max(maximumSendDepth, 1)
        let header = RemoteVideoHeader(sessionID: sessionID, displayID: display.displayID, displayRevision: display.revision, sequence: sequence, keyframe: keyframe, encodeMilliseconds: milliseconds)
        lock.unlock()
        Task {
            let timeout = Task { try await Task.sleep(nanoseconds: 2_000_000_000); self.channel.close() }
            do {
                try await channel.sendData(RemoteVideoPacket(header: header, annexB: data).encoded())
                finishSend(); timeout.cancel()
            } catch { timeout.cancel(); stop(); onFailure(error) }
        }
    }
    private func finishSend() { lock.lock(); busy = false; frames += 1; lock.unlock() }
    func stop() { lock.lock(); stopped = true; lock.unlock() }
    func stats() -> (frames: UInt64, dropped: UInt64, last: Double, samples: Int, p50: Double, p95: Double, maximumSendDepth: Int) {
        lock.lock(); defer { lock.unlock() }
        let sorted = encodeSamples.sorted()
        func percentile(_ value: Double) -> Double { sorted.isEmpty ? 0 : sorted[Int(Double(sorted.count - 1) * value)] }
        return (frames, dropped, encodeMilliseconds, sorted.count, percentile(0.5), percentile(0.95), maximumSendDepth)
    }
}
