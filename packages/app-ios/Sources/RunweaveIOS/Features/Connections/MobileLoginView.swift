import SwiftUI

struct MobileLoginView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  @StateObject private var controller: MobileLoginController

  init(store: ConnectionStore, session: AppSession, onConnected: @escaping () -> Void) {
    _controller = StateObject(wrappedValue: MobileLoginController(store: store, session: session, onConnected: onConnected))
  }

  var body: some View {
    NavigationView {
      ScrollView {
        VStack(spacing: 20) {
          if controller.scanning, phase == .active {
            QrScannerView(onCode: controller.scanned, onFailure: controller.scannerFailed)
              .frame(height: 300).clipShape(RoundedRectangle(cornerRadius: 16))
          }
          Text(controller.message).font(.headline).multilineTextAlignment(.center)
          if controller.busy { ProgressView() }
          if let failure = controller.failure {
            Text(failure).foregroundColor(.red).multilineTextAlignment(.center)
            if controller.scanning {
              Button("打开系统设置") {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
              }
            } else {
              Button(controller.saved ? "重试完成确认" : "重试当前步骤") { controller.retry() }.disabled(controller.busy)
            }
          }
          if controller.saved {
            Button("进入电脑首页") { controller.enterHome() }
          } else if !controller.scanning {
            Button("重新扫码") { controller.scanAgain() }
          }
          Button("返回手动连接") { controller.cancel(); dismiss() }
        }.padding()
      }
      .navigationTitle("扫码连接电脑").navigationBarTitleDisplayMode(.inline)
      .toolbar { Button("取消") { controller.cancel(); dismiss() } }
    }.navigationViewStyle(.stack)
      .onChange(of: phase) { controller.setForeground($0 == .active) }
      .onDisappear { controller.cancel() }
  }
}
