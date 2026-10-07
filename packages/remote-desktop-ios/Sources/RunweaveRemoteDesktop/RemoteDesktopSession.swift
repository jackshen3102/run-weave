import Foundation
import Combine
import CoreGraphics
import AVFoundation
import RunweaveRemoteDesktopProtocol

@MainActor
public final class RemoteDesktopSession: ObservableObject {
    @Published public private(set) var state: RemoteDesktopState = .idle
    @Published public private(set) var connectionRoute: RemoteConnectionRoute?
    @Published public private(set) var geometry: RemoteDisplayGeometry?
    @Published public private(set) var statistics = RemoteDesktopStatistics()
    @Published public var inputMode: RemoteInputMode = .trackpad {
        didSet {
            if oldValue != inputMode {
                cursor = CGPoint(x: 0.5, y: 0.5)
                releaseAllInputs(reason: "input mode changed")
            }
        }
    }
    @Published var viewportReset: UInt64 = 0
    @Published var textEntryActive = false
    public private(set) var target: RemoteTarget?
    public private(set) var context: RemoteSessionContext?
    private let credentials: RemoteCredentialStore
    private(set) var active = false
    private(set) var attempt = UUID()
    private(set) var wireSessionID = UUID()
    private(set) var control: RemoteTLSConnection?
    private var video: RemoteTLSConnection?
    private var decoder: H264Decoder?
    private var connectionTask: Task<Void, Never>?
    private var controlTask: Task<Void, Never>?
    private var videoTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var displayMonitorTask: Task<Void, Never>?
    private var inputTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var retryDelay: UInt64 = 500_000_000
    var inputQueue: [RemoteControlMessage] = []
    private var lastVideoSequence: UInt64?
    private var firstFrame = false
    private var displaySubmittedAttempt: UUID?
    private var displayEpoch: UInt64 = 0
    private var displayBlockedSince: TimeInterval?
    private var lastDecodedDeliveryAt: TimeInterval?
    private var displayRecoveryID: UUID?
    private var displayRecoveryDeadline: TimeInterval?
    private var displayFlushPending = false
    private var displayRecoveryUsed = false
    private var displayRecoveryPresentationID: UUID?
    private var controlAllowed = false
    private var lastRecoveryRequest: TimeInterval = 0
    private var lastPong: TimeInterval = 0
    private var pingNonce: UInt64 = 0
    private var pendingPings: [UInt64: TimeInterval] = [:]
    private weak var displayLayer: AVSampleBufferDisplayLayer?
    private var displayOwnerID: UUID?
    private var counters = RemoteDesktopStatistics()
    private var lastStatisticsPublish: TimeInterval = 0
    var cursor = CGPoint(x: 0.5, y: 0.5)
    private var decodeSamples: [Double] = []
    private var networkSamples: [Double] = []
    private var decodeSampleCount: UInt64 = 0
    private var networkSampleCount: UInt64 = 0
    private let observation: RemoteObservationRecorder

    public init(credentials: RemoteCredentialStore = .init(),
                observe: @escaping (RemoteDesktopObservation) -> Void = { _ in }) {
        self.credentials = credentials; self.observation = RemoteObservationRecorder(observe)
    }

    public func connect(target: RemoteTarget, context: RemoteSessionContext) {
        stop(reason: "target changed")
        guard target.id == context.targetID else { state = .failed("桌面目标与呈现身份不一致。"); return }
        self.target = target; self.context = context
        if displayRecoveryPresentationID != context.presentationID {
            displayRecoveryPresentationID = context.presentationID
            displayRecoveryUsed = false
        }
        statistics = .init(); counters = .init(); lastStatisticsPublish = 0
        decodeSamples = []; networkSamples = []
        decodeSampleCount = 0; networkSampleCount = 0
        retryDelay = 500_000_000; active = true
        beginConnection()
    }

