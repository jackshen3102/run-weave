// Encoding parameters and pixel-buffer approach adapted from Dayflow FrameStore.swift
// 730d6f84b919998158ff7fdab15e3f032f7d8135. Copyright (c) 2025 Jerry Liu, MIT.
import AVFoundation
import CoreGraphics
import CoreImage

final class SegmentWriter {
    let id: String
    let url: URL
    let width: Int
    let height: Int
    let displayID: UInt32
    let started = ContinuousClock.now
    private(set) var count = 0
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    // Reuse the renderer, but never retain an intermediate image per screenshot.
    private let renderer = CIContext(options: [.cacheIntermediates: false])
    init(id: String, url: URL, width: Int, height: Int, displayID: UInt32) throws {
        self.id = id; self.url = url; self.width = width; self.height = height; self.displayID = displayID
        var configured: (AVAssetWriter, AVAssetWriterInput, AVAssetWriterInputPixelBufferAdaptor)?
        for control: [String: Any] in [[AVVideoQualityKey: 0.55], [AVVideoAverageBitRateKey: max(500_000, Int(2_000_000.0 * Double(width * height) / Double(1920 * 1080)))]] {
            let candidate = try AVAssetWriter(outputURL: url, fileType: .mp4)
            var compression = control
            compression[AVVideoMaxKeyFrameIntervalKey] = 30
            compression[AVVideoAllowFrameReorderingKey] = false
            compression[AVVideoExpectedSourceFrameRateKey] = 1
            let settings: [String: Any] = [AVVideoCodecKey: AVVideoCodecType.hevc, AVVideoWidthKey: width,
                AVVideoHeightKey: height, AVVideoCompressionPropertiesKey: compression]
            let track = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
            track.expectsMediaDataInRealTime = true
            let buffer = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: track, sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height])
            if candidate.canApply(outputSettings: settings, forMediaType: .video), candidate.canAdd(track) {
                candidate.add(track)
                if candidate.startWriting() { candidate.startSession(atSourceTime: .zero); configured = (candidate, track, buffer); break }
            }
            candidate.cancelWriting()
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        }
        guard let configured else { throw journalError("hevc_encoder_unavailable") }
        (writer, input, adaptor) = configured
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    func append(_ image: CGImage) throws -> Int? {
        guard writer.status == .writing else { throw journalError("encoder_failed: \(writer.error?.localizedDescription ?? "unknown")") }
        guard input.isReadyForMoreMediaData else { return nil }
        guard let pool = adaptor.pixelBufferPool else { throw journalError("pixel_buffer_pool_unavailable") }
        var pixelBuffer: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBuffer) == kCVReturnSuccess, let pixelBuffer else { throw journalError("pixel_buffer_allocation_failed") }
        renderer.render(CIImage(cgImage: image), to: pixelBuffer,
            bounds: CGRect(x: 0, y: 0, width: width, height: height), colorSpace: CGColorSpaceCreateDeviceRGB())
        guard adaptor.append(pixelBuffer, withPresentationTime: CMTime(value: Int64(count), timescale: 1)) else {
            throw journalError("encoder_append_failed: \(writer.error?.localizedDescription ?? "unknown")")
        }
        let index = count; count += 1; return index
    }
    func finish() async throws {
        if count == 0 { writer.cancelWriting(); return }
        writer.endSession(atSourceTime: CMTime(value: Int64(count), timescale: 1))
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { throw journalError("encoder_finalize_failed: \(writer.error?.localizedDescription ?? "unknown")") }
    }
}
