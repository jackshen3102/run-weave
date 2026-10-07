import SwiftUI

struct DevelopmentResourceCard: View {
  let resource: DevelopmentResource
  let observedAt: String?
  let expanded: Bool
  let canOperate: Bool
  let releasing: Bool
  let toggle: () -> Void
  let release: () -> Void
  private var running: Bool { releasing || resource.operation?.state == "running" }
  private var stateLabel: String {
    if running { return "释放中" }
    if resource.operation?.state == "unknown" { return "结果未确认" }
    switch resource.state {
    case "busy": return "占用中"
    case "free": return "空闲"
    case "blocked": return "待释放"
    default: return "归属未知"
    }
  }
  private var color: Color {
    if running { return .blue }
    if resource.operation?.state == "unknown" { return .orange }
    switch resource.state { case "busy": return .blue; case "free": return .green; default: return .orange }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(resource.label).font(.subheadline.bold())
        Spacer(minLength: 8)
        Text(stateLabel).font(.caption2).foregroundColor(color).padding(.horizontal, 8).padding(.vertical, 4)
          .background(color.opacity(0.12)).cornerRadius(6)
      }
      if resource.state != "free" || running {
        Text(resource.owner?.task ?? resource.owner?.id ?? "占用者未确认").font(.subheadline)
        if let owner = resource.owner {
          HStack(alignment: .top, spacing: 8) {
            if let worktree = owner.worktree {
              Text(URL(fileURLWithPath: worktree).lastPathComponent).font(.system(.caption2, design: .monospaced))
                .padding(.horizontal, 6).padding(.vertical, 3).background(Color.secondary.opacity(0.12)).cornerRadius(4)
            }
            Text("占用 \(duration(since: owner.startedAt))").font(.caption).foregroundColor(.secondary)
          }
          Text(owner.lastActivityAt == nil ? "最后活动 未知" : "最后活动 \(duration(since: owner.lastActivityAt))前").font(.caption2).foregroundColor(.secondary)
        }
        if let reason = resource.reason { Text(reason).font(.caption).foregroundColor(.secondary) }
        if let reason = resource.release.disabledReason, reason != resource.reason {
          Text(reason).font(.caption).foregroundColor(.secondary)
        }
        if running { Text("正在清理资源，请稍后手动刷新查看结果。").font(.caption).foregroundColor(.secondary) }
        if resource.operation?.state == "unknown" {
          Text("释放结果尚未确认，占用仍保留，请刷新核查。").font(.caption).foregroundColor(.orange)
        }
        Divider()
        HStack {
          Button(action: toggle) {
            Label(expanded ? "收起详情" : "查看详情", systemImage: expanded ? "chevron.up" : "chevron.down")
              .font(.caption).frame(minHeight: 44)
          }.accessibilityIdentifier("development-resource-details-\(resource.id)")
          Spacer(minLength: 4)
          if resource.canRelease && !running {
            Button(action: release) {
              Text(resource.actionLabel).font(.caption).foregroundColor(.red).padding(.horizontal, 12)
                .frame(minHeight: 44).background(Color.red.opacity(0.1)).cornerRadius(8)
            }.disabled(!canOperate).accessibilityIdentifier("development-resource-release-\(resource.id)")
          } else {
            Text(running ? "处理中" : "无法释放").font(.caption2).foregroundColor(.secondary)
          }
        }.buttonStyle(.plain)
        if expanded { detail }
      } else if let state = resource.details.deviceState {
        Text(state).font(.caption).foregroundColor(.secondary)
      }
    }.padding(15).frame(maxWidth: .infinity, alignment: .leading)
      .background(Color(uiColor: .secondarySystemGroupedBackground)).cornerRadius(13)
      .accessibilityElement(children: .contain).accessibilityIdentifier("development-resource-\(resource.id)")
  }
  private var detail: some View {
    VStack(alignment: .leading, spacing: 6) {
      Divider()
      if let owner = resource.owner {
        Text("归属　\(owner.id)")
        if let worktree = owner.worktree { Text(worktree).font(.system(.caption2, design: .monospaced)) }
      }
      if resource.details.processes.isEmpty { Text("无运行中的归属进程") }
      ForEach(Array(resource.details.processes.enumerated()), id: \.offset) { _, process in
        Text("\(process.name) · PID \(process.pid) · \(ownership(process.ownership))")
      }
      if !resource.details.ports.isEmpty { Text("端口　" + resource.details.ports.map(String.init).joined(separator: " · ")) }
      if let state = resource.details.deviceState { Text("设备　\(state)") }
      if let udid = resource.details.udid { Text("UDID \(udid)").font(.system(.caption2, design: .monospaced)) }
      if let path = resource.details.path { Text(path).font(.system(.caption2, design: .monospaced)) }
    }.font(.caption).foregroundColor(.secondary).textSelection(.enabled)
  }
  private func ownership(_ value: String) -> String {
    switch value { case "owned": return "本任务"; case "shared": return "共享"; default: return "未知归属" }
  }
  private func duration(since value: String?) -> String {
    guard let start = developmentResourceDate(value), let observed = developmentResourceDate(observedAt) else { return "未知" }
    let minutes = max(0, Int(observed.timeIntervalSince(start) / 60))
    if minutes == 0 { return "不到 1 分钟" }
    if minutes < 60 { return "\(minutes) 分钟" }
    return "\(minutes / 60) 小时 \(minutes % 60) 分钟"
  }
}
