import RunweaveIOS
import SwiftUI

@main
struct RunweaveNativeApp: App {
  var body: some Scene {
    WindowGroup {
      #if NATIVE_DIAGNOSTICS
        TabView {
          RootView().tabItem { Label("首页", systemImage: "house") }
          TerminalProbe().tabItem { Label("终端验证", systemImage: "waveform.path.ecg") }
        }
      #else
        RootView()
      #endif
    }
  }
}