    /// False releases and tears down immediately. The host must explicitly call
    /// connect with a fresh presentation context to return from the background.
    public func setPresentationActive(_ value: Bool) { if !value { stop(reason: "presentation inactive") } }

    public func stop(reason: String = "closed") {
        observation.end(reason: Self.observationStopReason(reason), counters: counters)
        stopResources(reason: reason)
        geometry = nil; textEntryActive = false; connectionRoute = nil; state = .idle
        statistics = counters
    }

    /// Also safe during UIViewRepresentable dismantling: no observable writes or callbacks.
    private func stopResources(reason: String) {
        active = false
        reconnectTask?.cancel(); reconnectTask = nil
        let oldControl = control, oldSessionID = wireSessionID
        if let oldControl {
            try? oldControl.sendBestEffort(.init(kind: .releaseAll, sessionID: oldSessionID, reason: reason))
            try? oldControl.sendBestEffort(.init(kind: .stop, sessionID: oldSessionID, reason: reason))
        }
        teardown(publishStatistics: false)
        context = nil
    }

    func attachDisplayLayer(_ layer: AVSampleBufferDisplayLayer, ownerID: UUID) {
        displayLayer?.flushRemoteVideo()
        displayLayer = layer; displayOwnerID = ownerID
        clearDisplayImage()
        if active { state = .waitingForFirstFrame; requestKeyframe() }
    }

    func updateDisplaySurface(ownerID: UUID, inWindow: Bool, viewportSize: CGSize) {
        guard displayOwnerID == ownerID else { return }
        counters.surfaceInWindow = inWindow
        counters.viewportSize = viewportSize
        inspectDisplayLayer()
    }

    func displayReadinessChanged(ownerID: UUID) {
        guard displayOwnerID == ownerID else { return }
        inspectDisplayLayer()
    }

    func detachDisplayLayer(ownerID: UUID) {
        guard displayOwnerID == ownerID else { return }
        displayLayer?.flushRemoteVideo(); displayLayer = nil; displayOwnerID = nil
        // Surface removal must stop resources even if the host omits stop. Publishing
        // while SwiftUI destroys its graph traps inside GraphHost.asyncTransaction;
        // defer notifications only if the host has not already stopped the session.
        guard active || context != nil else { return }
        stopResources(reason: "video surface detached")
        let expected = attempt
        Task { @MainActor in
            guard self.attempt == expected, self.displayOwnerID == nil else { return }
            self.stop(reason: "video surface detached")
        }
    }

