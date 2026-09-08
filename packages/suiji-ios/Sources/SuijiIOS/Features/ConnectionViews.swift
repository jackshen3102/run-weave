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

struct ConnectionView: View {
  @ObservedObject var session: SuijiSession
  @State private var password = ""
  var body: some View {
    NavigationStack {
      Form {
        Section { Text("随记").font(.largeTitle.bold()); Text("随手记录，慢慢回看。").foregroundStyle(.secondary) }
        Section {
          EnvironmentPicker(session: session)
        } footer: { Text("正式与开发分别保留登录和草稿，切换不会退出账号。") }
        Section("\(session.environment.label)云服务") {
          TextField("https://你的云服务地址", text: $session.endpoint).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL).accessibilityLabel("云服务地址")
          TextField("账号", text: $session.username).textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.username)
          SecureField("密码", text: $password).textContentType(.password)
          Button("登录") {
            let username = session.username, secret = password; password = ""
            Task { await session.connect(username: username, password: secret) }
          }.disabled(session.username.isEmpty || password.isEmpty || session.endpoint.isEmpty)
          Button("恢复已有登录") { Task { await session.connect() } }.disabled(session.endpoint.isEmpty)
        }.disabled(session.connecting)
        if session.connecting { Section { ProgressView("正在连接\(session.environment.label)环境…") } }
        if !session.message.isEmpty { Section { Text(session.message).foregroundStyle(.orange) } }
      }.navigationTitle("\(session.environment.label)账户")
    }
  }
}

struct ConnectionSettingsView: View {
  @ObservedObject var session: SuijiSession
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      Form {
        Section {
          EnvironmentPicker(session: session)
        } footer: { Text("切换后自动恢复所选环境的登录，另一套账号和草稿会保留。") }
        Section("\(session.environment.label)云服务") {
          Text(session.endpoint)
          Text("已登录\(session.environment.label)环境").foregroundStyle(.secondary)
          Button("更换服务地址") { dismiss(); Task { await session.editConnection() } }
        }
        Section {
          Button("退出\(session.environment.label)账户", role: .destructive) { dismiss(); Task { await session.logout() } }
        } footer: { Text("只退出当前环境，保留本机草稿。") }
      }.navigationTitle("连接设置").toolbar { Button("关闭") { dismiss() } }
    }
  }
}
