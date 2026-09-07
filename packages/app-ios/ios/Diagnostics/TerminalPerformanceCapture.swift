#if NATIVE_DIAGNOSTICS
  import Combine
  import Darwin
  import RunweaveIOS
  import UIKit

  /// Bounded, opt-in Profile evidence. Contains byte counts and timings, never terminal content.
  @MainActor
  final class TerminalPerformanceCapture: ObservableObject {
    @Published private(set) var running = false
    @Published private(set) var status = "性能采样未开始"
    private weak var controller: SessionController?
    private var subscriptions = Set<AnyCancellable>()
    private var timer: Timer?
    private var started = 0.0
    private var baseReceived = 0
    private var baseConsumed = 0
    private var received = 0
    private var committed = 0
    private var queuePeak = 0
    private var pending: [(end: Int, at: Double)] = []
    private var pendingInput: [Double] = []
    private var outputLatency: [[Double]] = []
    private var inputLatency: [Double] = []
    private var memorySamples: [[Double]] = []
    private var lastReceipt = 0.0
    private var lastCommit = 0.0
    private var failure: String?
    private var previousIdleTimerDisabled = false
    private var writes = DispatchQueue(label: "native.profile.evidence", qos: .utility)

    func start(_ controller: SessionController) {
      guard !running, controller.canSend, controller.queuedBytes == 0 else { return }
      self.controller = controller
      started = ProcessInfo.processInfo.systemUptime
      baseReceived = controller.receivedBytes
      baseConsumed = controller.surface.consumedBytes
      received = 0
      committed = 0
      queuePeak = 0
      pending = []
      pendingInput = []
      outputLatency = []
      inputLatency = []
      memorySamples = []
      lastReceipt = 0
      lastCommit = 0
      failure = nil
      guard
        controller.surface.observeDisplayCommits({ [weak self] bytes, at in
          self?.didCommit(bytes: bytes, at: at)
        })
      else {
        status = "显示提交计量需要 iOS 18+ 与 CoreGraphics"
        return
      }
      running = true
      previousIdleTimerDisabled = UIApplication.shared.isIdleTimerDisabled
      UIApplication.shared.isIdleTimerDisabled = true
      status = "正在采样 · 最长 11 分钟"
      controller.$receivedBytes.sink { [weak self] total in
        guard let self, self.running, total > self.baseReceived + self.received else { return }
        self.received = total - self.baseReceived
        let now = ProcessInfo.processInfo.systemUptime
        self.lastReceipt = now - self.started
        self.pending.append((self.received, now))
      }.store(in: &subscriptions)
      controller.$queuedBytes.sink { [weak self] value in
        guard let self else { return }
        self.queuePeak = max(self.queuePeak, value)
      }.store(in: &subscriptions)
      controller.$connectionStatus.sink { [weak self] value in
        guard let self, self.running, value != "已连接" else { return }
        self.failure = "采样期间连接状态改变：\(value)"
        self.stop()
      }.store(in: &subscriptions)
      for name in [UITextView.textDidChangeNotification, UITextField.textDidChangeNotification] {
        NotificationCenter.default.publisher(for: name).sink { [weak self] notification in
          guard let self, self.running, let view = notification.object as? UIView,
            view.window === controller.surface.view.window
          else { return }
          let notified = ProcessInfo.processInfo.systemUptime
          self.pendingInput.append(
            min(controller.surface.eventDispatchStartedAt ?? notified, notified))
        }.store(in: &subscriptions)
      }
      timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
        Task { @MainActor in
          guard let self, self.running else { return }
          if ProcessInfo.processInfo.systemUptime - self.started >= 660 {
            self.stop()
          } else {
            self.save()
          }
        }
      }
      save()
    }

    func stop() {
      guard running else { return }
      running = false
      UIApplication.shared.isIdleTimerDisabled = previousIdleTimerDisabled
      timer?.invalidate()
      timer = nil
      subscriptions.removeAll()
      controller?.surface.observeDisplayCommits(nil)
      status = failure ?? "正在保存性能采样"
      save()
    }

    private func didCommit(bytes: Int, at: Double) {
      guard running else { return }
      let total = bytes - baseConsumed
      if total > committed {
        committed = total
        lastCommit = at - started
        let count = pending.prefix { $0.end <= total }.count
        for item in pending.prefix(count) {
          outputLatency.append([item.at - started, (at - item.at) * 1000])
        }
        pending.removeFirst(count)
      }
      inputLatency.append(contentsOf: pendingInput.map { (at - $0) * 1000 })
      pendingInput.removeAll(keepingCapacity: true)
    }

    private func save() {
      guard let controller else { return }
      var info = mach_task_basic_info()
      var count = mach_msg_type_number_t(
        MemoryLayout<mach_task_basic_info>.size / MemoryLayout<integer_t>.size)
      let result = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
          task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
        }
      }
      if result == KERN_SUCCESS {
        memorySamples.append([
          ProcessInfo.processInfo.systemUptime - started, Double(info.resident_size),
        ])
      } else {
        failure = "进程 RSS 采样失败：\(result)"
      }
      let terminal = controller.surface.terminalView.getTerminal()
      let payload: [String: Any] = [
        "running": running, "elapsedSeconds": ProcessInfo.processInfo.systemUptime - started,
        "renderer": controller.surface.renderer, "cols": terminal.cols, "rows": terminal.rows,
        "fontPoints": 14, "scrollback": 5000, "receivedBytes": received,
        "committedBytes": committed, "queuedBytes": controller.queuedBytes,
        "queuePeakBytes": queuePeak, "pendingReceipts": pending.count,
        "lastReceiptSeconds": lastReceipt, "lastCommitSeconds": lastCommit,
        "receiptSecondsAndCommitLatencyMs": outputLatency, "inputCommitLatencyMs": inputLatency,
        "secondsAndResidentBytes": memorySamples,
        "memoryMeasurement":
          "MACH_TASK_BASIC_INFO resident_size for this app process, sampled every five seconds; includes measurement overhead",
        "failure": failure ?? controller.failure ?? "",
        "measurement":
          "Decoded output byte-count notification to UIKit afterCATransactionCommit after SwiftTerm range invalidation; excludes WebSocket JSON decoding; not photon latency",
        "inputMeasurement":
          "UIKit beforeEventDispatch of the text-change update to afterCATransactionCommit; excludes OS keyboard delivery before app dispatch",
      ]
      guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
      else {
        status = "性能证据编码失败"
        return
      }
      let url = FileManager.default.temporaryDirectory.appendingPathComponent(
        "native-performance-current.json")
      let captureStarted = started
      writes.async { [weak self] in
        do {
          try data.write(to: url, options: .atomic)
          Task { @MainActor in
            guard let self, self.started == captureStarted, !self.running else { return }
            self.status = self.failure ?? "采样已保存 · native-performance-current.json"
          }
        } catch {
          Task { @MainActor in
            guard let self, self.started == captureStarted else { return }
            self.failure = "性能证据保存失败：\(error.localizedDescription)"
            self.status = self.failure ?? "性能证据保存失败"
          }
        }
      }
    }
  }
#endif
