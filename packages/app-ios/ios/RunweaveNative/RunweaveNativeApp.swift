import RunweaveIOS
import SwiftUI

@main
struct RunweaveNativeApp: App {
  @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var notifications
  #if NATIVE_DIAGNOSTICS
    @State private var showingTerminalLab =
      ProcessInfo.processInfo.arguments.contains("--native-terminal-lab")
  #endif

  var body: some Scene {
    WindowGroup {
      #if NATIVE_DIAGNOSTICS
        if showingTerminalLab {
          NavigationView {
            TerminalProbe()
              .navigationTitle("终端实验室")
              .navigationBarTitleDisplayMode(.inline)
              .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                  Button("返回首页") { showingTerminalLab = false }
                }
              }
          }
          .navigationViewStyle(.stack)
        } else {
          RootView()
        }
      #else
        RootView()
      #endif
    }
  }
}
