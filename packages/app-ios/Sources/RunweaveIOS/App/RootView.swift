import Clarity
import SwiftUI
import IOSBuildIdentity

public struct RootView: View {
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var connections = ConnectionStore()
  @StateObject private var session = AppSession()
  @StateObject private var quickInputs = BackendQuickInputModel()
  @StateObject private var codexQuota = CodexQuotaStore()
  @StateObject private var remoteDesktop = RemoteDesktopCoordinator()
  @ObservedObject private var notifications = NotificationCoordinator.shared
  @State private var managingConnections = false
  @State private var mobileLoginRevision = 0
  @AppStorage(DevicePreferences.themeKey, store: DevicePreferences.store) private var theme = "dark"

  public init() {}

  public var body: some View {
    NavigationView {
      Group {
        if session.checking {
          ProgressView("正在连接…")
        } else if session.authenticated {
          HomeView(session: session)
        } else {
          LoginView(session: session, manageConnections: { managingConnections = true })
        }
      }
      .background {
        NavigationLink(isActive: Binding(
          get: { session.showingScheduledTasks || session.showingEnergyMonitor || session.terminal != nil },
          set: { if !$0 { session.closeTerminal(); session.showingScheduledTasks = false; session.showingEnergyMonitor = false } }
        )) {
          if session.showingScheduledTasks {
            ScheduledTasksView(session: session, manageConnections: { managingConnections = true }).id(session.generation)
          } else if session.showingEnergyMonitor {
            ResourceMonitorView(session: session).id(session.generation)
          } else if let details = session.terminal, let controller = session.terminalController {
            TerminalScreen(session: session, controller: controller, details: details)
              .id("\(session.generation):\(details.id):\(details.projectId)")
          }
        } label: { EmptyView() }.hidden()
      }
      .navigationTitle(session.authenticated ? "Runweave" : "Sign in")
      .toolbar {
        ToolbarItem(placement: .navigationBarTrailing) {
          if session.checking || !session.authenticated {
            Button { remoteDesktop.managingHosts = true } label: { Image(systemName: "display") }
              .accessibilityLabel("Mac 桌面")
              .accessibilityIdentifier("remote-desktop-hosts")
          }
        }
        ToolbarItem(placement: .navigationBarLeading) {
          Button {
            managingConnections = true
          } label: {
            HStack(spacing: 5) {
              Circle().fill(
                session.health.status == .online
                  ? Color.green : session.health.status == .offline ? Color.red : Color.orange
              ).frame(width: 7, height: 7)
              Text(connections.active?.name ?? "选择电脑").lineLimit(1)
              if session.authenticated { DeviceBatteryView(device: session.deviceStatus, compact: true) }
            }
          }.accessibilityLabel("连接管理")
        }
      }
    }
    .navigationViewStyle(.stack)
    .preferredColorScheme(theme == "light" ? .light : .dark)
    .id(connections.active?.scope)
    .task(id: "\(connections.active?.scope ?? ""):\(mobileLoginRevision)") { await session.activate(connections.active) }
    .onAppear {
      remoteDesktop.setScenePhase(scenePhase)
      if connections.active == nil { managingConnections = true }
      notifications.consume(in: connections)
      Task { await notifications.openPendingScheduledRun(in: session, store: connections) }
      notifications.foreground(connections: connections.connections)
    }
    .onChange(of: session.generation) { _ in
      codexQuota.reset(); quickInputs.reset()
      remoteDesktop.invalidate(reason: "backend_session_changed")
    }
    .onChange(of: session.authenticated) { authenticated in
      if !authenticated {
        codexQuota.reset(); quickInputs.reset()
        remoteDesktop.invalidate(reason: "backend_logged_out")
      }
      else {
        notifications.refreshAutomaticTasks(connections: connections.connections)
        Task { await notifications.openPendingScheduledRun(in: session, store: connections) }
      }
    }
    .onChange(of: connections.connections.map(\.scope).joined(separator: "|")) { _ in
      notifications.refreshAutomaticTasks(connections: connections.connections)
    }
    .onChange(of: notifications.pendingHostID) { _ in
      notifications.consume(in: connections)
      Task { await notifications.openPendingScheduledRun(in: session, store: connections) }
    }
    .onChange(of: connections.active?.scope) { _ in
      remoteDesktop.invalidate(reason: "computer_changed")
      Task { await notifications.openPendingScheduledRun(in: session, store: connections) }
    }
    .onChange(of: session.health.status) { _ in
      Task { await notifications.openPendingScheduledRun(in: session, store: connections) }
    }
    .alert("电脑提醒", isPresented: Binding(get: { notifications.message != nil }, set: { if !$0 { notifications.message = nil } })) {
      Button("好") { notifications.message = nil }
    } message: { Text(notifications.message ?? "") }
    .onChange(of: scenePhase) { phase in
      session.setScenePhase(phase)
      remoteDesktop.setScenePhase(phase)
      if phase == .active { notifications.foreground(connections: connections.connections) }
      else { notifications.suspend() }
    }
    .sheet(isPresented: $managingConnections) {
      ConnectionManager(store: connections, session: session, codexQuota: codexQuota) {
        managingConnections = false
        mobileLoginRevision += 1
      }.mobileAnalyticsScreen(.connections)
    }
    .sheet(isPresented: $remoteDesktop.managingHosts, onDismiss: remoteDesktop.managerDismissed) {
      RemoteHostManager(coordinator: remoteDesktop, backendConnections: connections.connections)
        .clarityMask().mobileAnalyticsScreen(.remoteHosts)
    }
    .fullScreenCover(item: Binding(
      get: { remoteDesktop.presentation },
      set: { if $0 == nil { remoteDesktop.close(reason: "hidden") } }
    )) { presentation in
      RemoteDesktopCover(coordinator: remoteDesktop, presentation: presentation,
        returnLabel: session.terminal != nil ? "返回终端" : "返回")
        .clarityMask().mobileAnalyticsScreen(.remoteDesktop)
    }
    .mobileAnalyticsScreen(session.checking ? .connecting : session.authenticated ? .home : .login)
    .environmentObject(quickInputs)
    .environmentObject(remoteDesktop)
  }
}

