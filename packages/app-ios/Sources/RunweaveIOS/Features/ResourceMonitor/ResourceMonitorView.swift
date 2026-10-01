import SwiftUI

struct ResourceMonitorView: View {
  @ObservedObject var session: AppSession
  @StateObject private var model: ResourceMonitorModel
  @State private var appKey: String?
  @State private var showingSettings = false
  @State private var visible = false
  init(session: AppSession) {
    self.session = session
    _model = StateObject(wrappedValue: ResourceMonitorModel(session: session))
  }
  private var selected: ResourceApp? { model.apps.first { $0.id == appKey } }
  private var polling: Bool { visible && session.foreground && session.authenticated && session.health.status == .online }
  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 16) {
        if let app = selected { detail(app) } else { overview }
      }.padding(16)
    }
    .background(Color(uiColor: .systemGroupedBackground))
    .navigationTitle(selected?.appName ?? "耗电监控")
    .navigationBarTitleDisplayMode(.inline)
    .navigationBarBackButtonHidden(selected != nil)
    .toolbar {
      ToolbarItem(placement: .navigationBarLeading) {
        if selected != nil {
          Button { appKey = nil } label: { Label("耗电监控", systemImage: "chevron.left") }
        }
      }
      ToolbarItem(placement: .navigationBarTrailing) {
        Button("设置") { showingSettings = true }.disabled(model.data == nil)
      }
    }
    .refreshable { await model.refresh() }
    .onAppear { visible = true }
    .onDisappear { visible = false; model.confirmation = nil }
    .task(id: polling) {
      guard polling else { return }
      do {
        while !Task.isCancelled {
          await model.refresh()
          try await Task.sleep(nanoseconds: 5_000_000_000)
        }
      } catch {}
    }
    .sheet(isPresented: $showingSettings) { ResourceMonitorSettingsView(model: model) }
    .alert(model.confirmation.map { confirmationTitle($0) } ?? "结束这个进程？",
      isPresented: Binding(get: { model.confirmation != nil }, set: { if !$0 { model.confirmation = nil } }),
      presenting: model.confirmation) { pending in
      Button(pending.force ? "强制结束" : pending.process.actionKind == "stop_service" ? "停止服务" : "结束进程", role: .destructive) { Task { await model.confirm(pending) } }
      Button("取消", role: .cancel) {}
    } message: { pending in
      Text("\(model.data?.hostName ?? "当前电脑")\n\(pending.process.displayName) · PID \(pending.process.pid)\nCPU \(resourceCPU(pending.process.cpuPercent)) · RSS \(resourceMemory(pending.process.memoryMb))\n\n" + confirmationMessage(pending))
    }
  }
  private var overview: some View {
    Group {
      batteryCard
      status
      if let alert = model.energyAlerts.first, model.statusMessage == nil {
        resourceCard {
          VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
              Text("\(alert.appName) 能耗影响较高").font(.subheadline.bold())
              Spacer(minLength: 8)
              Button("忽略 1 小时") { Task { await model.snooze(alert) } }
                .font(.caption).disabled(!session.canWrite || model.writing)
            }
            Text("近 5 分钟多次检测到高占用").font(.caption).foregroundColor(.secondary)
            Button("查看进程") { appKey = alert.appKey }
              .font(.caption).disabled(!model.apps.contains { $0.id == alert.appKey })
          }
        }
      }
      HStack {
        Text("应用排行"); Spacer(); Text("按能耗影响排序")
      }.font(.caption).foregroundColor(.secondary)
      if model.data == nil && model.loading { ProgressView("正在加载…").frame(maxWidth: .infinity) }
      if model.apps.isEmpty && !model.loading { Text("暂无有效采样").font(.subheadline).foregroundColor(.secondary) }
      ForEach(model.apps.prefix(50)) { app in
        Button { appKey = app.id } label: {
          resourceCard {
            HStack(spacing: 12) {
              appIcon(app.appName)
              VStack(alignment: .leading, spacing: 5) {
                Text(app.appName).font(.subheadline.bold()).foregroundColor(.primary)
                Text("CPU \(resourceCPU(app.cpuPercent)) · RSS \(resourceMemory(app.memoryMb))\n\(app.processCount) 个进程")
                  .font(.caption2).foregroundColor(.secondary)
              }.frame(maxWidth: .infinity, alignment: .leading)
              VStack(alignment: .trailing, spacing: 2) {
                Text(resourceImpact(app.energyImpact)).font(.title3.weight(.semibold)).monospacedDigit()
                Text("能耗影响").font(.system(size: 10)).foregroundColor(.secondary)
              }.foregroundColor(.primary)
              Image(systemName: "chevron.right").font(.caption).foregroundColor(.secondary)
            }
          }
        }.buttonStyle(.plain).accessibilityIdentifier("resource.app.\(app.appKey)")
      }
      Text("能耗影响按 CPU 与唤醒次数估算，不是应用瓦数。CPU 的 100% 表示一个核心。RSS 合计可能重复计入共享页，内存占用不代表耗电量。")
        .font(.caption2).foregroundColor(.secondary)
    }
  }
  private var batteryCard: some View {
    resourceCard {
      VStack(alignment: .leading, spacing: 16) {
        HStack {
          Image(systemName: "desktopcomputer").foregroundColor(.cyan)
          Text(model.data?.hostName ?? session.connection?.name ?? "当前电脑").font(.subheadline.bold())
          Spacer(); Text("当前电脑").font(.caption2).foregroundColor(.secondary)
        }
        HStack(alignment: .center) {
          VStack(alignment: .leading, spacing: 4) {
            Text(model.data?.snapshot?.battery.percent.map { "\($0)%" } ?? "—").font(.system(size: 40, weight: .semibold)).monospacedDigit()
            Text(powerDescription).font(.caption).foregroundColor(.secondary)
          }
          Spacer()
          VStack(alignment: .trailing, spacing: 4) {
            Text(dischargePower).font(.title2.weight(.semibold)).monospacedDigit()
            Text("整机估算放电").font(.caption2).foregroundColor(.secondary)
          }
        }
        Divider()
        HStack {
          Text("后台每分钟采样"); Spacer(); Text(sampleTime)
        }.font(.caption2).foregroundColor(.secondary)
      }
    }
  }
  private var powerDescription: String {
    guard let battery = model.data?.snapshot?.battery, battery.available else { return "电量未知" }
    if battery.powerSource == "ac" { return battery.charging == true ? "已接电 · 正在充电" : "已接电" }
    return battery.powerSource == "battery" ? "电池供电" : "供电未知"
  }
  private var dischargePower: String {
    guard let battery = model.data?.snapshot?.battery, battery.available,
      battery.powerSource == "battery", battery.charging != true, let watts = battery.dischargePowerW else { return "—" }
    return String(format: "%.1f W", watts)
  }
  private var sampleTime: String {
    guard let time = model.data?.snapshot?.sampledAt else { return "等待采样" }
    let formatter = DateFormatter(); formatter.dateFormat = "HH:mm"
    return "更新于 " + formatter.string(from: Date(timeIntervalSince1970: time / 1000))
  }
  private var status: some View {
    Group {
      if let text = model.statusMessage {
        resourceCard { Text(text).font(.caption).foregroundColor(.orange) }
      }
      if let data = model.data, data.remoteControl?.enabled != true {
        resourceCard {
          VStack(alignment: .leading, spacing: 7) {
            Text("远程结束权限未开启").font(.subheadline.bold())
            Text("可查看排行。请在 \(data.hostName) 的 Runweave「提醒设置」中开启远程进程操作。")
              .font(.caption).foregroundColor(.secondary)
          }
        }
      }
      if let text = model.message {
        Text(text).font(.caption).foregroundColor(.secondary).accessibilityIdentifier("resource.action-result")
      }
    }
  }
  private func detail(_ app: ResourceApp) -> some View {
    Group {
      Text("\(model.data?.hostName ?? "当前电脑") · \(sampleTime)").font(.caption).foregroundColor(.secondary)
      resourceCard {
        VStack(spacing: 15) {
          HStack(spacing: 12) {
            appIcon(app.appName)
            VStack(alignment: .leading) { Text(app.appName).font(.subheadline.bold()); Text("\(app.processCount) 个进程").font(.caption).foregroundColor(.secondary) }
            Spacer()
            VStack(alignment: .trailing) { Text(resourceImpact(app.energyImpact)).font(.title3.bold()); Text("能耗影响").font(.caption2).foregroundColor(.secondary) }
          }
          Divider()
          HStack { Text("CPU \(resourceCPU(app.cpuPercent))"); Spacer(); Text("RSS 合计 \(resourceMemory(app.memoryMb))") }
            .font(.caption).foregroundColor(.secondary)
        }
      }
      status
      Text("占用较高的进程").font(.caption).foregroundColor(.secondary)
      ForEach(Array(model.processes(app.id).prefix(12))) { process in processRow(process) }
      if app.processCount > 12 { Text("显示 CPU 占用较高的前 12 个进程，共 \(app.processCount) 个").font(.caption2).foregroundColor(.secondary) }
      Text("普通结束只针对选中的进程，不会退出整个应用。「停止服务」会停止托管服务及其子进程。RSS 合计可能重复计入共享页。")
        .font(.caption2).foregroundColor(.secondary)
    }
  }
  private func processRow(_ process: ResourceProcess) -> some View {
    let result = model.results[process.id]
    let allowed = process.actionKind == "terminate" || process.actionKind == "stop_service"
    return resourceCard {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 12) {
          VStack(alignment: .leading, spacing: 5) {
            Text(process.displayName).font(.subheadline.bold())
            Text("PID \(process.pid)\nCPU \(resourceCPU(process.cpuPercent)) · RSS \(resourceMemory(process.memoryMb))").font(.caption2).foregroundColor(.secondary)
          }.frame(maxWidth: .infinity, alignment: .leading)
          if result?.state == "exited" || result?.state == "already_exited" {
            Text("已结束").font(.caption).foregroundColor(.green)
          } else if allowed {
            Button(model.forceAllowed(process.id) ? "强制结束…" : process.actionKind == "stop_service" ? "停止服务" : "结束进程", role: .destructive) { model.select(process) }
              .font(.caption).buttonStyle(.bordered).disabled(!model.canOperate)
              .accessibilityIdentifier("resource.terminate.\(process.pid)")
          } else {
            Text(process.actionReason == "电脑尚未授权远程结束进程" ? "未授权" : (process.actionReason?.contains("控制进程") == true || process.actionReason?.contains("系统") == true) ? "受保护" : "不可操作").font(.caption2).foregroundColor(.secondary)
          }
        }
        if result?.state == "still_running" { Text("仍在运行 · 尚未强制结束").font(.caption).foregroundColor(.orange) }
        if !allowed, let reason = process.actionReason { Text(reason).font(.caption2).foregroundColor(.secondary) }
      }
    }
  }
  private func confirmationTitle(_ pending: ResourceMonitorModel.Confirmation) -> String {
    pending.force ? "强制结束这个进程？" : pending.process.actionKind == "stop_service" ? "停止这个服务？" : "结束这个进程？"
  }
  private func confirmationMessage(_ pending: ResourceMonitorModel.Confirmation) -> String {
    if pending.process.actionKind == "stop_service" {
      return "将停止托管服务「\(pending.process.serviceName ?? pending.process.displayName)」及其子进程，按服务既有生命周期退出，必要时强制停止。未保存内容可能丢失。"
    }
    return pending.force ? "普通结束后进程仍在运行。强制结束会立即停止进程，未保存内容可能丢失。" : "未保存内容可能丢失。只结束这个进程，应用的其他进程可能继续运行。"
  }
}

func resourceCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
  content().frame(maxWidth: .infinity, alignment: .leading).padding(15)
    .background(Color(uiColor: .secondarySystemGroupedBackground))
    .clipShape(RoundedRectangle(cornerRadius: 13))
}
private func appIcon(_ name: String) -> some View {
  Text(String(name.prefix(1)).uppercased()).font(.headline).frame(width: 36, height: 36)
    .background(Color.cyan.opacity(0.22)).clipShape(RoundedRectangle(cornerRadius: 9))
}
func resourceCPU(_ value: Double?) -> String { value.map { String(format: $0 >= 10 ? "%.0f%%" : "%.1f%%", $0) } ?? "—" }
func resourceImpact(_ value: Double?) -> String { value.map { String(format: "%.1f", $0) } ?? "—" }
func resourceMemory(_ value: Double) -> String { value >= 1024 ? String(format: "%.2f GiB", value / 1024) : String(format: "%.0f MiB", value) }
