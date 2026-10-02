import Clarity
import IOSBuildIdentity
import SwiftUI

struct EnvironmentPicker: View {
  @ObservedObject var session: SuijiSession
  var body: some View {
    Picker("账户环境", selection: Binding(get: { session.environment }, set: { target in
      Task { await session.switchEnvironment(target) }
    })) {
      ForEach(ConnectionEnvironment.allCases) { Text($0.label).tag($0) }
    }.pickerStyle(.segmented).accessibilityIdentifier("connection-environment")
  }
}

struct AnalyticsDisclosure: View {
  var body: some View {
    Section("使用分析") {
      Text(MobileAnalytics.isEnabled
        ? "此版本使用 Microsoft Clarity 收集交互回放与安装包版本信息，用于改进体验。正文、账号和附件设置为遮盖，内置网页 DOM 采集关闭。"
        : "此版本未启用使用分析。")
        .font(.footnote).foregroundStyle(.secondary)
    }
  }
}

struct ConnectionView: View {
  @ObservedObject var session: SuijiSession
  @State private var password = ""
  @State private var showingBuildIdentity = false
  var body: some View {
    NavigationStack {
      Form {
        Section { Text("随记").font(.largeTitle.bold()); Text("随手记录，慢慢回看。").foregroundStyle(.secondary) }
        Section {
          EnvironmentPicker(session: session)
        } footer: { Text("正式与开发分别保留登录和草稿，切换不会退出账号。") }
        Section("\(session.environment.label)云服务") {
          TextField("https://你的云服务地址", text: $session.endpoint).clarityMask().textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL).accessibilityLabel("云服务地址")
          TextField("账号", text: $session.username).clarityMask().textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.username)
          SecureField("密码", text: $password).clarityMask().textContentType(.password)
          Button("登录") {
            let username = session.username, secret = password; password = ""
            Task { await session.connect(username: username, password: secret) }
          }.disabled(session.username.isEmpty || password.isEmpty || session.endpoint.isEmpty)
          Button("恢复已有登录") { Task { await session.connect() } }.disabled(session.endpoint.isEmpty)
        }.disabled(session.connecting)
        Section { Button("构建信息") { showingBuildIdentity = true } }
        AnalyticsDisclosure()
        if session.connecting { Section { ProgressView("正在连接\(session.environment.label)环境…") } }
        if !session.message.isEmpty { Section { Text(session.message).clarityMask().foregroundStyle(.orange) } }
      }.clarityMask().navigationTitle("\(session.environment.label)账户")
        .sheet(isPresented: $showingBuildIdentity) { BuildIdentityView().clarityMask().mobileAnalyticsScreen(.buildInfo) }
    }.mobileAnalyticsScreen(session.connecting ? .connecting : .login)
  }
}

struct ConnectionSettingsView: View {
  @ObservedObject var session: SuijiSession
  @Environment(\.dismiss) private var dismiss
  @State private var showingBuildIdentity = false
  var body: some View {
    NavigationStack {
      Form {
        Section {
          EnvironmentPicker(session: session)
        } footer: { Text("切换后自动恢复所选环境的登录，另一套账号和草稿会保留。") }
        Section("\(session.environment.label)云服务") {
          Text(session.endpoint).clarityMask()
          Text("已登录\(session.environment.label)环境").foregroundStyle(.secondary)
          Button("更换服务地址") { dismiss(); Task { await session.editConnection() } }
        }
        Section { Button("构建信息") { showingBuildIdentity = true } }
        AnalyticsDisclosure()
        Section {
          Button("退出\(session.environment.label)账户", role: .destructive) { dismiss(); Task { await session.logout() } }
        } footer: { Text("只退出当前环境，保留本机草稿。") }
      }.clarityMask().navigationTitle("连接设置").toolbar { Button("关闭") { dismiss() } }
        .sheet(isPresented: $showingBuildIdentity) { BuildIdentityView().clarityMask().mobileAnalyticsScreen(.buildInfo) }
    }.mobileAnalyticsScreen(.connectionSettings)
  }
}
