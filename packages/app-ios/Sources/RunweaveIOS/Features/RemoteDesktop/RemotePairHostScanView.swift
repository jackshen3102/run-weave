import Clarity
import RunweaveRemoteDesktop
import SwiftUI
import UIKit

struct RemotePairHostScanView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  @ObservedObject var coordinator: RemoteDesktopCoordinator
  let backendConnections: [BackendConnection]
  @StateObject private var controller: RemotePairHostScanController
  @State private var manual = false
  @State private var backendConnectionID = ""
  @State private var associationFailure: String?

  init(coordinator: RemoteDesktopCoordinator, backendConnections: [BackendConnection]) {
    self.coordinator = coordinator; self.backendConnections = backendConnections
    _controller = StateObject(wrappedValue: RemotePairHostScanController(coordinator: coordinator))
  }

  var body: some View {
    NavigationView {
      ScrollView {
        VStack(spacing: 20) {
          if controller.scanning, phase == .active, !manual {
            QrScannerView(onCode: controller.scanned, onFailure: controller.scannerFailed)
              .frame(height: 300).clipShape(RoundedRectangle(cornerRadius: 16))
          }
          Image(systemName: controller.paired == nil ? "qrcode.viewfinder" : "checkmark.circle.fill")
            .font(.largeTitle).foregroundColor(controller.paired == nil ? .accentColor : .green)
          Text(controller.message).font(.headline).multilineTextAlignment(.center)
          if controller.busy { ProgressView() }
          if let failure = controller.failure {
            Text(failure).foregroundColor(.red).multilineTextAlignment(.center)
            if !controller.scanning, !controller.cameraUnavailable {
              Text("若 Mac 已确认但手机未保存，请在 Mac 撤销该次设备授权后重新配对。")
                .font(.footnote).foregroundColor(.secondary)
            }
          }
          if let paired = controller.paired {
            if !backendConnections.isEmpty {
              DisclosureGroup("关联终端连接（可选）") {
                backendPicker(selection: $backendConnectionID, connections: backendConnections)
              }
            }
            if let associationFailure { Text(associationFailure).foregroundColor(.red) }
            Button("打开桌面") {
              guard saveAssociation(paired) else { return }
              dismiss()
              coordinator.open(coordinator.hosts.first { $0.id == paired.id } ?? paired)
            }.buttonStyle(.borderedProminent).accessibilityIdentifier("remote-pair-open")
            Button("完成") { if saveAssociation(paired) { dismiss() } }
          } else {
            if controller.cameraUnavailable {
              Button("打开系统设置") {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
              }
            }
            if !controller.scanning, !controller.busy {
              Button("重新扫码") { controller.scanAgain() }
            }
            Button("手动填写") { controller.cancel(); manual = true }
              .accessibilityIdentifier("remote-pair-manual")
            Text("在 Mac 打开 Remote Host，启动局域网服务后点击「连接 iPhone」。配对仍需在 Mac 确认。")
              .font(.footnote).foregroundColor(.secondary).multilineTextAlignment(.center)
          }
        }.padding()
      }
      .navigationTitle("扫码配对 Mac").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .navigationBarLeading) {
          Button(controller.paired == nil ? "取消" : "关闭") { controller.cancel(); dismiss() }
        }
      }
      .sheet(isPresented: $manual, onDismiss: {
        if phase == .active { controller.scanAgain() }
      }) {
        RemotePairHostView(coordinator: coordinator, backendConnections: backendConnections,
          onPaired: controller.manuallyPaired)
          .clarityMask().mobileAnalyticsScreen(.remotePairing)
      }
    }
    .navigationViewStyle(.stack).clarityMask()
    .onChange(of: phase) { controller.setScenePhase($0) }
    .onChange(of: controller.paired?.id) { _ in
      backendConnectionID = controller.paired?.backendConnectionID ?? ""
    }
    .onDisappear { controller.cancel() }
  }

  private func saveAssociation(_ paired: PairedRemoteHost) -> Bool {
    guard let current = coordinator.hosts.first(where: { $0.id == paired.id }) else {
      associationFailure = "配对已移除，请重新扫码。"; return false
    }
    let association = backendConnectionID.isEmpty ? nil : backendConnectionID
    guard current.backendConnectionID != association else { return true }
    do {
      try coordinator.save(PairedRemoteHost(target: current.target, backendConnectionID: association))
      associationFailure = nil; return true
    } catch { associationFailure = displayError(error); return false }
  }
}
