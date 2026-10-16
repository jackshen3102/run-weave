import Clarity
import RunweaveRemoteDesktop
import SwiftUI

struct RemoteDesktopCover: View {
  @ObservedObject var coordinator: RemoteDesktopCoordinator
  @StateObject private var orientation = RemoteDesktopOrientationController()
  @Environment(\.scenePhase) private var scenePhase
  let presentation: RemoteDesktopPresentation
  let returnLabel: String

  var body: some View {
    RemoteDesktopView(session: presentation.session,
      hostName: presentation.host.target.name,
      onClose: { coordinator.close(reason: "user_closed") },
      returnLabel: returnLabel,
      orientationActionTitle: orientation.actionTitle,
      isChangingOrientation: orientation.isChanging,
      onRotate: orientation.toggle,
      maskTextEntry: { AnyView($0.clarityMask()) })
    .background(RemoteDesktopOrientationBridge(controller: orientation))
    .preferredColorScheme(.dark)
    .clarityMask()
    .alert("屏幕方向", isPresented: Binding(
      get: { orientation.errorMessage != nil },
      set: { if !$0 { orientation.errorMessage = nil } }
    )) {
      Button("好") { orientation.errorMessage = nil }
    } message: { Text(orientation.errorMessage ?? "") }
    .onChange(of: scenePhase) { if $0 == .active { orientation.becameActive() } }
    .onAppear { coordinator.presentationAppeared(presentation.id) }
    .onDisappear {
      orientation.restore()
      // Stop this exact presentation even if another root identity is now selected.
      presentation.session.stop(reason: "hidden")
    }
  }
}
