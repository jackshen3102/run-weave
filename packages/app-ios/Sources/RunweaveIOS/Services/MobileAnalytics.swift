import Clarity
import Foundation
import SwiftUI

@MainActor
public enum MobileAnalytics {
  enum Screen: String {
    case connecting, login, home, connections, configuration, mobileLogin = "mobile_login"
    case terminalChat = "terminal_chat", terminalFiles = "terminal_files", terminalChanges = "terminal_changes"
    case composer, quickReplies = "quick_replies", quickReplyEditor = "quick_reply_editor"
    case scheduledTasks = "scheduled_tasks", scheduledTaskEditor = "scheduled_task_editor"
    case browser, filePreview = "file_preview", history, terminalInfo = "terminal_info", diagnostics
    case buildInfo = "build_info", codexQuota = "codex_quota", share, newProject = "new_project", renameTerminal = "rename_terminal"
  }

  private struct VisibleScreen {
    let id: UUID
    var screen: Screen
    let depth: Int
  }
  private static var initialized = false
  private static var screens: [VisibleScreen] = []
  private static var reportedScreen: Screen?

  public static func initialize() {
    guard !initialized else { return }
    let settings = Bundle.main.infoDictionary ?? [:]
    guard (settings["RunweaveClarityEnabled"] as? String) == "YES",
      let projectID = settings["RunweaveClarityProjectID"] as? String,
      !projectID.isEmpty,
      projectID.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) && $0.isASCII })
    else { return }

    // Simulator acceptance must use a separate mobile project, even for Release builds.
    #if targetEnvironment(simulator)
      guard projectID != "yofefg4fsy" else { return }
    #endif
    initialized = ClaritySDK.initialize(config: ClarityConfig(projectId: projectID))
    guard initialized else { return }
    _ = ClaritySDK.setOnSessionStartedCallback { _ in
      Task { @MainActor in
        for (key, value) in AppBuildMetadata.fields {
          _ = ClaritySDK.setCustomTag(key: key, value: value)
        }
        reportedScreen = nil
        reportScreen()
      }
    }
  }

  static func appear(id: UUID, screen: Screen, depth: Int) {
    screens.removeAll { $0.id == id }
    screens.append(VisibleScreen(id: id, screen: screen, depth: depth))
    reportScreen()
  }

  static func update(id: UUID, screen: Screen) {
    guard let index = screens.firstIndex(where: { $0.id == id }) else { return }
    screens[index].screen = screen
    reportScreen()
  }

  static func disappear(id: UUID) {
    screens.removeAll { $0.id == id }
    reportScreen()
  }

  private static func reportScreen() {
    let depth = screens.map(\.depth).max()
    let screen = screens.last { $0.depth == depth }?.screen
    guard initialized, screen != reportedScreen else { return }
    if ClaritySDK.setCurrentScreenName(screen?.rawValue) { reportedScreen = screen }
  }
}

private struct MobileAnalyticsDepthKey: EnvironmentKey {
  static let defaultValue = 0
}

extension EnvironmentValues {
  var mobileAnalyticsDepth: Int {
    get { self[MobileAnalyticsDepthKey.self] }
    set { self[MobileAnalyticsDepthKey.self] = newValue }
  }
}

private struct MobileAnalyticsScreenModifier: ViewModifier {
  let screen: MobileAnalytics.Screen
  @Environment(\.mobileAnalyticsDepth) private var depth
  @State private var id = UUID()

  func body(content: Content) -> some View {
    content
      .environment(\.mobileAnalyticsDepth, depth + 1)
      .onAppear { MobileAnalytics.appear(id: id, screen: screen, depth: depth) }
      .onChange(of: screen) { MobileAnalytics.update(id: id, screen: $0) }
      .onDisappear { MobileAnalytics.disappear(id: id) }
  }
}

extension View {
  func mobileAnalyticsScreen(_ screen: MobileAnalytics.Screen) -> some View {
    modifier(MobileAnalyticsScreenModifier(screen: screen))
  }
}
