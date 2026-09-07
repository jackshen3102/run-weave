import SwiftUI

public struct RootView: View {
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var connections = ConnectionStore()
  @StateObject private var session = AppSession()
  @State private var managingConnections = false
  @AppStorage("native.theme") private var theme = "dark"

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
        NavigationLink(
          isActive: Binding(
            get: { session.terminal != nil },
            set: { if !$0 { session.closeTerminal() } })
        ) {
          if let details = session.terminal, let controller = session.terminalController {
            TerminalScreen(session: session, controller: controller, details: details)
          }
        } label: {
          EmptyView()
        }
        .hidden()
      }
      .navigationTitle(session.authenticated ? "Runweave" : "Sign in")
      .toolbar {
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
            }
          }.accessibilityLabel("连接管理")
        }
      }
    }
    .navigationViewStyle(.stack)
    .preferredColorScheme(theme == "light" ? .light : .dark)
    .id(connections.active?.scope)
    .task(id: connections.active?.scope) { await session.activate(connections.active) }
    .onAppear { if connections.active == nil { managingConnections = true } }
    .onChange(of: scenePhase) { phase in session.setForeground(phase == .active) }
    .sheet(isPresented: $managingConnections) {
      ConnectionManager(store: connections, session: session)
    }
  }
}

private struct LoginView: View {
  @ObservedObject var session: AppSession
  let manageConnections: () -> Void
  @State private var username = "admin"
  @State private var password = ""
  @State private var submitting = false
  @State private var failure: String?

  var body: some View {
    Form {
      Section(header: Text("Runweave")) {
        if session.connection == nil { Button("先添加一个 Runweave 后端连接", action: manageConnections) }
        TextField("Username", text: $username).textContentType(.username).autocapitalization(.none)
          .disableAutocorrection(true)
        SecureField("Password", text: $password).textContentType(.password)
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
      if let message = failure ?? session.error { Section { Text(message).foregroundColor(.red) } }
      if session.health.status == .offline {
        Section {
          Text(session.health.message)
          Button("重新检测") { Task { await session.refresh() } }
        }
      }
    }
  }
}
