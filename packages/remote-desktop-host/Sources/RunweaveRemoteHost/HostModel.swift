import AppKit
import Foundation
import Network
import ApplicationServices
import Security
import RunweaveRemoteDesktopProtocol

@MainActor
final class HostModel: ObservableObject {
    @Published var status = "已停止"
    @Published var fingerprint = ""
    @Published var hostID: UUID?
    @Published var interfaceNames: [String] = []
    @Published var selectedInterface = ""
    @Published var endpointAddress = ""
    @Published var screenAllowed = false
    @Published var accessibilityAllowed = false
    @Published var isRunning = false {
        didSet {
            do {
                try HostLocalDiscovery.publish(running: isRunning, address: endpointAddress,
                    port: port, fingerprint: fingerprint)
            } catch {
                status = "本机连接信息发布失败：\(error.localizedDescription)"
            }
        }
    }
    @Published private(set) var sharingEnabled = false
    @Published private(set) var isNetworkRecovering = false
    @Published var isReconfiguring = false
    @Published var pairingCode: String?
    @Published private(set) var pairingInvitation: RemotePairingQR?
    @Published private(set) var pairingSeconds = 0
    @Published var pendingName: String?
    @Published var approveControl = false
    @Published var devices: [PairedDevice] = []
    @Published var activeDevice: String?
    @Published var frames: UInt64 = 0
    @Published var droppedFrames: UInt64 = 0
    @Published var encodeMilliseconds = 0.0
    @Published var hardwareAccelerated = false
    @Published var pressedInputs = 0
    @Published var captureActive = false
    @Published var lockedDisplayID: UInt32?
    @Published var encodeSampleCount = 0
    @Published var encodeP50 = 0.0
    @Published var encodeP95 = 0.0
    @Published var encoderInFlight = 0
    @Published var encoderMaximumInFlight = 0
    @Published var encoderSkipped: UInt64 = 0
    @Published var maximumSendDepth = 0
    @Published var consoleAvailable = true
    let port = HostRuntime.port

    private var identity: HostIdentity?
    private let monitor: NWPathMonitor
    private var interfaces: [NWInterface] = []
    private var listener: NWListener?
    private var sharingGeneration: UInt64 = 0
    private var channels: [UUID: RemoteTLSConnection] = [:]
    private var tasks: [UUID: Task<Void, Never>] = [:]
    private let input = DesktopInput()
    private var session: HostSession?
    private var stoppingSession = false
    private var revision: UInt64 = 0
    private var connectionAttempts: [TimeInterval] = []
    private var pairingUntil: TimeInterval = 0
    private var pairingAttempts = 0
    private var pairingRequestID: UUID?
    private var pendingPair: (UUID, String, CheckedContinuation<PairedDevice, Error>)?
    private var maintenanceTask: Task<Void, Never>?
    private let workspaceCenter = NSWorkspace.shared.notificationCenter
    private var workspaceObservers: [NSObjectProtocol] = []

