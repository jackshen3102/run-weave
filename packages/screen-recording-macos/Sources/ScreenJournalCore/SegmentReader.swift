import AVFoundation
import ImageIO
import UniformTypeIdentifiers

struct SegmentReader {
    static func verify(_ url: URL, expected: Int, width: Int, height: Int) async throws {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw journalError("media_has_no_video") }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw journalError("media_decoder_unavailable") }
        reader.add(output)
        guard reader.startReading() else { throw journalError("media_decode_failed") }
        var count = 0
        while let sample = output.copyNextSampleBuffer() {
            guard let buffer = CMSampleBufferGetImageBuffer(sample), CVPixelBufferGetWidth(buffer) == width, CVPixelBufferGetHeight(buffer) == height,
                  abs(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) - Double(count)) < 0.001 else {
                reader.cancelReading(); throw journalError("media_frame_position_mismatch")
            }
            count += 1
        }
        guard reader.status == .completed, count == expected, count > 0 else {
            throw journalError("media_frame_count_mismatch: expected=\(expected), decoded=\(count)")
        }
    }
    static func image(_ url: URL, index: Int) async throws -> CGImage {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.requestedTimeToleranceBefore = .zero; generator.requestedTimeToleranceAfter = .zero
        let result = try await generator.image(at: CMTime(value: Int64(index), timescale: 1))
        guard abs(result.actualTime.seconds - Double(index)) < 0.001 else { throw journalError("extracted_frame_position_mismatch") }
        return result.image
    }
    static func png(_ image: CGImage) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { throw journalError("png_encoder_unavailable") }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw journalError("png_encode_failed") }
        return data as Data
    }
}
