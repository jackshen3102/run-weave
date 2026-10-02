import Clarity
import Foundation
import SwiftUI

@MainActor
public enum MobileAnalytics {
  enum Screen: String {
    case connecting, login, records, tasks, trash
    case recordDetail = "record_detail", recordEditor = "record_editor"
    case followups, followupEditor = "followup_editor", aiReview = "ai_review"
    case connectionSettings = "connection_settings", attachmentPreview = "attachment_preview"
    case correction, browser, buildInfo = "build_info", tagPicker = "tag_picker"
  }

  private struct VisibleScreen {
    let id: UUID
    var screen: Screen
    let depth: Int
  }
  private static var initialized = false
  static var isEnabled: Bool { initialized }
  private static var screens: [VisibleScreen] = []
  private static var reportedScreen: Screen?
  private static var reportScheduled = false

  public static func initialize() {
    guard !initialized else { return }
    let settings = Bundle.main.infoDictionary ?? [:]
    guard (settings["SuijiClarityEnabled"] as? String) == "YES",
      let projectID = settings["SuijiClarityProjectID"] as? String,
      !projectID.isEmpty,
      projectID.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) && $0.isASCII })
    else { return }

    // Simulator acceptance must use a separate mobile project, even for Release builds.
    #if targetEnvironment(simulator)
      guard projectID != "yr5biwkeyf" else { return }
    #endif
    initialized = ClaritySDK.initialize(config: ClarityConfig(projectId: projectID))
    guard initialized else { return }
    _ = ClaritySDK.setOnSessionStartedCallback { _ in
      Task { @MainActor in
        for (key, value) in AppBuildMetadata.fields {
          _ = ClaritySDK.setCustomTag(key: key, value: value)
        }
        reportedScreen = nil
        scheduleScreenReport()
      }
    }
  }

  static func appear(id: UUID, screen: Screen, depth: Int) {
    screens.removeAll { $0.id == id }
    screens.append(VisibleScreen(id: id, screen: screen, depth: depth))
    scheduleScreenReport()
  }

  static func disappear(id: UUID) {
    screens.removeAll { $0.id == id }
    scheduleScreenReport()
  }

  // Coalesce appearance/disappearance callbacks from one navigation update.
  private static func scheduleScreenReport() {
    guard initialized, !reportScheduled else { return }
    reportScheduled = true
    Task { @MainActor in
      await Task.yield()
      reportScheduled = false
      reportScreen()
    }
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
  let screen: MobileAnalytics.Screen?
  @Environment(\.mobileAnalyticsDepth) private var depth
  @State private var id = UUID()

  func body(content: Content) -> some View {
    content
      .environment(\.mobileAnalyticsDepth, depth + 1)
      .onAppear { if let screen { MobileAnalytics.appear(id: id, screen: screen, depth: depth) } }
      .onChange(of: screen) { _, value in
        if let value { MobileAnalytics.appear(id: id, screen: value, depth: depth) }
        else { MobileAnalytics.disappear(id: id) }
      }
      .onDisappear { MobileAnalytics.disappear(id: id) }
  }
}

extension View {
  func mobileAnalyticsScreen(_ screen: MobileAnalytics.Screen?) -> some View {
    modifier(MobileAnalyticsScreenModifier(screen: screen))
  }
}