private struct LoginView: View {
  @ObservedObject var session: AppSession
  let manageConnections: () -> Void
  @State private var username = "admin"
  @State private var password = ""
  @State private var submitting = false
  @State private var showingBuildIdentity = false
  @State private var failure: String?

  var body: some View {
    Form {
      Section(header: Text("Runweave")) {
        if session.connection == nil { Button("先添加一个 Runweave 后端连接", action: manageConnections) }
        TextField("Username", text: $username).textContentType(.username).autocapitalization(.none)
          .disableAutocorrection(true).clarityMask()
        SecureField("Password", text: $password).textContentType(.password).clarityMask()
        Button {
          submitting = true
          failure = nil
          Task {
            do {
              try await session.login(username: username, password: password)
              password = ""
            } catch { if !(error is CancellationError) { failure = displayError(error) } }
            submitting = false
          }
        } label: {
          if submitting { ProgressView() } else { Text("Login") }
        }
        .disabled(
          submitting || session.connection == nil
            || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)
      }.disabled(submitting)
      Section { Button("构建信息") { showingBuildIdentity = true } }
      if let message = failure ?? session.error { Section { Text(message).foregroundColor(.red) } }
      if session.health.status == .offline {
        Section {
          if session.health.message != (failure ?? session.error) {
            Text(session.health.message)
          }
          Button("重新检测") { Task { await session.refresh() } }
        }
      }
    }.sheet(isPresented: $showingBuildIdentity) { BuildIdentityView().mobileAnalyticsScreen(.buildInfo) }
  }
}
