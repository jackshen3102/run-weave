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

    func start(display geometry: RemoteDisplay, videoFeedback: Bool = false, canSubmit: @escaping () -> Bool = { true }, onFrame: @escaping (Data, Bool, Double, @escaping () -> Void) -> Void, onFailure: @escaping (Error) -> Void) async throws {
        guard stream == nil else { return }
        guard CGPreflightScreenCaptureAccess() else { throw HostError.screenPermission }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == geometry.displayID }) else { throw HostError.noDisplay }
        guard let encoder = H264Encoder(configuration: .init(width: geometry.pixelWidth, height: geometry.pixelHeight, fps: geometry.fps, bitrate: VideoSender.initialBitrate(maximum: geometry.bitrate, feedbackEnabled: videoFeedback), maximumInFlight: videoFeedback ? RemoteVideoPacket.maximumInFlight : 1), onAccessUnit: onFrame, onFailure: { _ in onFailure(HostError.encoderUnavailable) }),
              encoder.hardwareAccelerated else { throw HostError.encoderUnavailable }
        let configuration = SCStreamConfiguration()
        configuration.width = geometry.pixelWidth; configuration.height = geometry.pixelHeight
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(geometry.fps))
        configuration.queueDepth = 3; configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.capturesAudio = false; configuration.showsCursor = true
        let output = CaptureOutput(encoder: encoder, canSubmit: canSubmit, onFailure: onFailure)
        let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: configuration, delegate: output)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "runweave.remote.capture", qos: .userInteractive))
        self.stream = stream; self.output = output; self.encoder = encoder
        self.hardwareAccelerated = encoder.hardwareAccelerated
        if videoFeedback { encoder.setBitrate(VideoSender.initialBitrate(maximum: geometry.bitrate, feedbackEnabled: true)) }
        do { try await stream.startCapture() }
        catch { await stop(); throw error }
        encoder.requestKeyframe()
    }
    func requestKeyframe() { encoder?.requestKeyframe() }
    func setBitrate(_ bitrate: Int) { encoder?.setBitrate(bitrate) }
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
    let canSubmit: () -> Bool
    init(encoder: H264Encoder, canSubmit: @escaping () -> Bool, onFailure: @escaping (Error) -> Void) { self.encoder = encoder; self.canSubmit = canSubmit; self.onFailure = onFailure }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue,
              let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        encoder.encode(pixels, canSubmit: canSubmit)
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { onFailure(error) }
}