    private func beginConnection() {
        guard active, let target, let context else { return }
        teardown()
        let expected = attempt, sessionID = wireSessionID
        observation.start(counters: counters)
        state = .connecting
        displayMonitorTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.active, self.attempt == expected else { return }
                self.inspectDisplayLayer()
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
        }
        connectionTask = Task { [weak self] in
            guard let self else { return }
            do {
                let credential = try self.credentials.load(target: target)
                let control = try await RemotePairedConnection.connect(target: target)
                guard self.isCurrent(expected, context: context) else { control.close(); return }
                self.control = control
                try await control.send(.init(kind: .authenticate, hostID: target.id, deviceID: credential.deviceID,
                    token: credential.token, channel: "control", sessionID: sessionID))
                let ready = try await control.receiveMessage()
                guard self.isCurrent(expected, context: context) else { return }
                guard ready.kind == .ready, ready.hostID == target.id, ready.sessionID == sessionID else {
                    throw RemoteHostFailure(message: ready, fallback: "Mac 拒绝了桌面会话。")
                }
                self.connectionRoute = control.route
                guard let display = ready.display else {
                    self.observation.end(reason: "permission_screen_recording", counters: counters)
                    self.state = .permissionDenied(ready.reason ?? "请在 Mac 授予屏幕录制权限。"); self.active = false
                    self.teardown(); return
                }
                try self.applyDisplay(display)
                self.controlAllowed = ready.controlAllowed == true
                self.state = .waitingForFirstFrame
                self.installDecoder(attempt: expected, context: context)
                self.receiveControl(control, attempt: expected, context: context)
                self.startHeartbeat(control, attempt: expected)
                try await control.send(.init(kind: .startViewing, sessionID: sessionID, displayID: display.displayID))
                // Both channels use the endpoint of this authenticated control
                // connection, even when the saved address is no longer current.
                let video = try await RemoteTLSConnection.connect(target: target,
                    endpoint: control.connection.currentPath?.remoteEndpoint ?? control.connection.endpoint,
                    route: control.route)
                guard self.isCurrent(expected, context: context) else { video.close(); return }
                self.video = video
                try await video.send(.init(kind: .authenticate, hostID: target.id, deviceID: credential.deviceID,
                    token: credential.token, channel: "video", sessionID: sessionID))
                let videoReady = try await video.receiveMessage()
                guard videoReady.kind == .ready, videoReady.hostID == target.id, videoReady.sessionID == sessionID else {
                    throw RemoteHostFailure(message: videoReady, fallback: "Mac 拒绝了视频订阅。")
                }
                guard self.isCurrent(expected, context: context) else { return }
                self.receiveVideo(video, attempt: expected, context: context)
            } catch is CancellationError { }
            catch { self.handleDrop(error, attempt: expected) }
        }
    }

    private func receiveControl(_ channel: RemoteTLSConnection, attempt expected: UUID, context: RemoteSessionContext) {
        controlTask = Task { [weak self] in
            guard let self else { return }
            do {
                while !Task.isCancelled, self.isCurrent(expected, context: context) {
                    let message = try await channel.receiveMessage()
                    guard self.isCurrent(expected, context: context) else { return }
                    try self.handleControl(message)
                }
            } catch is CancellationError { }
            catch { self.handleDrop(error, attempt: expected) }
        }
    }

    private func installDecoder(attempt expected: UUID, context: RemoteSessionContext) {
        decoder = H264Decoder(output: { [weak self] output, complete in
            Task { @MainActor in
                defer { complete() }
                guard let self, self.isCurrent(expected, context: context), output.isCurrent() else { return }
                guard output.size == self.geometry?.pixelSize else {
                    self.handleDrop(RemoteTransportError.invalidMessage, attempt: expected); return
                }
                self.counters.decodedFrames &+= 1 &+ output.skippedPresentationFrames
                self.counters.presentationDrops &+= output.skippedPresentationFrames
                self.counters.droppedFrames &+= output.skippedPresentationFrames
                self.counters.decodeMilliseconds = output.decodeMilliseconds
                self.counters.hardwareDecoder = output.hardwareAccelerated
                if let luminance = output.luminance { self.counters.decodedLuminance = luminance }
                if let image = CMSampleBufferGetImageBuffer(output.sample) {
                    self.counters.decodedPixelFormat = CVPixelBufferGetPixelFormatType(image)
                    self.counters.decodedHasIOSurface = CVPixelBufferGetIOSurface(image) != nil
                }
                self.decodeSampleCount &+= 1
                self.decodeSamples.append(output.decodeMilliseconds)
                if self.decodeSamples.count > 256 { self.decodeSamples.removeFirst() }
                guard let layer = self.displayLayer else { self.counters.droppedFrames &+= 1; return }
                let now = ProcessInfo.processInfo.systemUptime
                if let previous = self.lastDecodedDeliveryAt, now - previous > 1 { self.displayBlockedSince = nil }
                self.lastDecodedDeliveryAt = now
                guard !self.displayFlushPending else { self.counters.droppedFrames &+= 1; return }
                guard layer.remoteRenderingStatus != .failed, !layer.remoteRequiresFlush else {
                    self.inspectDisplayLayer(); self.counters.droppedFrames &+= 1; return
                }
                guard layer.remoteReadyForMoreMediaData else {
                    if self.displayBlockedSince == nil { self.displayBlockedSince = now }
                    self.counters.displayIngressState = self.displayRecoveryID == nil ? "拒收观察" : "恢复期间拒收"
                    self.counters.droppedFrames &+= 1; return
                }
                self.displayBlockedSince = nil
                if self.displayRecoveryID == nil { self.counters.displayIngressState = "接受数据" }
                layer.enqueueRemoteSampleBuffer(output.sample)
                self.displaySubmittedAttempt = expected
                self.counters.submittedFrames &+= 1
                self.publishStatistics()
            }
        })
    }

    private func receiveVideo(_ channel: RemoteTLSConnection, attempt expected: UUID, context: RemoteSessionContext) {
        videoTask = Task { [weak self] in
            guard let self else { return }
            do {
                while !Task.isCancelled, self.isCurrent(expected, context: context) {
                    let data = try await channel.receiveData()
                    guard self.isCurrent(expected, context: context) else { return }
                    let packet = try RemoteVideoPacket.decode(data)
                    guard let geometry = self.geometry, packet.header.sessionID == self.wireSessionID,
                          packet.header.displayID == geometry.displayID,
                          packet.header.displayRevision == geometry.revision else {
                        self.counters.droppedFrames &+= 1; continue
                    }
                    self.counters.receivedFrames &+= 1
                    if let previous = self.lastVideoSequence, packet.header.sequence != previous &+ 1 {
                        self.counters.sequenceGaps &+= 1
                        if !packet.header.keyframe || !H264Decoder.isIndependentKeyframe(packet.annexB) {
                            self.recoverVideoDependency(reason: "video dependency gap")
                        }
                    }
                    self.lastVideoSequence = packet.header.sequence
                    let result = await self.decoder?.submit(annexB: packet.annexB, isKeyframe: packet.header.keyframe)
                    guard self.isCurrent(expected, context: context) else { return }
                    if case .recovery(let reason) = result {
                        self.counters.decoderRecoveries &+= 1
                        if case .backlog = reason { self.counters.decoderOverflows &+= 1 }
                        self.counters.droppedFrames &+= 1
                        self.recoverVideoDependency(reason: "decoder recovering")
                    }
                    self.counters.maximumDecoderQueueDepth = max(self.counters.maximumDecoderQueueDepth, 1)
                }
            } catch is CancellationError { }
            catch { self.handleDrop(error, attempt: expected) }
        }
    }

    private func recoverVideoDependency(reason: String) {
        releaseAllInputs(reason: reason)
        decoder?.reset()
        // Compressed-frame loss invalidates the decoder chain, not the already
        // decoded image in the renderer. Retain it while waiting for an IDR.
        // Input still requires a fresh decoded submission and display readiness.
        firstFrame = false; displaySubmittedAttempt = nil
        state = .recoveringVideo
        requestKeyframe()
    }

    private func handleControl(_ message: RemoteControlMessage) throws {
        guard message.sessionID == wireSessionID else { throw RemoteTransportError.invalidMessage }
        switch message.kind {
        case .display:
            guard let display = message.display else { throw RemoteTransportError.invalidMessage }
            try applyDisplay(display)
            if let allowed = message.controlAllowed { controlAllowed = allowed }
            decoder?.reset(); lastVideoSequence = nil
            state = .waitingForFirstFrame; clearDisplayImage(); releaseAllInputs(reason: "display changed")
            requestKeyframe()
        case .pong:
            if let nonce = message.nonce, let sentAt = pendingPings.removeValue(forKey: nonce) {
                lastPong = ProcessInfo.processInfo.systemUptime
                counters.networkRoundTripMilliseconds = (lastPong - sentAt) * 1000
                networkSampleCount &+= 1; networkSamples.append(counters.networkRoundTripMilliseconds)
                if networkSamples.count > 256 { networkSamples.removeFirst() }
                publishStatistics()
            }
        case .error:
            if message.errorCode == .permissionAccessibility {
                if controlAllowed { observation.controlBecameReadOnly() }
                releaseAllInputs(reason: "accessibility permission revoked")
                controlAllowed = false
                state = firstFrame ? .readOnly : .waitingForFirstFrame
            } else {
                let failure = RemoteHostFailure(message: message, fallback: "Mac 停止了桌面共享。")
                if failure.terminal {
                    try? control?.sendBestEffort(.init(kind: .stopAck, sessionID: wireSessionID))
                }
                throw failure
            }
        case .stop:
            try? control?.sendBestEffort(.init(kind: .stopAck, sessionID: wireSessionID))
            throw RemoteHostFailure(message: message, fallback: "Mac 本地停止了共享。")
        case .stats: break
        default: break
        }
    }

    private func applyDisplay(_ display: RemoteDisplay) throws {
        geometry = try display.validatedGeometry()
        cursor = CGPoint(x: 0.5, y: 0.5)
    }

    private func publishStatistics() {
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastStatisticsPublish >= 0.5 else { return }
        lastStatisticsPublish = now
        counters.updateTiming(queueDepth: decoder?.queueDepth ?? 0, decode: decodeSamples, decodeTotal: decodeSampleCount, network: networkSamples, networkTotal: networkSampleCount)
        statistics = counters
    }

    private func inspectDisplayLayer() {
        guard let layer = displayLayer else { return }
        counters.updateDisplay(layer)
        defer { publishStatistics() }
        guard active else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if let deadline = displayRecoveryDeadline, now >= deadline {
            failDisplayProgress("桌面显示恢复超时，已释放输入并停止会话。")
            return
        }
        guard !displayFlushPending else { return }
        if layer.remoteRenderingStatus == .failed || layer.remoteRequiresFlush {
            counters.displayFailures &+= 1
            state = .waitingForFirstFrame
            releaseAllInputs(reason: "display renderer recovering")
            decoder?.reset(); clearDisplayImage(); requestKeyframe()
            return
        }
        if let lastDelivery = lastDecodedDeliveryAt, now - lastDelivery > 1 { displayBlockedSince = nil }
        if counters.displayAcceptsMediaData { displayBlockedSince = nil }
        if displayRecoveryID == nil, let blockedSince = displayBlockedSince,
           let lastDelivery = lastDecodedDeliveryAt, now - blockedSince >= 3,
           now - lastDelivery <= 1, !counters.displayAcceptsMediaData {
            recoverDisplayProgress(now: now)
            return
        }
        guard displaySubmittedAttempt == attempt else { return }
        let ready: Bool
        if #available(iOS 17.4, *) { ready = layer.isReadyForDisplay }
        else {
            // Older systems expose no first-image signal. Wait for the renderer's
            // asynchronous rendering state, never promote merely after enqueue.
            ready = layer.remoteRenderingStatus == .rendering
        }
        let visible = counters.surfaceInWindow && counters.viewportSize.width > 0 && counters.viewportSize.height > 0 &&
            layer.bounds.width > 0 && layer.bounds.height > 0 && !layer.isHidden && !counters.outputObscured
        if ready && visible {
            if !firstFrame {
                counters.displayIngressState = displayRecoveryID == nil ? "接受数据" : "已恢复接受数据"
                displayRecoveryID = nil; displayRecoveryDeadline = nil
                firstFrame = true; retryDelay = 500_000_000
                observation.visible(now: now, readOnly: !controlAllowed)
                state = controlAllowed ? .controllable : .readOnly
            }
        } else if firstFrame {
            firstFrame = false; state = .waitingForFirstFrame
            releaseAllInputs(reason: "display is not ready")
        }
    }

    /// This tracks acceptance of decoded deliveries, not physical pixel scanout.
    private func recoverDisplayProgress(now: TimeInterval) {
        guard !displayRecoveryUsed, control != nil else {
            failDisplayProgress("桌面显示再次停滞，已释放输入并停止会话。")
            return
        }
        displayRecoveryUsed = true
        displayRecoveryID = UUID(); displayRecoveryDeadline = now + 5
        counters.displayStallRecoveries &+= 1
        counters.displayIngressState = "清理显示入口"
        firstFrame = false; displaySubmittedAttempt = nil; state = .waitingForFirstFrame
        inputQueue.removeAll()
        do {
            // Do not cancel an in-flight input send: cancellation closes its TLS channel.
            try control?.sendBestEffort(.init(kind: .releaseAll, sessionID: wireSessionID, reason: "display stalled"))
        } catch {
            failDisplayProgress("桌面显示恢复中断，已释放输入并停止会话。")
            return
        }
        decoder?.reset()
        clearDisplayImage()
    }

    private func clearDisplayImage() {
        displayEpoch &+= 1
        firstFrame = false; displaySubmittedAttempt = nil
        displayBlockedSince = nil; lastDecodedDeliveryAt = nil
        guard let layer = displayLayer else { return }
        counters.displayImageClears &+= 1
        guard let recoveryID = displayRecoveryID, let context, let ownerID = displayOwnerID else {
            layer.flushRemoteVideo()
            return
        }
        displayFlushPending = true
        let expected = attempt, epoch = displayEpoch
        let pendingInput = inputTask
        layer.flushRemoteVideo { [weak self, weak layer] in
            Task { @MainActor in
                // A send already crossing the actor boundary may finish after the
                // immediate release. Drain it and release again before reopening input.
                await pendingInput?.value
                guard let self, let layer, self.isCurrent(expected, context: context),
                      self.displayEpoch == epoch, self.displayOwnerID == ownerID,
                      self.displayLayer === layer, self.displayRecoveryID == recoveryID else { return }
                if pendingInput != nil {
                    do {
                        try self.control?.sendBestEffort(.init(kind: .releaseAll, sessionID: self.wireSessionID, reason: "display recovery drained input"))
                    } catch {
                        self.failDisplayProgress("桌面显示恢复中断，已释放输入并停止会话。")
                        return
                    }
                }
                self.displayFlushPending = false
                self.counters.displayIngressState = "等待恢复首帧"
                self.requestKeyframe()
            }
        }
    }

    private func failDisplayProgress(_ reason: String) {
        counters.displayIngressState = "显示恢复已停止"
        observation.end(reason: "display_stalled", counters: counters)
        stop(reason: reason)
        state = .failed(reason)
    }

    private func startHeartbeat(_ channel: RemoteTLSConnection, attempt expected: UUID) {
        lastPong = ProcessInfo.processInfo.systemUptime
        heartbeatTask = Task { [weak self] in
            guard let self else { return }
            do {
                while !Task.isCancelled, self.active, self.attempt == expected {
                    let now = ProcessInfo.processInfo.systemUptime
                    guard now - self.lastPong < 4 else { throw RemoteTransportError.closed }
                    self.pendingPings = self.pendingPings.filter { now - $0.value < 4 }
                    self.pingNonce &+= 1; self.pendingPings[self.pingNonce] = now
                    try await channel.send(.init(kind: .ping, sessionID: self.wireSessionID, nonce: self.pingNonce))
                    if !self.firstFrame { self.requestKeyframe() }
                    try await Task.sleep(nanoseconds: 1_000_000_000)
                }
            } catch is CancellationError { }
            catch { self.handleDrop(error, attempt: expected) }
        }
    }

    private func requestKeyframe() {
        let now = ProcessInfo.processInfo.systemUptime
        guard active, !displayFlushPending, let control, now - lastRecoveryRequest >= 0.25 else { return }
        lastRecoveryRequest = now; counters.recoveryRequests &+= 1
        let sessionID = wireSessionID, expected = attempt
        Task { [weak self] in
            do { try await control.send(.init(kind: .requestKeyframe, sessionID: sessionID)) }
            catch { self?.handleDrop(error, attempt: expected) }
        }
    }

    private func isCurrent(_ expected: UUID, context expectedContext: RemoteSessionContext) -> Bool {
        active && attempt == expected && context == expectedContext && target?.id == expectedContext.targetID
    }

    private func teardown(publishStatistics: Bool = true) {
        attempt = UUID(); wireSessionID = UUID()
        connectionTask?.cancel(); connectionTask = nil
        controlTask?.cancel(); controlTask = nil
        videoTask?.cancel(); videoTask = nil
        heartbeatTask?.cancel(); heartbeatTask = nil
        displayMonitorTask?.cancel(); displayMonitorTask = nil
        inputTask?.cancel(); inputTask = nil
        inputQueue.removeAll(); pendingPings.removeAll()
        video?.close(); video = nil
        control?.close(); control = nil
        decoder?.stop(); decoder = nil
        lastVideoSequence = nil; firstFrame = false; displaySubmittedAttempt = nil; controlAllowed = false
        displayRecoveryID = nil; displayRecoveryDeadline = nil; displayFlushPending = false
        counters.decoderQueueDepth = 0
        if publishStatistics { statistics = counters; connectionRoute = nil }
        clearDisplayImage()
    }

    func handleDrop(_ error: Error, attempt expected: UUID) {
        guard active, attempt == expected else { return }
        var terminal = error is RemotePairingError || error is DecodingError
        var permissionFailure = false
        if let failure = error as? RemoteHostFailure {
            terminal = failure.terminal
            permissionFailure = failure.code == .permissionScreenRecording || failure.code == .permissionAccessibility
        }
        if let transport = error as? RemoteTransportError {
            terminal = transport != .closed && transport != .connectionTimedOut
        }
        if displayRecoveryID != nil, !terminal {
            failDisplayProgress("桌面显示恢复中断，已释放输入并停止会话。")
            return
        }
        let reason = (error as? LocalizedError)?.errorDescription ?? "检查 Mac 和局域网连接。"
        observation.end(reason: RemoteObservationRecorder.failureReason(error), counters: counters)
        teardown(); geometry = nil
        state = permissionFailure ? .permissionDenied(reason) : (terminal ? .failed(reason) : .disconnected(reason))
        if terminal { active = false; return }
        let expectedContext = context, delay = retryDelay
        retryDelay = min(retryDelay * 2, 5_000_000_000)
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: delay) } catch { return }
            guard let self, self.active, self.context == expectedContext else { return }
            self.beginConnection()
        }
    }

    func sendInput(_ input: RemoteInput) {
        guard state == .controllable, active, firstFrame, let geometry, input.isValid else { return }
        let message = RemoteControlMessage(kind: .input, sessionID: wireSessionID, displayID: geometry.displayID,
                                          displayRevision: geometry.revision, input: input)
        // Only unsent pointer moves coalesce. Button/key transitions never replay
        // across a reconnect and never disappear to make room for newer clicks.
        if input.kind == .pointerMove, inputQueue.last?.input?.kind == .pointerMove {
            inputQueue[inputQueue.count - 1] = message
        } else {
            guard inputQueue.count < 64 else {
                releaseAllInputs(reason: "input queue overflow")
                let reason = "输入发送积压，已释放按键并停止会话。"
                observation.end(reason: "input_backlog", counters: counters)
                stop(reason: reason); state = .failed(reason); return
            }
            inputQueue.append(message)
        }
        drainInputs()
    }

    private func drainInputs() {
        guard inputTask == nil, let control else { return }
        let expected = attempt
        inputTask = Task { [weak self] in
            guard let self else { return }
            do {
                while !Task.isCancelled, self.active, self.attempt == expected, !self.inputQueue.isEmpty {
                    let message = self.inputQueue.removeFirst()
                    try await control.send(message)
                    guard self.active, self.attempt == expected else { return }
                    self.observation.inputSent()
                }
                if self.attempt == expected { self.inputTask = nil }
            } catch is CancellationError { }
            catch { self.handleDrop(error, attempt: expected) }
        }
    }

}
