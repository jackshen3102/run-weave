import SwiftUI

struct DeviceBatteryView: View {
  @ObservedObject var device: DeviceStatusStore
  var compact = false

  var body: some View {
    TimelineView(.periodic(from: .now, by: 30)) { _ in
      HStack(spacing: 4) {
        if let status = device.snapshot {
          if status.battery.presence == "present", let percent = status.battery.percent {
            Image(systemName: icon(status, percent: percent))
            Text("\(percent)%")
            if !compact { Text(powerDescription(status)).foregroundColor(.secondary) }
            if device.stale { Text(compact ? "·" : "上次记录").foregroundColor(.secondary) }
          } else {
            Text(
              status.battery.presence == "absent"
                ? "交流电"
                : status.sampleStatus == "pending"
                  ? "等待采样" : status.sampleStatus == "unsupported" ? "不支持电量监控" : "电量未知")
          }
        } else if let failure = device.failure {
          Text(compact ? "电量未知" : failure)
        } else {
          ProgressView().controlSize(.mini)
          if !compact { Text("等待电量") }
        }
      }
      .font(.caption)
      .foregroundColor(color)
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier(compact ? "device.battery.compact" : "device.battery.detail")
    }
  }

  private var color: Color {
    guard !device.stale, let value = device.snapshot, value.battery.powerSource == "battery",
      let percent = value.battery.percent
    else { return .secondary }
    return percent <= 10 ? .red : percent <= 20 ? .orange : .secondary
  }
  private func icon(_ value: DeviceStatusSnapshot, percent: Int) -> String {
    if value.battery.chargeState == "charging" { return "battery.100.bolt" }
    return
      "battery.\(percent < 10 ? 0 : percent < 35 ? 25 : percent < 65 ? 50 : percent < 90 ? 75 : 100)"
  }
  private func powerDescription(_ value: DeviceStatusSnapshot) -> String {
    if value.battery.chargeState == "charging" { return "正在充电" }
    if value.battery.powerSource == "ac" {
      return value.battery.chargeState == "full" ? "已充满" : "已接电 · 未充电"
    }
    return value.battery.powerSource == "battery" ? "使用电池" : "供电未知"
  }
}
