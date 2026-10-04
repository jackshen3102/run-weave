import AVFoundation
import Foundation

enum RemoteVideoRendererMode {
    static let legacyProbeEnabled: Bool = {
        #if DEBUG && targetEnvironment(simulator)
        return ProcessInfo.processInfo.arguments.contains("--remote-renderer-legacy-probe")
        #else
        return false
        #endif
    }()
}

/// Keep queue operations and their diagnostics on the same API. Apple forbids
/// mixing the layer's queue methods with sampleBufferRenderer on iOS 17+.
@MainActor
extension AVSampleBufferDisplayLayer {
    private var usesSampleBufferRenderer: Bool {
        if #available(iOS 17, *) { return !RemoteVideoRendererMode.legacyProbeEnabled }
        return false
    }

    var remoteRenderingAPI: String {
        if RemoteVideoRendererMode.legacyProbeEnabled { return "模拟器负例 · Legacy layer" }
        return usesSampleBufferRenderer ? "sampleBufferRenderer" : "Legacy layer · iOS 15/16"
    }

    var remoteRenderingStatus: AVQueuedSampleBufferRenderingStatus {
        if #available(iOS 17, *), usesSampleBufferRenderer { return sampleBufferRenderer.status }
        return status
    }

    var remoteRenderingError: Error? {
        if #available(iOS 17, *), usesSampleBufferRenderer { return sampleBufferRenderer.error }
        return error
    }

    var remoteRequiresFlush: Bool {
        if #available(iOS 17, *), usesSampleBufferRenderer { return sampleBufferRenderer.requiresFlushToResumeDecoding }
        return requiresFlushToResumeDecoding
    }

    var remoteReadyForMoreMediaData: Bool {
        if #available(iOS 17, *), usesSampleBufferRenderer { return sampleBufferRenderer.isReadyForMoreMediaData }
        return isReadyForMoreMediaData
    }

    func enqueueRemoteSampleBuffer(_ sample: CMSampleBuffer) {
        if #available(iOS 17, *), usesSampleBufferRenderer { sampleBufferRenderer.enqueue(sample) }
        else { enqueue(sample) }
    }

    func flushRemoteVideo(completion: (@Sendable () -> Void)? = nil) {
        if #available(iOS 17, *), usesSampleBufferRenderer {
            sampleBufferRenderer.flush(removingDisplayedImage: true, completionHandler: completion)
        } else {
            flushAndRemoveImage()
            // The legacy API has no completion signal; notify after its clearing call returns.
            completion?()
        }
    }
}

@MainActor
extension RemoteDesktopStatistics {
    mutating func updateDisplay(_ layer: AVSampleBufferDisplayLayer) {
        displayRenderer = layer.remoteRenderingAPI
        displayAcceptsMediaData = layer.remoteReadyForMoreMediaData
        switch layer.remoteRenderingStatus {
        case .unknown: displayStatus = "unknown"
        case .rendering: displayStatus = "rendering"
        case .failed: displayStatus = "failed"
        @unknown default: displayStatus = "unknown"
        }
        if #available(iOS 17.4, *) { displayReady = layer.isReadyForDisplay }
        else { displayReady = nil }
        videoLayerSize = layer.bounds.size
        displayRequiresFlush = layer.remoteRequiresFlush
        preventsCapture = layer.preventsCapture
        outputObscured = layer.isOutputObscuredDueToInsufficientExternalProtection
        if let error = layer.remoteRenderingError as NSError? {
            // Domain/code only: never forward userInfo, media payloads or localized descriptions.
            displayErrorDomain = error.domain; displayErrorCode = error.code
        }
    }
}
