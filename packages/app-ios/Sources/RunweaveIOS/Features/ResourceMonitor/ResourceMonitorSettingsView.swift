import SwiftUI

struct ResourceMonitorSettingsView: View {
  @ObservedObject var model: ResourceMonitorModel
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationView {
      List {
        Section {
          Text("\(model.data?.hostName ?? "当前电脑") · 设置与电脑端同步").font(.caption).foregroundColor(.secondary)
          Toggle("后台资源监控", isOn: Binding(get: { model.data?.settings.monitorEnabled == true }, set: { value in
            Task { await model.settings(monitor: value, alerts: model.data?.settings.alertsEnabled == true) }
          }))
          Toggle("资源占用提醒", isOn: Binding(get: { model.data?.settings.alertsEnabled == true }, set: { value in
            Task { await model.settings(monitor: model.data?.settings.monitorEnabled == true, alerts: value) }
          }))
        } footer: {
          Text("关闭手机页面后后台仍继续观察。能耗影响 ≥ 100（仅电池供电），或 RSS 合计 ≥ 4 GiB；至少六次有效采样跨满五分钟。内存占用不代表耗电量。")
        }.disabled(!model.session.canWrite || model.writing || model.data == nil)
        Section("进程操作权限") {
          HStack { Text("远程结束进程"); Spacer(); Text(model.data?.remoteControl?.enabled == true ? "已授权" : "未授权").foregroundColor(.secondary) }
          Text(model.data?.remoteControl?.enabled == true ? "已登录客户端可结束这台电脑的普通进程。电脑端可随时撤销，受保护进程不可操作。" : "请在这台电脑的 Runweave「提醒设置」中开启。手机不能自行授予权限。")
            .font(.caption).foregroundColor(.secondary)
          Button("刷新权限") { Task { await model.refresh() } }.disabled(model.loading)
        }
        if let message = model.message { Section { Text(message).font(.caption) } }
        if let message = model.statusMessage { Section { Text(message).font(.caption).foregroundColor(.orange) } }
      }.navigationTitle("提醒设置").navigationBarTitleDisplayMode(.inline)
        .toolbar { Button("关闭") { dismiss() } }
    }.navigationViewStyle(.stack)
  }
}
