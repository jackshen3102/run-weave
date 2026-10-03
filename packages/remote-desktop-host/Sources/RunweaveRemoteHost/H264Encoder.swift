// Adapted from Mirador@4cc5c0faddcf4ed87599fbd7cba96e5d9bd4285d.
// Copyright (c) 2026 Arnab Saha. MIT; see ThirdPartyLicenses/Mirador-MIT.txt.
import Foundation
import CoreMedia
import CoreVideo
#if canImport(VideoToolbox)
import VideoToolbox
#endif

/// Hardware H.264 for the native client. No B-frames; IDR access units include SPS/PPS.
/// Pending buffers are bounded by two reservations. Session submission/invalidation use
/// one serial queue; reservation counters and keyframe requests use `lock`.
public final class H264Encoder: @unchecked Sendable {
    public struct Configuration: Sendable {
        public var width: Int
        public var height: Int
        public var fps: Int
        public var bitrate: Int
        /// Quality floor: the encoder may not exceed this H.264 quantizer (1–51, lower = sharper),
        /// so text stays legible during motion instead of the rate controller softening it. 0 = unset.
        public var maxFrameQP: Int
        public init(width: Int, height: Int, fps: Int = 30, bitrate: Int = 8_000_000, maxFrameQP: Int = 0) {
            self.width = width
            self.height = height
            self.fps = fps
            self.bitrate = bitrate
            self.maxFrameQP = maxFrameQP
        }
    }

    private let onAccessUnit: (Data, Bool, Double) -> Void
    private let lock = NSLock()
    private let encoderQueue = DispatchQueue(label: "runweave.remote.encoder")
    private let onFailure: (OSStatus) -> Void
    private var maximumInFlight = 0
    private var skippedFrames: UInt64 = 0
    private var forceKeyframe = false
    private var frameIndex: Int64 = 0
    private var inFlight = 0
    public private(set) var hardwareAccelerated = false
    private let timescale: Int32

    #if canImport(VideoToolbox)
    private var session: VTCompressionSession?
    #endif

