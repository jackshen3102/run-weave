import SwiftUI
import AppKit

@main
struct RemoteHostApp: App {
    @NSApplicationDelegateAdaptor(HostAppDelegate.self) private var delegate
    var body: some Scene {
        WindowGroup("RemoteDesk") {
            HostView(model: delegate.model).frame(minWidth: 640, minHeight: 620)
        }
    }
}

@MainActor
private final class HostAppDelegate: NSObject, NSApplicationDelegate {
    let model = HostModel()
    private var startupTask: Task<Void, Never>?
    func applicationDidFinishLaunching(_ notification: Notification) {
        startupTask = Task { await HostStartup.run(model: model) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        startupTask?.cancel()
        Task { await model.stop(); sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
}

private struct HostView: View {
    @ObservedObject var model: HostModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    VStack(alignment: .leading) {
                        Text("RemoteDesk").font(.title2.bold())
                        Text(model.status).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.sharingEnabled { Button("停止全部共享", role: .destructive) { Task { await model.stop() } } }
                    else { Button(HostRuntime.simulatorLoopback ? "启动回环验证服务" : "启动局域网服务") { model.start() }.buttonStyle(.borderedProminent).disabled(model.isReconfiguring || model.isNetworkRecovering) }
                }
                #if DEBUG
                if HostRuntime.simulatorLoopback {
                    Text("模拟器专用验证 · 仅 127.0.0.1:48572 / lo0 · 使用独立身份与配对 · 不接受 LAN；不能替代真机局域网验收。")
                        .font(.callout.bold()).foregroundStyle(.orange)
                }
                #endif
                Text(HostRuntime.simulatorLoopback ? "仅本机模拟器可连接；启动验证服务不会自动采集或控制桌面。" : "只在所选 Wi-Fi / Ethernet 接口监听；启动服务不会自动采集或控制桌面。")
                    .font(.callout).foregroundStyle(.secondary)
                if !model.consoleAvailable { Text("Mac 图形会话已锁定或切换用户，请在本机恢复。远控已停止。") .foregroundStyle(.orange) }
                HostSection("本机权限") {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack { Text("屏幕录制：\(model.screenAllowed ? "已允许" : "未允许")"); Spacer(); Button("请求屏幕录制") { model.requestScreenPermission() } }
                        HStack { Text("辅助功能：\(model.accessibilityAllowed ? "已允许" : "未允许，只读")"); Spacer(); Button("请求辅助功能") { model.requestAccessibilityPermission() } }
                        Text("观察与控制分别授权。权限必须由 Mac 本机用户授予。") .font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                }
                HostSection("局域网端点与身份") {
                    VStack(alignment: .leading, spacing: 8) {
                        Picker(HostRuntime.simulatorLoopback ? "回环接口" : "物理网络接口", selection: $model.selectedInterface) { ForEach(model.interfaceNames, id: \.self) { Text($0).tag($0) } }.disabled(model.sharingEnabled)
                        if !model.endpointAddress.isEmpty { Text("地址：\(model.endpointAddress):\(model.port)").textSelection(.enabled) }
                        if let display = model.lockedDisplayID { Text("已锁定显示器 ID：\(display)；改变目标必须在本机停止并重新启动。") .font(.caption) }
                        if let id = model.hostID { Text("Host ID：\(id.uuidString)").font(.caption.monospaced()).textSelection(.enabled) }
                        if !model.fingerprint.isEmpty { Text("TLS SHA-256：\(model.fingerprint)").font(.caption.monospaced()).textSelection(.enabled) }
                        Text("扫码可自动读取身份；手动配对请核对完整指纹。身份改变时必须重新配对。") .font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                }
                HostSection("新设备配对") {
                    VStack(alignment: .leading, spacing: 8) {
                        if let code = model.pairingCode {
                            if let name = model.pendingName {
                                Text("请求设备：\(name)").bold()
                                Toggle("允许此设备控制键盘与鼠标", isOn: $model.approveControl)
                                HStack { Button("确认配对此设备") { model.approvePairing() }.buttonStyle(.borderedProminent); Button("拒绝", role: .destructive) { model.closePairing() } }
                            } else {
                                if let invitation = model.pairingInvitation {
                                    PairingQRCodeView(invitation: invitation).id(invitation.pairingWindowID)
                                    Text(invitation.name).bold()
                                }
                                Text("在 iPhone 的「Mac 桌面」点击「扫码配对 Mac」。手机需能访问此 Mac。")
                                HStack {
                                    Text("剩余 \(model.pairingSeconds) 秒").monospacedDigit()
                                    Button("重新生成") { model.openPairing() }
                                    Button("取消配对") { model.closePairing() }
                                }
                            }
                            DisclosureGroup("手动配对信息") {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("地址：\(model.endpointAddress):\(model.port)")
                                    Text("TLS SHA-256：\(model.fingerprint)").font(.caption.monospaced())
                                    Text("一次性配对码：\(code)").font(.title.monospaced())
                                }.textSelection(.enabled)
                            }
                            Text("120 秒内有效，最多 3 次尝试；配对仍需在此 Mac 确认。") .font(.caption)
                        } else { Button("连接 iPhone") { model.openPairing() }.disabled(!model.isRunning || model.activeDevice != nil) }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                }
                HostSection("已配对设备") {
                    VStack(alignment: .leading, spacing: 10) {
                        if model.devices.isEmpty { Text("还没有已配对设备").foregroundStyle(.secondary) }
                        ForEach(model.devices) { device in
                            HStack { Text(device.name); Text(device.controlAllowed ? "观察 + 控制" : "只读").font(.caption).foregroundStyle(.secondary); Spacer(); Button("撤销", role: .destructive) { Task { await model.revoke(device) } } }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                }
                if let name = model.activeDevice {
                    HostSection("当前会话") {
                        VStack(alignment: .leading, spacing: 8) {
                            let cancelRecovery = model.isReconfiguring
                            HStack { Text(name).bold(); Spacer(); Button(cancelRecovery ? "取消恢复并停止共享" : "结束此会话", role: .destructive) { Task { await model.stopCurrentSession(cancelRecovery: cancelRecovery) } } }
                            if cancelRecovery { Text("显示几何正在更新；取消恢复将停止整个共享服务。") .font(.caption).foregroundStyle(.orange) }
                            Text("采集：\(model.captureActive ? "运行" : "停止") · 硬件 H.264：\(model.hardwareAccelerated ? "已选中" : "未运行")")
                            Text("帧 \(model.frames) · 丢帧 \(model.droppedFrames) · 编码回调 \(model.encodeMilliseconds, specifier: "%.1f") ms · 按下输入 \(model.pressedInputs)").font(.caption.monospaced())
                            Text("编码样本 \(model.encodeSampleCount)/256 · p50 \(model.encodeP50, specifier: "%.1f") ms · p95 \(model.encodeP95, specifier: "%.1f") ms").font(.caption.monospaced())
                            Text("编码至发送完成 in-flight \(model.encoderInFlight) / 最大 \(model.encoderMaximumInFlight)（上限 1）· 编码跳帧 \(model.encoderSkipped) · 发送队列最大 \(model.maximumSendDepth)（上限 1）").font(.caption.monospaced())
                            Text("这些是编码提交到回调的本机耗时；不是输入到手机像素上屏的端到端延迟。") .font(.caption).foregroundStyle(.secondary)
                            Text("3 秒控制租约；失联、停止与撤销都会释放全部合成输入。") .font(.caption).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                    }
                }
            }.padding(24)
        }
    }
}

private struct HostSection<Content: View>: View {
    let title: LocalizedStringKey
    let content: Content

    init(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        // Labeled GroupBox creates AXTitleUIElement links that crash Sky's tree traversal.
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.headline).accessibilityAddTraits(.isHeader)
                content
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
