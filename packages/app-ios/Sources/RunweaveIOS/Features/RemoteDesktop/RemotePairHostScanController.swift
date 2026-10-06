import Foundation
import RunweaveRemoteDesktop
import SwiftUI

@MainActor
final class RemotePairHostScanController: ObservableObject {
  @Published private(set) var scanning = true
  @Published private(set) var busy = false
  @Published private(set) var paired: PairedRemoteHost?
  @Published private(set) var message = "将相机对准自己 Mac 的 RemoteDesk 配对二维码"
  @Published private(set) var failure: String?
  @Published private(set) var cameraUnavailable = false
  private let coordinator: RemoteDesktopCoordinator
  private var foreground = true
  private var resumeScanner = false
  private var generation = 0
  private var operation: Task<Void, Never>?

  init(coordinator: RemoteDesktopCoordinator) { self.coordinator = coordinator }

  func scanned(_ text: String) -> Bool {
    guard scanning, foreground, !cameraUnavailable, operation == nil, paired == nil else { return false }
    do {
      var allowLoopback = false
      #if DEBUG && targetEnvironment(simulator)
      allowLoopback = true
      #endif
      let invitation = try RemotePairingQR.parse(text, allowSimulatorLoopback: allowLoopback)
      scanning = false; busy = true; failure = nil
      message = "正在连接 \(invitation.name)…"
      let epoch = generation
      let hostEpoch = coordinator.generation
      operation = Task { @MainActor [weak self] in
        guard let self else { return }
        defer {
          if self.generation == epoch { self.busy = false; self.operation = nil }
        }
        do {
          let target = try await RemotePairingClient().pair(invitation: invitation,
            deviceName: "Runweave iPhone", onWaitingForConfirmation: { [weak self] in
              guard let self, self.generation == epoch, self.foreground,
                self.coordinator.generation == hostEpoch, !Task.isCancelled else { return }
              self.message = "请在 \(invitation.name) 上确认配对"
            })
          guard self.generation == epoch, self.foreground,
            self.coordinator.generation == hostEpoch, !Task.isCancelled else {
            try? RemoteCredentialStore().forget(target: target)
            return
          }
          self.paired = try self.coordinator.savePairing(target)
          self.message = "已配对 \(target.name)"
        } catch {
          guard self.generation == epoch, self.foreground,
            !(error is CancellationError), !Task.isCancelled else { return }
          self.message = "配对未完成"
          self.failure = displayError(error)
        }
      }
      return true
    } catch {
      failure = error.localizedDescription
      return false
    }
  }

  func scannerFailed(_ message: String) {
    guard scanning, foreground else { return }
    cameraUnavailable = true; scanning = false; failure = message
    self.message = "无法使用相机"
  }

  func manuallyPaired(_ host: PairedRemoteHost) {
    cancel()
    paired = host; failure = nil
    message = "已配对 \(host.target.name)"
  }

  func scanAgain() {
    guard foreground, paired == nil else { return }
    cancel()
    cameraUnavailable = false; failure = nil; scanning = true
    message = "将相机对准自己 Mac 的 RemoteDesk 配对二维码"
  }

  func cancel() {
    generation += 1
    operation?.cancel(); operation = nil
    scanning = false; busy = false
  }

  func setScenePhase(_ phase: ScenePhase) {
    switch phase {
    case .active:
      foreground = true
      if resumeScanner { resumeScanner = false; scanAgain() }
    case .inactive:
      // The camera permission alert is transient inactivity, not leaving the flow.
      resumeScanner = scanning
      foreground = false
      cancel()
      if !resumeScanner, paired == nil { message = "配对已暂停，请重新扫码" }
    case .background:
      resumeScanner = false; foreground = false; cancel()
      if paired == nil { message = "配对已暂停，请重新扫码" }
    @unknown default: foreground = false; cancel()
    }
  }
}