    /// Returns nil when a hardware VideoToolbox session cannot be created.
    public init?(configuration: Configuration, onAccessUnit: @escaping (Data, Bool, Double) -> Void, onFailure: @escaping (OSStatus) -> Void = { _ in }) {
        self.onAccessUnit = onAccessUnit
        self.onFailure = onFailure
        self.timescale = Int32(max(1, configuration.fps))

        #if canImport(VideoToolbox)
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(configuration.width),
            height: Int32(configuration.height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true] as CFDictionary,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &created
        )
        guard status == noErr, let session = created else { return nil }
        self.session = session

        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        // H.264 High profile is decoded by the native AVSampleBufferDisplayLayer path.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: configuration.bitrate))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: configuration.fps))
        // Bound the keyframe interval so a viewer that joins mid-GOP recovers within ~2s
        // even if an explicit keyframe request is missed.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: configuration.fps * 2))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: NSNumber(value: 2))
        // Quality floor for legible text during motion (macOS 13+; harmless no-op if unsupported).
        if configuration.maxFrameQP > 0 {
            VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxAllowedFrameQP, value: NSNumber(value: configuration.maxFrameQP))
        }
        VTCompressionSessionPrepareToEncodeFrames(session)
        var hardware: CFTypeRef?
        withUnsafeMutablePointer(to: &hardware) { pointer in
            VTSessionCopyProperty(session, key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder, allocator: kCFAllocatorDefault, valueOut: pointer)
        }
        self.hardwareAccelerated = (hardware as? NSNumber)?.boolValue ?? false
        #else
        return nil
        #endif
    }

    /// Request that the next encoded frame be an IDR keyframe (e.g. when a new viewer
    /// connects while capture is already running).
    public func requestKeyframe() {
        lock.lock()
        forceKeyframe = true
        lock.unlock()
    }

    /// Reserve before queueing so capture cannot retain an unbounded pixel-buffer queue.
    public func encode(_ pixelBuffer: CVPixelBuffer) {
        #if canImport(VideoToolbox)
        lock.lock()
        guard inFlight < 2 else { skippedFrames += 1; lock.unlock(); return }
        inFlight += 1; maximumInFlight = max(maximumInFlight, inFlight)
        let force = forceKeyframe; forceKeyframe = false
        let pts = CMTime(value: frameIndex, timescale: timescale); frameIndex += 1
        lock.unlock()
        let ticket = EncoderTicket()
        @Sendable func releaseReservation() {
            guard ticket.complete() else { return }
            self.lock.lock(); self.inFlight -= 1; self.lock.unlock()
        }
        encoderQueue.async { [weak self] in
            guard let self else { return }
            guard let session = self.session else { releaseReservation(); return }
            let properties = force ? [kVTEncodeFrameOptionKey_ForceKeyFrame as String: true] as CFDictionary : nil
            let start = DispatchTime.now()
            let submitted = VTCompressionSessionEncodeFrame(session, imageBuffer: pixelBuffer, presentationTimeStamp: pts,
                                                             duration: .invalid, frameProperties: properties, infoFlagsOut: nil) { [weak self] status, _, sampleBuffer in
                releaseReservation()
                guard let self else { return }
                guard status == noErr, let sampleBuffer else { self.onFailure(status); return }
                let milliseconds = Double(DispatchTime.now().uptimeNanoseconds &- start.uptimeNanoseconds) / 1_000_000
                self.handleEncoded(sampleBuffer, encodeMillis: milliseconds)
            }
            if submitted != noErr { releaseReservation(); self.requestKeyframe(); self.onFailure(submitted) }
        }
        #endif
    }

    public func stats() -> (current: Int, maximum: Int, skipped: UInt64) {
        lock.lock(); defer { lock.unlock() }; return (inFlight, maximumInFlight, skippedFrames)
    }

    public func invalidate() {
        #if canImport(VideoToolbox)
        encoderQueue.sync {
            guard let session = self.session else { return }
            self.session = nil
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
        }
        #endif
    }

    #if canImport(VideoToolbox)
    private func handleEncoded(_ sampleBuffer: CMSampleBuffer, encodeMillis: Double) {
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        let isKeyframe = Self.isKeyframe(sampleBuffer)

        var annexB = Data()
        if isKeyframe, let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
            annexB.append(Self.parameterSetsAnnexB(format))
        }

        var lengthAtOffset = 0
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(dataBuffer, atOffset: 0, lengthAtOffsetOut: &lengthAtOffset, totalLengthOut: &totalLength, dataPointerOut: &dataPointer) == kCMBlockBufferNoErr,
              let dataPointer else { return }

        // VideoToolbox emits AVCC: each NAL unit prefixed by a 4-byte big-endian length.
        // Rewrite to Annex-B (00 00 00 01); the native decoder rebuilds AVCC.
        let startCode: [UInt8] = [0x00, 0x00, 0x00, 0x01]
        var offset = 0
        while offset + 4 <= totalLength {
            var naluLength: UInt32 = 0
            memcpy(&naluLength, dataPointer + offset, 4)
            naluLength = CFSwapInt32BigToHost(naluLength)
            let nalStart = offset + 4
            guard naluLength > 0, nalStart + Int(naluLength) <= totalLength else { break }
            annexB.append(contentsOf: startCode)
            dataPointer.withMemoryRebound(to: UInt8.self, capacity: totalLength) { base in
                annexB.append(base + nalStart, count: Int(naluLength))
            }
            offset = nalStart + Int(naluLength)
        }

        guard !annexB.isEmpty else { return }
        onAccessUnit(annexB, isKeyframe, encodeMillis)
    }

    private static func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]],
              let first = attachments.first else {
            return true // no attachments: treat as sync sample
        }
        if let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool {
            return !notSync
        }
        return true
    }

    private static func parameterSetsAnnexB(_ format: CMFormatDescription) -> Data {
        var data = Data()
        let startCode: [UInt8] = [0x00, 0x00, 0x00, 0x01]
        var count = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil) == noErr else {
            return data
        }
        for index in 0..<count {
            var pointer: UnsafePointer<UInt8>?
            var size = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr,
               let pointer {
                data.append(contentsOf: startCode)
                data.append(pointer, count: size)
            }
        }
        return data
    }
    #endif
}

private final class EncoderTicket: @unchecked Sendable {
    private let lock = NSLock()
    private var completed = false
    func complete() -> Bool { lock.lock(); defer { lock.unlock() }; guard !completed else { return false }; completed = true; return true }
}
