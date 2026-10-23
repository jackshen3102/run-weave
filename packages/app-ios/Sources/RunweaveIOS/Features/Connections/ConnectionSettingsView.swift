import IOSBuildIdentity
import SwiftUI

struct ConnectionSettingsView: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var quickInputs: BackendQuickInputModel
  @ObservedObject var store: ConnectionStore
  @ObservedObject var session: AppSession
  let codexQuota: CodexQuotaStore
  @State private var showingBuildIdentity = false
  @State private var showingCodexQuota = false
  @State private var showingVersions = false
  @AppStorage(DevicePreferences.themeKey, store: DevicePreferences.store) private var theme = "dark"
  @AppStorage(DevicePreferences.screenAwakeKey, store: DevicePreferences.store) private var keepScreenAwake = true

  var body: some View {
    NavigationView {
      Form {
        Section(header: Text("本机设置"),
          footer: Text("保持屏幕常亮仅在 Runweave 前台使用时生效，开启会增加耗电。")) {
          Picker("外观", selection: $theme) {
            Text("深色").tag("dark")
            Text("浅色").tag("light")
          }
          Toggle("保持屏幕常亮", isOn: $keepScreenAwake)
            .accessibilityIdentifier("keep-screen-awake")
        }
        Section(header: Text(store.active.map { "当前电脑 · " + $0.name } ?? "电脑")) {
          if let connection = store.active {
            NavigationLink {
              ConnectionDetailView(store: store, session: session,
                connectionID: connection.id, onFinish: { dismiss() })
            } label: { Label("电脑设置", systemImage: "desktopcomputer") }
          }
          Button { showingCodexQuota = true } label: {
            Label {
              Text("Codex 额度").foregroundStyle(Color.primary)
            } icon: {
              Image(systemName: "chart.bar")
            }
          }.disabled(!session.authenticated)
            .accessibilityIdentifier("codex-quota-open")
          if let url = URL(string: "https://codexreset.org/") {
            Link(destination: url) {
              Label {
                Text("Codex 重置预测").foregroundStyle(Color.primary)
              } icon: {
                Image(systemName: "arrow.up.right.square")
              }
            }
            .accessibilityIdentifier("codex-reset-forecast-open")
            .accessibilityHint("在浏览器中打开 Codex Reset Monitor")
          }
          NavigationLink {
            QuickReplyLibraryView(session: session)
          } label: { Label("快捷指令", systemImage: "text.badge.plus") }
            .accessibilityIdentifier("connection-quick-replies")
        }
        Section {
          Button { showingVersions = true } label: { Label("组件版本", systemImage: "number") }
          Button { showingBuildIdentity = true } label: { Label("关于 Runweave", systemImage: "info.circle") }
            .accessibilityHint("查看版本与构建信息")
        }
      }
      .navigationTitle("设置").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .navigationBarTrailing) {
          Button("关闭") { dismiss() }.disabled(quickInputs.saving)
        }
      }
    }
    .navigationViewStyle(.stack)
    .interactiveDismissDisabled(quickInputs.saving)
    .preferredColorScheme(theme == "light" ? .light : .dark)
    .sheet(isPresented: $showingBuildIdentity) { BuildIdentityView().mobileAnalyticsScreen(.buildInfo) }
    .sheet(isPresented: $showingCodexQuota) {
      CodexQuotaView(session: session, quota: codexQuota).mobileAnalyticsScreen(.codexQuota)
    }
    .sheet(isPresented: $showingVersions) { RuntimeVersionsView(session: session) }
  }
}
