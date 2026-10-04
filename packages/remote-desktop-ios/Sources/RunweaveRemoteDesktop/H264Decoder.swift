// Annex-B / CoreMedia construction adapted from Mirador H264Decoder.swift,
// 4cc5c0faddcf4ed87599fbd7cba96e5d9bd4285d, Copyright (c) 2026 Arnab Saha.
// MIT license: ThirdParty/Mirador-LICENSE.txt.
import Foundation
import CoreMedia
import CoreVideo
import VideoToolbox

/// One decoder per connection generation. Pending work includes delivery to the UI.
/// Losing a compressed frame invalidates the dependency chain until an SPS/PPS IDR.
final class H264Decoder {
    enum RecoveryReason { case backlog, decodeFailure }
    struct Output {
        let sample: CMSampleBuffer
        let size: CGSize
        let hardwareAccelerated: Bool?
        let decodeMilliseconds: Double
        let luminance: RemoteLuminanceSummary?
        let isCurrent: () -> Bool
    }

    private let queue = DispatchQueue(label: "app.runweave.remote-desktop.decode", qos: .userInteractive)
    private let lock = NSLock()
    private var epoch: UInt64 = 0
    private var pending = 0
    private var stopped = false
    private var overflowRecoveryPending = false
    private var resetScheduled = false
    private var needsIDR = true
    private var format: CMVideoFormatDescription?
    private var decompressor: VTDecompressionSession?
    private var hardware: Bool?
    private var lastLuminanceSampleTime: TimeInterval = 0
    private let output: (Output, @escaping () -> Void) -> Void
    private let recovery: (RecoveryReason) -> Void

    init(output: @escaping (Output, @escaping () -> Void) -> Void, recovery: @escaping (RecoveryReason) -> Void) {
        self.output = output
        self.recovery = recovery
    }

    var queueDepth: Int { lock.lock(); defer { lock.unlock() }; return pending }

    @discardableResult
    func submit(annexB: Data, isKeyframe: Bool) -> Bool {
        lock.lock()
        guard !stopped, pending < 3 else {
            let recover = !stopped && !overflowRecoveryPending
            if recover { overflowRecoveryPending = true }
            lock.unlock()
            if recover { reset(); recovery(.backlog) }
            return false
        }
        pending += 1
        let capturedEpoch = epoch
        lock.unlock()
        queue.async { [weak self] in
            guard let self else { return }
            guard self.isCurrent(capturedEpoch) else { self.complete(); return }
            self.decode(annexB, keyframe: isKeyframe, epoch: capturedEpoch)
        }
        return true
    }

    func reset() {
        lock.lock()
        epoch &+= 1
        let schedule = !resetScheduled
        resetScheduled = true
        lock.unlock()
        guard schedule else { return }
        queue.async { [weak self] in
            guard let self else { return }
            self.invalidateDecoder()
            self.lock.lock(); self.resetScheduled = false; self.lock.unlock()
        }
    }

    func stop() {
        lock.lock()
        guard !stopped else { lock.unlock(); return }
        stopped = true; epoch &+= 1
        lock.unlock()
        queue.async { [weak self] in self?.invalidateDecoder() }
    }

    deinit { if let decompressor { VTDecompressionSessionInvalidate(decompressor) } }

    private func isCurrent(_ expected: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !stopped && expected == epoch
    }

    private func complete() {
        lock.lock()
        pending = max(0, pending - 1)
        if pending == 0 { overflowRecoveryPending = false }
        lock.unlock()
    }

    private func invalidateDecoder() {
        if let decompressor { VTDecompressionSessionInvalidate(decompressor) }
        decompressor = nil; format = nil; needsIDR = true
    }

