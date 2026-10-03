import Clarity
import RunweaveRemoteDesktop
import SwiftUI

struct RemoteDesktopCover: View {
  @ObservedObject var coordinator: RemoteDesktopCoordinator
  let presentation: RemoteDesktopPresentation

  var body: some View {
    NavigationView {
      RemoteDesktopView(session: presentation.session,
        maskTextEntry: { AnyView($0.clarityMask()) })
        .clarityMask()
        // Keep UIKit title metadata static; show the Mac identity in masked SwiftUI text.
        .navigationTitle("Mac 桌面")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .principal) {
            Text("桌面 · \(presentation.host.target.name)")
              .font(.headline)
              .lineLimit(1)
              .clarityMask()
          }
          ToolbarItem(placement: .navigationBarLeading) {
            Button("返回") { coordinator.close(reason: "user_closed") }
              .accessibilityIdentifier("remote-desktop-close")
          }
        }
    }
    .navigationViewStyle(.stack)
    .clarityMask()
    .onAppear { coordinator.presentationAppeared(presentation.id) }
    .onDisappear {
      // Stop this exact presentation even if another root identity is now selected.
      presentation.session.setPresentationActive(false)
      presentation.session.stop(reason: "hidden")
    }
  }
}
