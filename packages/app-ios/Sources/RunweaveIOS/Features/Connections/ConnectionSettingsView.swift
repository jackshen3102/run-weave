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
  @State private var resetForecast: CodexResetForecast?
  @State private var resetForecastLoading = true
  @State private var resetForecastFailed = false
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
          NavigationLink {
            QuickReplyLibraryView(session: session)
          } label: { Label("快捷指令", systemImage: "text.badge.plus") }
            .accessibilityIdentifier("connection-quick-replies")
        }
        Section(header: Text("Codex 重置预测"),
          footer: Text("第三方对额外重置的估算，仅在打开设置时刷新。")) {
          HStack {
            resetProbability("24 小时内", value: resetForecast?.within24Hours, identifier: "codex-reset-24h")
            Divider()
            resetProbability("48 小时内", value: resetForecast?.within48Hours, identifier: "codex-reset-48h")
          }.padding(.vertical, 6)
          if resetForecastLoading {
            HStack {
              ProgressView()
              Text("正在读取预测…").font(.caption).foregroundColor(.secondary)
            }
          } else if resetForecastFailed {
            Text("预测暂时无法读取，请重新打开设置或查看来源网页。")
              .font(.caption).foregroundColor(.secondary)
          }
          if let checkedAt = resetForecast?.checkedAt {
            Text("来源检查于 \(checkedAt.formatted(date: .abbreviated, time: .shortened))")
              .font(.caption).foregroundColor(.secondary)
          }
          Link(destination: CodexResetForecast.sourceURL) {
            Label("查看来源 · Codex Reset Monitor", systemImage: "arrow.up.right.square")
              .font(.caption)
          }
          .accessibilityIdentifier("codex-reset-forecast-open")
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
    .task { await refreshResetForecast() }
    .sheet(isPresented: $showingBuildIdentity) { BuildIdentityView().mobileAnalyticsScreen(.buildInfo) }
    .sheet(isPresented: $showingCodexQuota) {
      CodexQuotaView(session: session, quota: codexQuota).mobileAnalyticsScreen(.codexQuota)
    }
    .sheet(isPresented: $showingVersions) { RuntimeVersionsView(session: session) }
  }

  private func resetProbability(_ title: String, value: Double?, identifier: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).font(.subheadline).foregroundColor(.secondary)
      Text(value.map { "\($0.formatted(.number.precision(.fractionLength(0...1))))%" } ?? "—")
        .font(.title2.weight(.semibold)).monospacedDigit()
        .accessibilityIdentifier(identifier)
    }.frame(maxWidth: .infinity, alignment: .leading)
  }

  @MainActor
  private func refreshResetForecast() async {
    resetForecastLoading = true
    resetForecastFailed = false
    do {
      let forecast = try await CodexResetForecast.fetch()
      try Task.checkCancellation()
      resetForecast = forecast
    } catch {
      guard !Task.isCancelled else { return }
      resetForecast = nil
      resetForecastFailed = true
    }
    resetForecastLoading = false
  }
}
