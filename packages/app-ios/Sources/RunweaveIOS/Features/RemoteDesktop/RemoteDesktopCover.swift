import Clarity
import RunweaveRemoteDesktop
import SwiftUI

struct RemoteDesktopCover: View {
  @ObservedObject var coordinator: RemoteDesktopCoordinator
  let presentation: RemoteDesktopPresentation
  let returnLabel: String

  var body: some View {
    RemoteDesktopView(session: presentation.session,
      hostName: presentation.host.target.name,
      onClose: { coordinator.close(reason: "user_closed") },
      returnLabel: returnLabel,
      maskTextEntry: { AnyView($0.clarityMask()) })
    .preferredColorScheme(.dark)
    .clarityMask()
    .onAppear { coordinator.presentationAppeared(presentation.id) }
    .onDisappear {
      // Stop this exact presentation even if another root identity is now selected.
      presentation.session.stop(reason: "hidden")
    }
  }
}
