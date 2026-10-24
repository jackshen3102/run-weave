import Clarity
import Foundation
import IOSDiagnostics
import RunweaveBrowser
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
  private static var sessionID: String?
  private static var initializationState = "not_initialized"
  private static var initialized = false
  static var isEnabled: Bool { initialized }
  private static var screens: [VisibleScreen] = []
  private static var reportedScreen: Screen?
  private static var reportScheduled = false

  public static func initialize() {
    ClientDiagnostics.contextProvider = {
      var fields = AppBuildMetadata.fields
      fields["client"] = "suiji-ios"
      let project = Bundle.main.infoDictionary?["SuijiClarityProjectID"] as? String
      fields["analytics_environment"] = project == "yr5biwkeyf" ? "production" : "qa"
      #if DEBUG
        fields["build_configuration"] = "debug"
      #else
        fields["build_configuration"] = "release"
      #endif
      #if targetEnvironment(simulator)
        fields["device_kind"] = "simulator"
      #else
        fields["device_kind"] = "device"
      #endif
      fields["clarity_session_id"] = sessionID ?? "not_started"
      fields["clarity_state"] = initializationState
      return fields
    }
    ClientDiagnostics.onEvent = { event in
      if initialized { _ = ClaritySDK.sendCustomEvent(value: event) }
    }
    let initialization = ClientDiagnosticOperation(.analytics)
    defer { initialization.stage(initialized ? .confirmed : .rejected) }
    guard !initialized else { return }
    initializationState = "disabled_or_invalid_project"
    let settings = Bundle.main.infoDictionary ?? [:]
    guard (settings["SuijiClarityEnabled"] as? String) == "YES",
      let projectID = settings["SuijiClarityProjectID"] as? String,
      !projectID.isEmpty,
      projectID.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) && $0.isASCII })
    else { return }

    // Simulator acceptance must use a separate mobile project, even for Release builds.
    #if targetEnvironment(simulator)
      initializationState = "simulator_excluded"
      guard projectID != "yr5biwkeyf" else { return }
    #endif
    initializationState = "sdk_rejected"
    initialized = ClaritySDK.initialize(config: ClarityConfig(projectId: projectID))
    guard initialized else { return }
    initializationState = "ready"
    _ = ClaritySDK.setOnSessionStartedCallback { id in
      Task { @MainActor in
        sessionID = id.count <= 128 && id.unicodeScalars.allSatisfy { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || "-_.".unicodeScalars.contains($0)) } ? id : nil
        let session = ClientDiagnosticOperation(.analytics)
        var tagsAccepted = true
        for (key, value) in AppBuildMetadata.fields.merging(["diagnostic_launch_id": ClientDiagnostics.launchID], uniquingKeysWith: { _, next in next }) {
          if !ClaritySDK.setCustomTag(key: key, value: value) { tagsAccepted = false }
        }
        session.stage(tagsAccepted ? .confirmed : .failed)
        reportedScreen = nil
        scheduleScreenReport()
      }
    }
  }

  static func observeBrowser(_ browser: BrowserSession) {
    var operations: [UUID: (operation: ClientDiagnosticOperation, visible: Bool, loaded: Bool)] = [:]
    browser.diagnosticEvent = { id, event, error in
      if event == .started {
        if operations.count >= 32 { operations.removeAll() }
        operations[id] = (ClientDiagnosticOperation(.browserOpen), false, false)
        return
      }
      guard var entry = operations[id] else { return }
      let stage: DiagnosticStage
      switch event {
      case .started: return
      case .rejected: stage = .rejected
      case .awaitingConfirmation: stage = .awaitingConfirmation
      case .presentationRequested: stage = .presentationRequested
      case .visible: stage = .uiUpdated; entry.visible = true
      case .loaded: stage = .loaded; entry.loaded = true
      case .failed: stage = .failed
      case .cancelled: stage = .cancelled
      }
      entry.operation.stage(stage, error: error)
      if event == .rejected || event == .failed || event == .cancelled || (entry.visible && entry.loaded) {
        operations.removeValue(forKey: id)
      } else { operations[id] = entry }
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
