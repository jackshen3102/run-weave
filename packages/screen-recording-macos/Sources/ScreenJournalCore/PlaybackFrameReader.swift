import AVFoundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers

// One instance per decoder slot. Its actor is never the storage or UI actor.
actor PlaybackFrameReader {
    private var reader: AVAssetReader?
    private var output: AVAssetReaderTrackOutput?
    private var source: URL?
    private var nextIndex = 0
    private let context = CIContext(options: [.cacheIntermediates: false])
    func reset() { reader?.cancelReading(); reader = nil; output = nil; source = nil }
    func jpegBatch(_ permits: [JournalFramePermit], variant: JournalVariant) async throws -> [String: Data] {
        defer { reset() }
        var result: [String: Data] = [:]
        for permit in permits {
            result[permit.frame.capture.id] = try await jpeg(permit, variant: variant)
        }
        return result
    }
    private func jpeg(_ permit: JournalFramePermit, variant: JournalVariant) async throws -> Data {
        try permit.lease.check()
        let index = permit.frame.frameIndex
        if source != permit.url || index < nextIndex || index - nextIndex > 30 || reader?.status != .reading {
            reset()
            let asset = AVURLAsset(url: permit.url)
            guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw JournalReadError("MEDIA_UNAVAILABLE") }
            let next = try AVAssetReader(asset: asset)
            let trackOutput = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
            trackOutput.alwaysCopiesSampleData = false
            guard next.canAdd(trackOutput) else { throw JournalReadError("MEDIA_UNAVAILABLE") }
            next.add(trackOutput)
            next.timeRange = CMTimeRange(start: CMTime(value: Int64(index), timescale: 1), duration: .positiveInfinity)
            guard next.startReading() else { throw JournalReadError("MEDIA_UNAVAILABLE") }
            reader = next; output = trackOutput; source = permit.url; nextIndex = index
        }
        guard let reader, let output else { throw JournalReadError("MEDIA_UNAVAILABLE") }
        permit.lease.onCancel { reader.cancelReading() }
        #if DEBUG
        // An explicit isolated-directory gate verifies that cancellation alone
        // never releases an actual reader's file lease. Bounded even if a probe exits.
        if let gate = permit.validationGate, FileManager.default.fileExists(atPath: gate.path) {
            let entered = gate.deletingLastPathComponent().appendingPathComponent("held-read.json")
            let marker: [String: Any] = ["segmentID": permit.frame.segmentID, "leaseID": permit.lease.id.uuidString, "enteredAtMs": journalNowMs()]
            try JSONSerialization.data(withJSONObject: marker).write(to: entered, options: .atomic)
            let deadline = ContinuousClock.now.advanced(by: .seconds(30))
            while FileManager.default.fileExists(atPath: gate.path), ContinuousClock.now < deadline {
                // Deliberately ignore cancellation until the controlled reader exits.
                await withCheckedContinuation { continuation in
                    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.02) { continuation.resume() }
                }
            }
            try? FileManager.default.removeItem(at: entered)
        }
        #endif
        while let sample = output.copyNextSampleBuffer() {
            try permit.lease.check()
            let position = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            nextIndex = Int(position.rounded()) + 1
            if position < Double(index) - 0.001 { continue }
            guard abs(position - Double(index)) < 0.001, let buffer = CMSampleBufferGetImageBuffer(sample) else { throw JournalReadError("MEDIA_UNAVAILABLE") }
            var image = CIImage(cvPixelBuffer: buffer)
            if let height = variant.height, image.extent.height > CGFloat(height) {
                let scale = CGFloat(height) / image.extent.height; image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            }
            guard let cg = context.createCGImage(image, from: image.extent) else { throw JournalReadError("MEDIA_UNAVAILABLE") }
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { throw JournalReadError("MEDIA_UNAVAILABLE") }
            CGImageDestinationAddImage(destination, cg, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
            guard CGImageDestinationFinalize(destination), data.length <= 8 * 1024 * 1024 else { throw JournalReadError("MEDIA_UNAVAILABLE") }
            try permit.lease.check()
            return data as Data
        }
        throw JournalReadError("MEDIA_UNAVAILABLE")
    }
}
