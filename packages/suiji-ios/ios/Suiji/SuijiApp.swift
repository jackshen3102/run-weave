import SwiftUI
import SuijiIOS
@main struct SuijiApp: App {
  init() { MobileAnalytics.initialize() }
  var body: some Scene { WindowGroup { SuijiRootView() } }
}
