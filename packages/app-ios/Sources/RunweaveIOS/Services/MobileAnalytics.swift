import Clarity
import Foundation
import IOSDiagnostics
import RunweaveBrowser
import SwiftUI

@MainActor
public enum MobileAnalytics {
  enum Screen: String {
    case connecting, login, home, connections, configuration, mobileLogin = "mobile_login"
    case terminalChat = "terminal_chat", terminalFiles = "terminal_files", terminalChanges = "terminal_changes"
    case conversationReader = "conversation_reader", sideChat = "side_chat"
    case taskSupervision = "task_supervision"
    case settings
    case developmentResources = "development_resources"
    case composer, quickReplies = "quick_replies", quickReplyEditor = "quick_reply_editor"
    case scheduledTasks = "scheduled_tasks", scheduledTaskEditor = "scheduled_task_editor"
    case browser, filePreview = "file_preview", history, terminalInfo = "terminal_info", diagnostics
    case remoteDesktop = "remote_desktop", remoteHosts = "remote_hosts", remotePairing = "remote_pairing"
    case remoteHostEditor = "remote_host_editor", remoteUsage = "remote_usage", remoteUsageDetail = "remote_usage_detail"
    case buildInfo = "build_info", codexQuota = "codex_quota", share, newProject = "new_project", renameTerminal = "rename_terminal"
  }

  private struct VisibleScreen {
    let id: UUID
    var screen: Screen
    let depth: Int
  }
  private static var initializationState = "not_initialized"
  private static var initialized = false
  private static var screens: [VisibleScreen] = []
  private static var reportedScreen: Screen?
  private static var reportScheduled = false
  private static var sessionID: String?
  // Keep aligned with the exact clarity-apps dependency in Package.swift.
  private static let sdkVersion = "4.1.0"

  enum RemoteEvent: String {
    case opened = "remote_opened", visible = "remote_visible", inputSent = "remote_input_sent"
    case closed = "remote_closed", paired = "remote_paired"
  }

  /// Coarse event counts only; exact per-use joins live in the local remote usage archive.
  static func remoteEvent(_ event: RemoteEvent) {
    guard initialized else { return }
    let accepted = ClaritySDK.sendCustomEvent(value: event.rawValue)
    diagnostic("clarity.event", ["event": event.rawValue, "accepted": String(accepted)])
  }

  public static func initialize() {
    ClientDiagnostics.contextProvider = {
      var fields = AppBuildMetadata.fields
      fields["client"] = "runweave-ios"
      let project = Bundle.main.infoDictionary?["RunweaveClarityProjectID"] as? String
      fields["analytics_environment"] = project == "yofefg4fsy" ? "production" : "qa"
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
    guard (settings["RunweaveClarityEnabled"] as? String) == "YES" else {
      diagnostic("clarity.initialize.skipped", ["reason": "disabled"])
      return
    }
    guard let projectID = settings["RunweaveClarityProjectID"] as? String,
      !projectID.isEmpty,
      projectID.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) && $0.isASCII })
    else {
      diagnostic("clarity.initialize.skipped", ["reason": "invalid_project"])
      return
    }

    // Simulator acceptance must use a separate mobile project, even for Release builds.
    #if targetEnvironment(simulator)
      initializationState = "simulator_excluded"
      guard projectID != "yofefg4fsy" else {
        diagnostic("clarity.initialize.skipped", ["reason": "production_project_on_simulator"])
        return
      }
    #endif
    initializationState = "sdk_rejected"
    initialized = ClaritySDK.initialize(config: ClarityConfig(projectId: projectID))
    diagnostic("clarity.initialize", ["projectId": projectID, "accepted": String(initialized)])
    guard initialized else { return }
    initializationState = "ready"
    let registered = ClaritySDK.setOnSessionStartedCallback { id in
      Task { @MainActor in
        // Retain the opaque SDK identifier for replay correlation, never its token-bearing URL.
        sessionID = id.count <= 128 && !id.isEmpty && id.unicodeScalars.allSatisfy {
          $0.isASCII && (CharacterSet.alphanumerics.contains($0) || "-_.".unicodeScalars.contains($0))
        } ? id : nil
        var failedTags: [String] = []
        for (key, value) in AppBuildMetadata.fields.merging(["diagnostic_launch_id": ClientDiagnostics.launchID], uniquingKeysWith: { _, next in next }) {
          if !ClaritySDK.setCustomTag(key: key, value: value) { failedTags.append(key) }
        }
        ClientDiagnosticOperation(.analytics).stage(failedTags.isEmpty ? .confirmed : .failed)
        diagnostic("clarity.session.started", ["projectId": projectID,
          "failedBuildTags": failedTags.sorted().joined(separator: ",")])
        reportedScreen = nil
        scheduleScreenReport()
      }
    }
    diagnostic("clarity.session.callback", ["registered": String(registered)])
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

  static func update(id: UUID, screen: Screen) {
    guard let index = screens.firstIndex(where: { $0.id == id }) else { return }
    screens[index].screen = screen
    scheduleScreenReport()
  }

  static func disappear(id: UUID) {
    screens.removeAll { $0.id == id }
    scheduleScreenReport()
  }

  // Navigation can remove and insert visible views in the same update. Report only
  // the settled hierarchy instead of briefly attributing the transition to its parent.
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
    let accepted = ClaritySDK.setCurrentScreenName(screen?.rawValue)
    diagnostic("clarity.screen", ["previousScreen": reportedScreen?.rawValue ?? "none",
      "screen": screen?.rawValue ?? "none", "depth": depth.map(String.init) ?? "none",
      "visibleScreenCount": String(screens.count), "accepted": String(accepted)])
    if accepted { reportedScreen = screen }
  }

  private static func diagnostic(_ message: String, _ details: [String: String]) {
    var fields = details
    fields["sdkVersion"] = sdkVersion
    fields["sessionId"] = sessionID ?? "not_started"
    fields["sdkPaused"] = initialized ? String(ClaritySDK.isPaused()) : "not_initialized"
    DiagnosticStore.shared.append(scope: DiagnosticStore.analyticsScope, .analytics(message, details: fields))
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
