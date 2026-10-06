import SwiftUI

struct RemoteStatisticsView: View {
    let statistics: RemoteDesktopStatistics
    var maximumHeight: CGFloat = 230
    var body: some View {
        ScrollView {
            VStack(spacing: 6) {
                Text("连接统计").font(.caption.bold())
                row("接收帧", String(statistics.receivedFrames))
                row("解码帧", String(statistics.decodedFrames))
                row("提交显示层帧", String(statistics.submittedFrames))
                row("丢弃帧", String(statistics.droppedFrames))
                row("恢复请求", String(statistics.recoveryRequests))
                row("视频序号跳变", String(statistics.sequenceGaps))
                row("解码链恢复", String(statistics.decoderRecoveries))
                row("其中队列过载", String(statistics.decoderOverflows))
                row("会话清屏请求", String(statistics.displayImageClears))
                row("解码队列", "\(statistics.decoderQueueDepth) / \(statistics.decoderQueueCapacity)")
                row("最大观察队列", String(statistics.maximumDecoderQueueDepth))
                row("硬件解码", statistics.hardwareDecoder.map { $0 ? "已启用" : "软件解码" } ?? "未知")
                row("显示入口 API", statistics.displayRenderer)
                row("显示入口接受数据", yesNo(statistics.displayAcceptsMediaData))
                row("显示入口进展", statistics.displayIngressState)
                row("显示停滞恢复次数", String(statistics.displayStallRecoveries))
                row("显示层状态", statistics.displayStatus)
                row("显示首帧就绪", statistics.displayReady.map { $0 ? "是" : "否" } ?? "旧系统 · 依据渲染状态")
                row("显示层失败", String(statistics.displayFailures))
                row("显示层错误", statistics.displayErrorCode.map { "\(statistics.displayErrorDomain ?? "") / \($0)" } ?? "无")
                row("显示层需 flush", yesNo(statistics.displayRequiresFlush))
                row("视图已进入窗口", yesNo(statistics.surfaceInWindow))
                row("视图 / 视频层尺寸", "\(size(statistics.viewportSize)) / \(size(statistics.videoLayerSize))")
                row("视频截图保护", yesNo(statistics.preventsCapture))
                row("外部保护遮挡", yesNo(statistics.outputObscured))
                row("解码像素格式", statistics.decodedPixelFormat.map { String(format: "0x%08x", $0) } ?? "未知")
                row("解码 IOSurface", statistics.decodedHasIOSurface.map(yesNo) ?? "未知")
                row("Y 亮度 min / mean / max", statistics.decodedLuminance.map {
                    "\($0.minimum) / \(String(format: "%.1f", $0.mean)) / \($0.maximum)"
                } ?? "未知")
                Text("420v 原始 8-bit Y，名义范围 16–235；每秒最多一次 16×16 网格采样，仅保留聚合值。它不能证明整幅图像或像素上屏。")
                    .font(.caption2).foregroundColor(.secondary)
                row("网络 RTT 当前", milliseconds(statistics.networkRoundTripMilliseconds))
                row("网络 RTT p50 / p95", percentiles(statistics.networkTiming))
                row("网络样本 总数 / 窗口", samples(statistics.networkTiming))
                row("解码回调当前", milliseconds(statistics.decodeMilliseconds))
                row("解码回调 p50 / p95", percentiles(statistics.decodeTiming))
                row("解码样本 总数 / 窗口", samples(statistics.decodeTiming))
                Text("RTT 是网络往返，解码回调是本机耗时；均非输入到像素上屏的端到端延迟。百分位为最近 256 个样本。")
                    .font(.caption2).foregroundColor(.secondary)
            }.font(.caption).padding(10)
        }
        .frame(height: maximumHeight)
        .background(Color.secondary.opacity(0.08))
        .accessibilityIdentifier("remote-desktop-statistics")
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(value).monospacedDigit()
        }.accessibilityElement(children: .combine)
    }
    private func milliseconds(_ value: Double) -> String { String(format: "%.2f ms", value) }
    private func yesNo(_ value: Bool) -> String { value ? "是" : "否" }
    private func size(_ value: CGSize) -> String { "\(Int(value.width))×\(Int(value.height))" }
    private func percentiles(_ value: RemoteTimingSummary) -> String {
        "\(milliseconds(value.p50Milliseconds)) / \(milliseconds(value.p95Milliseconds))"
    }
    private func samples(_ value: RemoteTimingSummary) -> String { "\(value.totalSamples) / \(value.windowSamples)" }
}