    init() {
        selectedInterface = UserDefaults.standard.string(forKey: HostRuntime.interfacePreferenceKey) ?? ""
        #if DEBUG
        monitor = HostRuntime.simulatorLoopback ? NWPathMonitor(requiredInterfaceType: .loopback) : NWPathMonitor()
        #else
        monitor = NWPathMonitor()
        #endif
        refreshPermissions()
        do { devices = try HostPeerStore.load() } catch { status = error.localizedDescription }
        monitor.pathUpdateHandler = { [weak self] path in
            var names = Set<String>()
            var candidates = path.availableInterfaces.filter { $0.type == .wifi || $0.type == .wiredEthernet }
            #if DEBUG
            if HostRuntime.simulatorLoopback { candidates = path.availableInterfaces.filter { $0.type == .loopback && $0.name == "lo0" } }
            #endif
            let lan = candidates.filter { names.insert($0.name).inserted }
            Task { @MainActor in
                guard let self else { return }; self.interfaces = lan; self.interfaceNames = lan.map(\.name)
                if self.selectedInterface.isEmpty { self.selectedInterface = lan.first?.name ?? "" }
            }
        }
        monitor.start(queue: DispatchQueue(label: "runweave.remote.lan"))
        workspaceObservers.append(workspaceCenter.addObserver(forName: NSWorkspace.sessionDidResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }; self.consoleAvailable = false; self.closePairing()
                await self.stopSession(reason: HostError.consoleInactive.localizedDescription, terminal: true, errorCode: .hostStopped)
            }
        })
        workspaceObservers.append(workspaceCenter.addObserver(forName: NSWorkspace.sessionDidBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.consoleAvailable = true }
        })
        workspaceObservers.append(workspaceCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }; self.closePairing()
                await self.stopSession(reason: "Mac 即将睡眠，已停止共享；唤醒后请重新打开桌面。", terminal: true, errorCode: .hostStopped)
            }
        })
        maintenanceTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard let self else { return }; await self.maintain()
            }
        }
    }
    deinit { for observer in workspaceObservers { workspaceCenter.removeObserver(observer) } }

    func start() {
        guard !sharingEnabled, listener == nil, !stoppingSession, !isNetworkRecovering else { return }
        do {
            let identity = try self.identity ?? HostIdentity.loadOrCreate()
            self.identity = identity; fingerprint = identity.fingerprint; hostID = identity.hostID
            guard let selected = interfaces.first(where: { $0.name == selectedInterface }),
                  var address = Self.addressForInterface(selected.name) else { throw HostError.rejected("没有可用的监听接口。") }
            let parameters = try RemoteTLS.serverParameters(identity: identity.identity)
            #if DEBUG
            if HostRuntime.simulatorLoopback {
                guard selected.type == .loopback, selected.name == "lo0" else { throw HostError.rejected("模拟器验证只允许 lo0。") }
                address = "127.0.0.1"
                parameters.prohibitedInterfaceTypes = [.wifi, .wiredEthernet, .cellular, .other]
            }
            #endif
            lockedDisplayID = CGMainDisplayID() // A local start locks the displayed identity for this listener's lifetime.
            sharingGeneration &+= 1
            sharingEnabled = true
            try listen(identity: identity, selected: selected, address: address, parameters: parameters)
        } catch { sharingEnabled = false; status = error.localizedDescription }
    }

    private func listen(identity: HostIdentity, selected: NWInterface, address: String, parameters: NWParameters) throws {
        parameters.requiredInterface = selected
        parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(address), port: NWEndpoint.Port(rawValue: port)!)
        let listener = try NWListener(using: parameters)
        if !HostRuntime.simulatorLoopback {
            var service = NWListener.Service(name: RemoteHostDiscovery.serviceName(hostID: identity.hostID),
                type: RemoteHostDiscovery.serviceType, domain: "local.")
            service.noAutoRename = true
            listener.service = service
        }
        listener.newConnectionHandler = { [weak self, weak listener] connection in
            Task { @MainActor in
                guard let self, let listener, self.listener === listener else { connection.cancel(); return }
                self.accept(connection)
            }
        }
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            Task { @MainActor in
                guard let self, let listener, self.listener === listener else { return }
                switch state {
                case .ready:
                    self.status = "局域网服务就绪"; self.isRunning = true
                    UserDefaults.standard.set(selected.name, forKey: HostRuntime.interfacePreferenceKey)
                case .failed(let error):
                    if case .posix(let code) = error, [.EADDRNOTAVAIL, .ENETDOWN, .ENETUNREACH].contains(code) {
                        await self.recoverNetworkIfNeeded(listenerFailed: true)
                    } else {
                        await self.stop(); self.status = "监听失败，请检查接口和端口。"
                    }
                default: break
                }
            }
        }
        self.listener = listener; endpointAddress = address
        listener.start(queue: DispatchQueue(label: "runweave.remote.listener")); status = "启动中"
    }

    func stop() async {
        sharingEnabled = false; sharingGeneration &+= 1
        listener?.cancel(); listener = nil; isRunning = false; closePairing()
        await stopSession(reason: "本机已停止远程桌面服务。", terminal: true)
        for channel in channels.values { channel.close() }
        for task in tasks.values { task.cancel() }
        channels.removeAll(); tasks.removeAll(); lockedDisplayID = nil; status = "已停止"
    }

    private func recoverNetworkIfNeeded(listenerFailed: Bool = false) async {
        guard sharingEnabled, !isNetworkRecovering, !stoppingSession else { return }
        let selected = interfaces.first { $0.name == selectedInterface }
        let address = selected.flatMap { Self.addressForInterface($0.name) }
        guard listenerFailed || address != (endpointAddress.isEmpty ? nil : endpointAddress) else { return }
        let expected = sharingGeneration
        isNetworkRecovering = true
        defer { isNetworkRecovering = false }
        listener?.cancel(); listener = nil; isRunning = false
        closePairing(reason: "网络地址已变化，请重新生成配对二维码。")
        await stopSession(reason: "Mac 网络地址已变化，正在重新建立桌面连接。", errorCode: .sessionExpired)
        for channel in channels.values { channel.close() }
        for task in tasks.values { task.cancel() }
        channels.removeAll(); tasks.removeAll()
        guard sharingEnabled, sharingGeneration == expected else { return }
        endpointAddress = ""
        guard !listenerFailed, let selected, let address, let identity else {
            status = "等待所选网络接口恢复；停止共享可取消自动恢复。"
            return
        }
        do {
            let parameters = try RemoteTLS.serverParameters(identity: identity.identity)
            #if DEBUG
            if HostRuntime.simulatorLoopback { parameters.prohibitedInterfaceTypes = [.wifi, .wiredEthernet, .cellular, .other] }
            #endif
            try listen(identity: identity, selected: selected, address: address, parameters: parameters)
        } catch {
            if let error = error as? NWError, case .posix(let code) = error,
               [.EADDRNOTAVAIL, .ENETDOWN, .ENETUNREACH].contains(code) {
                status = "等待所选网络接口恢复；停止共享可取消自动恢复。"
            } else { await stop(); status = error.localizedDescription }
        }
    }

    func refreshPermissions() { screenAllowed = CGPreflightScreenCaptureAccess(); accessibilityAllowed = AXIsProcessTrusted() }
    func requestScreenPermission() { _ = CGRequestScreenCaptureAccess(); refreshPermissions() }
    func requestAccessibilityPermission() {
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        refreshPermissions()
    }
    func openPairing() {
        guard isRunning, consoleAvailable, session == nil, devices.count < 32,
              let hostID, !endpointAddress.isEmpty, !fingerprint.isEmpty else { status = "先启动服务并结束当前会话，再开始配对。"; return }
        closePairing(reason: "二维码已更新，请重新扫码。")
        let code = String(format: "%06d", UInt32.random(in: 0...999999))
        pairingCode = code
        let name = (Host.current().localizedName ?? "Mac") + (HostRuntime.simulatorLoopback ? "（模拟器验证）" : "")
        let label = String(bytes: name.utf8.prefix(128), encoding: .utf8) ?? "Mac"
        pairingInvitation = RemotePairingQR(hostID: hostID, name: label, host: endpointAddress,
            port: port, certificateFingerprint: fingerprint, pairingWindowID: UUID(), code: code,
            expiresAt: Date().addingTimeInterval(120))
        pairingSeconds = 120
        pairingUntil = ProcessInfo.processInfo.systemUptime + 120; pairingAttempts = 0; approveControl = false
    }
    func closePairing(reason: String = "Mac 已取消配对。") {
        pairingCode = nil; pairingInvitation = nil; pairingSeconds = 0
        pairingUntil = 0; pendingName = nil; pairingRequestID = nil
        if let pendingPair { self.pendingPair = nil; pendingPair.2.resume(throwing: HostError.rejected(reason)) }
    }
    func approvePairing() {
        guard let pending = pendingPair, pairingUntil > ProcessInfo.processInfo.systemUptime else { return }
        do {
            var token = Data(count: 32)
            guard token.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }) == errSecSuccess else { throw HostError.identityFailure }
            let record = PairedDevice(id: pending.0, name: pending.1, token: token, controlAllowed: approveControl, pairedAt: Date())
            var next = devices.filter { $0.id != record.id }; next.append(record)
            try HostPeerStore.save(next); devices = next
            pendingPair = nil; pairingCode = nil; pairingInvitation = nil; pairingSeconds = 0
            pendingName = nil; pairingUntil = 0
            pending.2.resume(returning: record)
        } catch { status = error.localizedDescription; closePairing() }
    }
    func revoke(_ device: PairedDevice) async {
        do {
            let remaining = devices.filter { $0.id != device.id }; try HostPeerStore.save(remaining); devices = remaining
            if session?.device.id == device.id { await stopSession(reason: "Mac 已撤销此设备的配对。", terminal: true, errorCode: .authentication) }
        } catch { status = error.localizedDescription }
    }
    func stopCurrentSession(cancelRecovery: Bool = false) async {
        if cancelRecovery || isReconfiguring {
            await stop()
            status = "恢复已由本机取消，服务已停止"
        } else {
            await stopSession(reason: "Mac 本机已结束当前桌面会话。", terminal: true)
        }
    }

    private func accept(_ connection: NWConnection) {
        let now = ProcessInfo.processInfo.systemUptime
        connectionAttempts = connectionAttempts.filter { now - $0 < 10 }
        guard isRunning, channels.count < 4, connectionAttempts.count < 12 else { connection.cancel(); return }
        connectionAttempts.append(now)
        let id = UUID(); let channel = RemoteTLSConnection(connection: connection); channels[id] = channel
        tasks[id] = Task { [weak self] in
            guard let self else { channel.close(); return }
            await self.handle(channel)
            channel.close(); self.channels.removeValue(forKey: id); self.tasks.removeValue(forKey: id)
        }
    }

    private func handle(_ channel: RemoteTLSConnection) async {
        let authTimeout = Task { try? await Task.sleep(nanoseconds: 10_000_000_000); if !Task.isCancelled { channel.close() } }
        do {
            try await channel.start()
            let hello = try await channel.receiveMessage(); authTimeout.cancel()
            guard isRunning, listener != nil, !Task.isCancelled else { throw HostError.rejected("Mac 本机已停止共享服务。") }
            guard let identity else { throw HostError.identityFailure }
            if hello.kind == .pair { try await pair(hello, channel: channel); return }
            guard hello.hostID == identity.hostID else { throw HostError.rejected("Host 身份不匹配。") }
            guard consoleAvailable else { throw HostError.consoleInactive }
            guard hello.kind == .authenticate, let id = hello.deviceID, let token = hello.token, token.count == 32,
                  let device = devices.first(where: { $0.id == id }), Self.equalToken(device.token, token),
                  let sessionID = hello.sessionID else { throw HostError.rejected("设备未配对或授权已撤销。") }
            if hello.channel == "control" {
                guard session == nil else { throw HostError.rejected("Mac 已有一个当前桌面会话。") }
                if stoppingSession {
                    if isReconfiguring { throw HostError.displayReconfigured }
                    throw HostError.rejected("Mac 正在结束当前桌面会话。")
                }
                revision += 1
                guard let selectedDisplay = lockedDisplayID else { throw HostError.noDisplay }
                let geometry = try DesktopCapture.geometry(displayID: selectedDisplay, revision: revision)
                let active = HostSession(id: sessionID, device: device, control: channel, display: geometry)
                session = active; activeDevice = device.name; refreshPermissions()
                input.renewLease()
                active.reportedControlAllowed = device.controlAllowed && accessibilityAllowed
                try await channel.send(.init(kind: .ready, hostID: identity.hostID, sessionID: sessionID, display: screenAllowed ? geometry : nil, controlAllowed: active.reportedControlAllowed, reason: screenAllowed ? nil : HostError.screenPermission.localizedDescription, errorCode: screenAllowed ? nil : .permissionScreenRecording))
                try await runControl(active)
            } else if hello.channel == "video" {
                guard let active = session, active.id == sessionID, active.device.id == device.id,
                      active.video == nil else { throw HostError.rejected("视频连接没有对应的当前授权会话。") }
                active.video = channel
                try await channel.send(.init(kind: .ready, hostID: identity.hostID, sessionID: sessionID))
                try await startCaptureIfReady(active)
                _ = try await channel.receiveMessage() // A video stream is receive-only on the client.
                throw HostError.rejected("视频通道不能发送控制消息。")
            } else { throw RemoteTransportError.invalidMessage }
        } catch {
            authTimeout.cancel()
            if session?.control === channel || session?.video === channel {
                await stopSession(reason: error is HostError ? error.localizedDescription : "桌面连接已断开。", errorCode: (error as? HostError)?.wireCode)
            } else { try? await channel.send(.init(kind: .error, reason: error is HostError ? error.localizedDescription : "连接或协议被拒绝。", errorCode: (error as? HostError)?.wireCode ?? .authentication)) }
        }
    }

    private func pair(_ message: RemoteControlMessage, channel: RemoteTLSConnection) async throws {
        guard let code = pairingCode, pairingUntil > ProcessInfo.processInfo.systemUptime, pairingAttempts < 3,
              pendingPair == nil, pairingRequestID == nil, session == nil, let id = message.deviceID, let name = message.deviceName,
              !name.isEmpty, name.utf8.count <= 80, message.code?.count == 6 else { throw HostError.rejected("Mac 未开启有效的配对窗口。") }
        let windowID = message.pairingWindowID
        if let windowID {
            guard windowID == pairingInvitation?.pairingWindowID, message.hostID == identity?.hostID else {
                throw HostError.rejected("二维码已失效或 Mac 身份不匹配，请重新扫码。")
            }
        }
        pairingAttempts += 1
        guard message.code == code else {
            if pairingAttempts >= 3 { closePairing() }
            throw HostError.rejected("一次性配对信息错误或已失效。")
        }
        let reservation = UUID(); pairingRequestID = reservation
        defer { if pairingRequestID == reservation { pairingRequestID = nil } }
        try await channel.send(.init(kind: .pairingPending, hostID: identity?.hostID,
            pairingWindowID: windowID, reason: "请在 Mac 本机确认新设备和控制权限。"))
        guard pairingRequestID == reservation, pairingUntil > ProcessInfo.processInfo.systemUptime else { throw HostError.rejected("配对窗口已取消或过期。") }
        // A disconnected/cancelled phone must release the pending local approval.
        let disconnected = Task { [weak self] in
            do { _ = try await channel.receiveMessage() } catch {}
            guard !Task.isCancelled, self?.pairingRequestID == reservation else { return }
            self?.closePairing()
        }
        defer { disconnected.cancel() }
        do {
            let device = try await withCheckedThrowingContinuation { continuation in
                pendingPair = (id, name, continuation); pendingName = name
            }
            let hostName = (Host.current().localizedName ?? "Mac") + (HostRuntime.simulatorLoopback ? "（模拟器验证）" : "")
            try await channel.send(.init(kind: .paired, hostID: identity!.hostID, deviceID: device.id,
                deviceName: hostName, pairingWindowID: windowID, token: device.token, controlAllowed: device.controlAllowed))
        } catch {
            // Cancelling the disconnect reader closes TLS. Deliver the rejection first.
            try? await channel.send(.init(kind: .error,
                reason: (error as? HostError)?.localizedDescription ?? "配对连接已断开，请重新扫码。",
                errorCode: .authentication))
        }
    }

    private func runControl(_ active: HostSession) async throws {
        while (session === active || stoppingSession), !Task.isCancelled {
            let message = try await active.control.receiveMessage()
            guard message.sessionID == active.id else { throw HostError.rejected("会话身份已失效。") }
            if message.kind == .stopAck {
                guard stoppingSession else { throw RemoteTransportError.invalidMessage }
                active.stopAcknowledged = true; return
            }
            // A local stop may have invalidated this generation while receive was suspended.
            // Only its final acknowledgement may cross that boundary; queued input must not.
            guard session === active, !stoppingSession else {
                if stoppingSession { continue } // Drain queued input while waiting only for stopAck.
                return
            }
            switch message.kind {
            case .ping:
                active.lastHeartbeat = ProcessInfo.processInfo.systemUptime
                input.renewLease()
                try await active.control.send(.init(kind: .pong, sessionID: active.id, nonce: message.nonce))
            case .startViewing:
                guard message.displayID == nil || message.displayID == active.display.displayID else { throw HostError.noDisplay }
                guard CGPreflightScreenCaptureAccess() else { throw HostError.screenPermission }
                active.wantsViewing = true
                try await active.control.send(.init(kind: .display, sessionID: active.id, display: active.display, controlAllowed: active.device.controlAllowed && AXIsProcessTrusted()))
                try await startCaptureIfReady(active)
            case .input:
                let now = ProcessInfo.processInfo.systemUptime
                guard now - active.lastHeartbeat <= 3, captureActive, active.device.controlAllowed, AXIsProcessTrusted(),
                      message.displayID == active.display.displayID, message.displayRevision == active.display.revision,
                      let event = message.input, event.isValid else { throw HostError.rejected("输入未获授权、显示几何已失效或会话已过期。") }
                active.inputTimes = active.inputTimes.filter { now - $0 < 1 }
                guard active.inputTimes.count < 240 else { throw HostError.rejected("输入频率超过限制。") }
                active.inputTimes.append(now); try input.dispatch(event, display: active.display); pressedInputs = input.pressedCount
            case .releaseAll: input.releaseAll(); pressedInputs = 0
            case .requestKeyframe: active.capture.requestKeyframe()
            case .stop: await stopSession(reason: "iPhone 已退出桌面。"); return
            default: throw RemoteTransportError.invalidMessage
            }
        }
    }

    private func startCaptureIfReady(_ active: HostSession) async throws {
        guard session === active, active.wantsViewing, let video = active.video, !captureActive, !active.startingCapture else { return }
        active.startingCapture = true
        let sender = VideoSender(channel: video, sessionID: active.id, display: active.display,
                                 requestKeyframe: { [weak active] in Task { @MainActor in active?.capture.requestKeyframe() } },
                                 onFailure: { [weak self, weak active] _ in Task { @MainActor in if let active, self?.session === active { await self?.stopSession(reason: "视频接收过慢或连接已中断。") } } })
        active.sender = sender
        try await active.capture.start(display: active.display, onFrame: { sender.offer($0, keyframe: $1, milliseconds: $2, complete: $3) },
                                onFailure: { [weak self, weak active] error in Task { @MainActor in if let active, self?.session === active {
                                    await self?.stopSession(reason: (error as? HostError)?.localizedDescription ?? "采集已中断，请在 Mac 检查显示器与权限。", errorCode: (error as? HostError)?.wireCode)
                                } } })
        active.startingCapture = false
        guard session === active else { await active.capture.stop(); return }
        captureActive = true; hardwareAccelerated = active.capture.hardwareAccelerated; status = "正在共享所选桌面"
    }

    private func stopSession(reason: String, terminal: Bool = false, errorCode: RemoteControlMessage.ErrorCode? = nil) async {
        guard let active = session else { input.releaseAll(); pressedInputs = 0; return }
        isReconfiguring = errorCode == .sessionExpired
        stoppingSession = true; session = nil; active.sender?.stop(); input.releaseAll(); pressedInputs = 0
        let timeout = Task { try? await Task.sleep(nanoseconds: 300_000_000); if !Task.isCancelled { active.control.close() } }
        try? await active.control.send(.init(kind: terminal ? .stop : .error, sessionID: active.id, reason: reason, errorCode: errorCode ?? (terminal ? .hostStopped : nil)))
        let terminalCodes: Set<RemoteControlMessage.ErrorCode> = [.permissionScreenRecording, .displayUnavailable, .authentication, .encoderUnavailable]
        if terminal || errorCode.map({ terminalCodes.contains($0) }) == true {
            let deadline = ProcessInfo.processInfo.systemUptime + 0.3
            while !active.stopAcknowledged, ProcessInfo.processInfo.systemUptime < deadline {
                try? await Task.sleep(nanoseconds: 20_000_000)
            }
        }
        timeout.cancel(); active.control.close()
        active.video?.close(); await active.capture.stop()
        input.releaseAll(); pressedInputs = 0
        captureActive = false; hardwareAccelerated = false; activeDevice = nil; stoppingSession = false; isReconfiguring = false
        // A local service stop during an await owns the final status and listener.
        if isRunning { status = reason }
    }
    private func maintain() async {
        refreshPermissions()
        await recoverNetworkIfNeeded()
        if pairingUntil > 0 { pairingSeconds = max(0, Int(ceil(pairingUntil - ProcessInfo.processInfo.systemUptime))) }
        if pairingUntil > 0, ProcessInfo.processInfo.systemUptime >= pairingUntil {
            closePairing(reason: "二维码已过期，请在 Mac 重新生成并扫码。")
        }
        guard let active = session else { return }
        if ProcessInfo.processInfo.systemUptime - active.lastHeartbeat > 3 { await stopSession(reason: "控制心跳超时，已释放全部输入。"); return }
        if active.wantsViewing && !screenAllowed { await stopSession(reason: "屏幕录制权限已撤销。", errorCode: .permissionScreenRecording); return }
        if input.pressedCount > 0 && !accessibilityAllowed { input.releaseAll(); pressedInputs = 0 }
        let allowed = active.device.controlAllowed && accessibilityAllowed
        if allowed != active.reportedControlAllowed {
            active.reportedControlAllowed = allowed
            do {
                try active.control.sendBestEffort(.init(kind: .display, sessionID: active.id, display: active.display, controlAllowed: allowed, reason: allowed ? nil : "Mac 控制权限不可用，当前为只读。", errorCode: allowed ? nil : .permissionAccessibility))
            } catch {
                await stopSession(reason: "控制通道积压，已释放全部输入。"); return
            }
            guard session === active else { return }
        }
        let currentBounds = CGDisplayBounds(active.display.displayID)
        let expected = active.display.logicalBounds
        if CGDisplayIsActive(active.display.displayID) == 0 {
            await stopSession(reason: "所选显示器已不可用。请在 Mac 本机核对显示器后重新启动。", errorCode: .displayUnavailable); return
        }
        if currentBounds.minX != expected.x || currentBounds.minY != expected.y || currentBounds.width != expected.width || currentBounds.height != expected.height {
            await stopSession(reason: "所选显示器的几何已变化，正在重新建立桌面会话。", errorCode: .sessionExpired); return
        }
        if let stats = active.sender?.stats() {
            frames = stats.frames; droppedFrames = stats.dropped; encodeMilliseconds = stats.last
            encodeSampleCount = stats.samples; encodeP50 = stats.p50; encodeP95 = stats.p95; maximumSendDepth = stats.maximumSendDepth
        }
        let encoderStats = active.capture.stats()
        encoderInFlight = encoderStats.current; encoderMaximumInFlight = encoderStats.maximum; encoderSkipped = encoderStats.skipped
    }
    private static func equalToken(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }; return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
    private static func addressForInterface(_ name: String) -> String? {
        var addresses: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addresses) == 0 else { return nil }; defer { freeifaddrs(addresses) }
        var item = addresses
        while let current = item {
            defer { item = current.pointee.ifa_next }
            guard String(cString: current.pointee.ifa_name) == name, let address = current.pointee.ifa_addr,
                  current.pointee.ifa_flags & UInt32(IFF_UP) != 0,
                  current.pointee.ifa_flags & UInt32(IFF_RUNNING) != 0,
                  address.pointee.sa_family == UInt8(AF_INET) else { continue }
            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(address, socklen_t(address.pointee.sa_len), &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            return String(cString: hostname)
        }
        return nil
    }
}

@MainActor
private final class HostSession {
    let capture = DesktopCapture()
    let id: UUID
    let device: PairedDevice
    let control: RemoteTLSConnection
    let display: RemoteDisplay
    var video: RemoteTLSConnection?
    var sender: VideoSender?
    var wantsViewing = false
    var startingCapture = false
    var lastHeartbeat = ProcessInfo.processInfo.systemUptime
    var inputTimes: [TimeInterval] = []
    var reportedControlAllowed = false
    var stopAcknowledged = false
    init(id: UUID, device: PairedDevice, control: RemoteTLSConnection, display: RemoteDisplay) { self.id = id; self.device = device; self.control = control; self.display = display }
}