    private func decode(_ data: Data, keyframe: Bool, epoch: UInt64) {
        let nals = Self.splitAnnexB(data)
        let hasIDR = nals.contains { $0.first.map { $0 & 0x1f == 5 } ?? false }
        guard !needsIDR || (keyframe && hasIDR) else { complete(); return }
        if keyframe, hasIDR,
           let sps = nals.first(where: { $0.first.map { $0 & 0x1f == 7 } ?? false }),
           let pps = nals.first(where: { $0.first.map { $0 & 0x1f == 8 } ?? false }),
           let newFormat = Self.makeFormat(sps: sps, pps: pps) {
            let dimensions = CMVideoFormatDescriptionGetDimensions(newFormat)
            guard dimensions.width > 0, dimensions.height > 0,
                  dimensions.width <= 8192, dimensions.height <= 8192 else {
                complete(); invalidateDecoder(); recovery(.decodeFailure); return
            }
            if format == nil || !CMFormatDescriptionEqual(format, otherFormatDescription: newFormat) {
                invalidateDecoder()
                format = newFormat
            }
            if decompressor == nil { createDecoder(newFormat) }
            needsIDR = decompressor == nil
        }
        guard !needsIDR, let format, let decompressor else { complete(); recovery(.decodeFailure); return }
        let payload = nals.filter {
            let type = $0.first.map { $0 & 0x1f } ?? 0
            return type != 7 && type != 8 && type != 9
        }
        var avcc = Data()
        for nal in payload {
            var length = UInt32(nal.count).bigEndian
            withUnsafeBytes(of: &length) { avcc.append(contentsOf: $0) }
            avcc.append(nal)
        }
        guard !avcc.isEmpty, let sample = Self.makeCompressedSample(avcc: avcc, format: format) else {
            complete(); invalidateDecoder(); recovery(.decodeFailure); return
        }
        let start = ProcessInfo.processInfo.systemUptime
        let status = VTDecompressionSessionDecodeFrame(
            decompressor, sampleBuffer: sample, flags: [], infoFlagsOut: nil
        ) { [weak self] status, _, image, presentationTime, _ in
            guard let self else { return }
            guard status == noErr, let image, self.isCurrent(epoch),
                  let rendered = Self.makeImageSample(image, time: presentationTime) else {
                self.complete()
                if status != noErr { self.reset(); self.recovery(.decodeFailure) }
                return
            }
            let size = CGSize(width: CVPixelBufferGetWidth(image), height: CVPixelBufferGetHeight(image))
            let finished = ProcessInfo.processInfo.systemUptime
            let result = Output(sample: rendered, size: size, hardwareAccelerated: self.hardware,
                                decodeMilliseconds: (finished - start) * 1000,
                                luminance: self.sampleLuminance(image, time: finished, epoch: epoch),
                                isCurrent: { [weak self] in self?.isCurrent(epoch) == true })
            self.output(result) { [weak self] in self?.complete() }
        }
        // Apple guarantees the output handler is not called when DecodeFrame returns an error.
        if status != noErr { complete(); invalidateDecoder(); recovery(.decodeFailure) }
    }

    private func sampleLuminance(_ image: CVPixelBuffer, time: TimeInterval, epoch expected: UInt64) -> RemoteLuminanceSummary? {
        lock.lock()
        let shouldSample = !stopped && epoch == expected && time - lastLuminanceSampleTime >= 1
        if shouldSample { lastLuminanceSampleTime = time }
        lock.unlock()
        guard shouldSample, CVPixelBufferGetPixelFormatType(image) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
              CVPixelBufferIsPlanar(image), CVPixelBufferGetPlaneCount(image) >= 2,
              CVPixelBufferLockBaseAddress(image, .readOnly) == kCVReturnSuccess else { return nil }
        defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
        let width = CVPixelBufferGetWidthOfPlane(image, 0), height = CVPixelBufferGetHeightOfPlane(image, 0)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(image, 0)
        guard width > 0, height > 0, stride >= width,
              let base = CVPixelBufferGetBaseAddressOfPlane(image, 0)?.assumingMemoryBound(to: UInt8.self) else { return nil }
        var minimum: UInt8 = 255, maximum: UInt8 = 0, total = 0
        for row in 0..<16 {
            let y = row * (height - 1) / 15
            for column in 0..<16 {
                let x = column * (width - 1) / 15
                let value = base[y * stride + x]
                minimum = min(minimum, value); maximum = max(maximum, value); total += Int(value)
            }
        }
        return .init(minimum: minimum, mean: Double(total) / 256, maximum: maximum)
    }

