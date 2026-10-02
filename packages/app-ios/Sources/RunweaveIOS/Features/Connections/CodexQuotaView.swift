import SwiftUI

struct CodexQuotaView: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  @ObservedObject var quota: CodexQuotaStore

  var body: some View {
    NavigationView {
      Form {
        Section(footer: Text("\(session.connection?.name ?? "当前连接") · App Server 的 ChatGPT 订阅")) {
          quotaWindow("每周剩余", value: quota.snapshot?.weekly)
        }
        if let shortWindow = quota.snapshot?.shortWindow {
          Section { quotaWindow("短周期剩余", value: shortWindow) }
        }
        Section {
          if let message = quota.failure ?? quota.snapshot?.message {
            Text(message + (quota.snapshot?.observedAt != nil ? "；额度为上次记录" : ""))
              .foregroundColor(.orange)
          }
          if let observedAt = quota.snapshot?.observedAt {
            Text("更新于 \(formattedObservation(observedAt))\(quota.stale ? "（旧记录）" : "")")
              .font(.caption).foregroundColor(.secondary)
          }
          Button {
            quota.refresh(session: session, force: true)
          } label: {
            if quota.loading { HStack { ProgressView(); Text("正在更新…") } }
            else { Text("刷新") }
          }.disabled(quota.loading || !session.authenticated || !session.foreground)
          Text("仅打开或手动刷新时查询，不会持续监控。")
            .font(.caption).foregroundColor(.secondary)
        }
      }
      .navigationTitle("Codex 额度")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { Button("关闭") { dismiss() } }
    }
    .navigationViewStyle(.stack)
    .onAppear {
      if session.authenticated, session.foreground { quota.refresh(session: session) }
    }
    .onDisappear { quota.cancel() }
    .onChange(of: session.generation) { _ in dismiss() }
    .onChange(of: session.authenticated) { if !$0 { quota.reset(); dismiss() } }
    .onChange(of: session.foreground) { if !$0 { quota.cancel() } }
  }

  private func formattedObservation(_ value: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value)?.formatted(date: .abbreviated, time: .standard) ?? value
  }

  private func quotaWindow(_ title: String, value: CodexQuotaSnapshot.Window?) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(title)
        Spacer()
        Text(value.map { "\($0.remaining.formatted(.number.precision(.fractionLength(0...1))))%" } ?? "未知")
          .font(.title2).bold().monospacedDigit()
      }
      if let value {
        ProgressView(value: value.remaining, total: 100).accessibilityLabel(title)
        if let reset = value.resetsAt {
          Text("下次重置：\(Date(timeIntervalSince1970: reset).formatted(date: .abbreviated, time: .shortened))")
            .font(.caption).foregroundColor(.secondary)
          TimelineView(.periodic(from: .now, by: 60)) { context in
            let remaining = reset - context.date.timeIntervalSince1970
            if remaining <= 0 {
              Text("已到期，请刷新确认").font(.caption).foregroundColor(.orange)
            } else {
              Text(resetCountdown(remaining)).font(.caption).foregroundColor(.secondary)
            }
          }
        } else {
          Text("下次重置：未知").font(.caption).foregroundColor(.secondary)
        }
      } else {
        Text("上游未提供此窗口").font(.caption).foregroundColor(.secondary)
      }
    }.padding(.vertical, 4)
  }

  private func resetCountdown(_ remaining: TimeInterval) -> String {
    let totalHours = Int(remaining / 3600)
    if totalHours == 0 { return "距重置还有不到 1 小时" }
    let days = totalHours / 24
    let hours = totalHours % 24
    return days > 0 ? "距重置还有 \(days) 天 \(hours) 小时" : "距重置还有 \(hours) 小时"
  }
}