    private func createDecoder(_ format: CMVideoFormatDescription) {
        var specification: [CFString: Any] = [:]
        if #available(iOS 17.0, *) {
            specification[kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder] = true
        }
        let attributes: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferIOSurfacePropertiesKey: [:]
        ]
        guard VTDecompressionSessionCreate(allocator: kCFAllocatorDefault, formatDescription: format,
                decoderSpecification: specification as CFDictionary, imageBufferAttributes: attributes as CFDictionary,
                outputCallback: nil, decompressionSessionOut: &decompressor) == noErr,
              let decompressor else { return }
        VTSessionSetProperty(decompressor, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        hardware = nil
        if #available(iOS 17.0, *) {
            let value = UnsafeMutablePointer<CFTypeRef?>.allocate(capacity: 1)
            value.initialize(to: nil)
            defer { value.deinitialize(count: 1); value.deallocate() }
            if VTSessionCopyProperty(decompressor, key: kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder,
                                     allocator: kCFAllocatorDefault, valueOut: value) == noErr {
                hardware = value.pointee as? Bool
            }
        }
    }

    static func splitAnnexB(_ data: Data) -> [Data] {
        let bytes = [UInt8](data)
        func startLength(_ i: Int) -> Int {
            guard i + 2 < bytes.count, bytes[i] == 0, bytes[i + 1] == 0 else { return 0 }
            if bytes[i + 2] == 1 { return 3 }
            if i + 3 < bytes.count, bytes[i + 2] == 0, bytes[i + 3] == 1 { return 4 }
            return 0
        }
        var result: [Data] = [], i = 0
        while i < bytes.count, startLength(i) == 0 { i += 1 }
        while i < bytes.count {
            let start = i + startLength(i)
            var end = start
            while end < bytes.count, startLength(end) == 0 { end += 1 }
            if end > start { result.append(Data(bytes[start..<end])) }
            i = end
        }
        return result
    }

    private static func makeFormat(sps: Data, pps: Data) -> CMVideoFormatDescription? {
        sps.withUnsafeBytes { spsBytes in pps.withUnsafeBytes { ppsBytes in
            guard let spsPointer = spsBytes.bindMemory(to: UInt8.self).baseAddress,
                  let ppsPointer = ppsBytes.bindMemory(to: UInt8.self).baseAddress else { return nil }
            let pointers = [spsPointer, ppsPointer], sizes = [sps.count, pps.count]
            var description: CMFormatDescription?
            let status = CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator: kCFAllocatorDefault,
                parameterSetCount: 2, parameterSetPointers: pointers, parameterSetSizes: sizes,
                nalUnitHeaderLength: 4, formatDescriptionOut: &description)
            return status == noErr ? description : nil
        } }
    }

    private static func makeCompressedSample(avcc: Data, format: CMVideoFormatDescription) -> CMSampleBuffer? {
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
              blockLength: avcc.count, blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
              offsetToData: 0, dataLength: avcc.count, flags: 0, blockBufferOut: &block) == noErr,
              let block else { return nil }
        let status = avcc.withUnsafeBytes {
            CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block,
                                          offsetIntoDestination: 0, dataLength: avcc.count)
        }
        guard status == noErr else { return nil }
        var sample: CMSampleBuffer?, size = avcc.count
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
        guard CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block,
              formatDescription: format, sampleCount: 1, sampleTimingEntryCount: 1,
              sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: &size,
              sampleBufferOut: &sample) == noErr else { return nil }
        return sample
    }

    private static func makeImageSample(_ image: CVPixelBuffer, time: CMTime) -> CMSampleBuffer? {
        var format: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault,
              imageBuffer: image, formatDescriptionOut: &format) == noErr, let format else { return nil }
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: time, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image,
              formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample) == noErr,
              let sample else { return nil }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true),
           CFArrayGetCount(attachments) > 0 {
            let dict = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(dict, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                                 Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        return sample
    }
}
