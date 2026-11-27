import SwiftUI

struct CodexQuotaView: View {
  enum QuotaProvider {
    case agy
    case codex

    var accentColor: Color {
      switch self {
      case .agy: return Color(red: 0.55, green: 0.48, blue: 0.82)
      case .codex: return .accentColor
      }
    }
  }

  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  @ObservedObject var quota: CodexQuotaStore
  var preferredProvider: String? = nil

  private var agyFirst: Bool {
    preferredProvider != "codex"
  }

  var body: some View {
    NavigationView {
      Form {
        if agyFirst {
          agySections
          codexSections
        } else {
          codexSections
          agySections
        }
        Section {
          Button {
            quota.refresh(session: session, force: true)
          } label: {
            if quota.loading {
              HStack {
                ProgressView()
                Text("正在更新…")
              }
            } else {
              Text("刷新")
            }
          }
          .disabled(quota.loading || !session.authenticated || !session.foreground)
          Text("仅打开或手动刷新时查询，不会持续监控。进度条竖线表示当前时间点的匀速消耗基准。")
            .font(.caption)
            .foregroundColor(.secondary)
        }
      }
      .navigationTitle("订阅额度")
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

  @ViewBuilder
  private var agySections: some View {
    if let groups = quota.agySnapshot?.groups, !groups.isEmpty {
      ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
        Section(
          header: HStack(spacing: 6) {
            Circle().fill(QuotaProvider.agy.accentColor).frame(width: 8, height: 8)
            Text("Antigravity (AGY) · \(group.name)")
          },
          footer: agyGroupFooter(group: group, isLast: index == groups.count - 1)
        ) {
          ForEach(group.windows) { window in
            quotaWindow(window.label, value: window.asQuotaWindow, provider: .agy)
          }
          if index == groups.count - 1, let message = quota.agyFailure ?? quota.agySnapshot?.message {
            Text(message + (quota.agySnapshot?.observedAt != nil ? "；额度为上次记录" : ""))
              .font(.caption)
              .foregroundColor(.orange)
          }
        }
      }
    } else {
      Section(
        header: HStack(spacing: 6) {
          Circle().fill(QuotaProvider.agy.accentColor).frame(width: 8, height: 8)
          Text("Antigravity (AGY)")
        },
        footer: Text("\(session.connection?.name ?? "当前连接") · Antigravity 模型配额池")
      ) {
        quotaWindow("每周剩余", value: nil, provider: .agy)
        if let message = quota.agyFailure ?? quota.agySnapshot?.message {
          Text(message + (quota.agySnapshot?.observedAt != nil ? "；额度为上次记录" : ""))
            .font(.caption)
            .foregroundColor(.orange)
        }
        if let observedAt = quota.agySnapshot?.observedAt {
          Text("更新于 \(formattedObservation(observedAt))\(quota.agyStale ? "（旧记录）" : "")")
            .font(.caption)
            .foregroundColor(.secondary)
        }
      }
    }
  }

  @ViewBuilder
  private func agyGroupFooter(group: AgyQuotaSnapshot.Group, isLast: Bool) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      if let description = group.description, !description.isEmpty {
        Text(description)
      }
      if isLast, let observedAt = quota.agySnapshot?.observedAt {
        Text("AGY 更新于 \(formattedObservation(observedAt))\(quota.agyStale ? "（旧记录）" : "")")
      }
    }
  }

  @ViewBuilder
  private var codexSections: some View {
    Section(
      header: HStack(spacing: 6) {
        Circle().fill(QuotaProvider.codex.accentColor).frame(width: 8, height: 8)
        Text("Codex · ChatGPT 订阅")
      },
      footer: Text("\(session.connection?.name ?? "当前连接") · App Server 的 ChatGPT 订阅")
    ) {
      quotaWindow("每周剩余", value: quota.snapshot?.weekly, provider: .codex)
      if let shortWindow = quota.snapshot?.shortWindow {
        quotaWindow("短周期剩余", value: shortWindow, provider: .codex)
      }
      if let message = quota.failure ?? quota.snapshot?.message {
        Text(message + (quota.snapshot?.observedAt != nil ? "；额度为上次记录" : ""))
          .font(.caption)
          .foregroundColor(.orange)
      }
      if let observedAt = quota.snapshot?.observedAt {
        Text("Codex 更新于 \(formattedObservation(observedAt))\(quota.stale ? "（旧记录）" : "")")
          .font(.caption)
          .foregroundColor(.secondary)
      }
    }
  }

  private func formattedObservation(_ value: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) {
      return date.formatted(date: .abbreviated, time: .standard)
    }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)?.formatted(date: .abbreviated, time: .standard) ?? value
  }

  private func quotaWindow(
    _ title: String,
    value: CodexQuotaSnapshot.Window?,
    provider: QuotaProvider
  ) -> some View {
    TimelineView(.periodic(from: .now, by: 60)) { context in
      let paceInfo = value?.paceInfo(at: context.date)
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 8) {
          Text(title)
            .font(.subheadline.weight(.medium))
          if let pace = paceInfo?.pace {
            paceBadge(pace)
          }
          Spacer()
          Text(
            value.map {
              "\($0.remaining.formatted(.number.precision(.fractionLength(0...1))))%"
            } ?? "未知"
          )
          .font(.title3.weight(.bold))
          .monospacedDigit()
        }
        if let value, let paceInfo {
          t3ProgressBar(
            title: title,
            remainingPercent: paceInfo.remainingPercent,
            evenPaceRemainingPercent: paceInfo.evenPaceRemainingPercent,
            provider: provider
          )
          HStack(alignment: .firstTextBaseline) {
            if let reset = value.resetsAt {
              let remaining = reset - context.date.timeIntervalSince1970
              let resetText = Date(timeIntervalSince1970: reset).formatted(
                date: .abbreviated,
                time: .shortened
              )
              if remaining <= 0 {
                Text("下次重置：\(resetText)（已到期，请刷新确认）")
                  .font(.caption)
                  .foregroundColor(.orange)
              } else {
                Text("下次重置：\(resetText) · \(resetCountdown(remaining))")
                  .font(.caption)
                  .foregroundColor(.secondary)
              }
            } else if value.usedPercent == 0 {
              Text("下次重置：未触发（首次消耗后开始计时）")
                .font(.caption)
                .foregroundColor(.secondary)
            } else {
              Text("下次重置：未知")
                .font(.caption)
                .foregroundColor(.secondary)
            }
            Spacer(minLength: 4)
            if let evenPace = paceInfo.evenPaceRemainingPercent {
              Text("匀速应剩 \(Int(evenPace.rounded()))%")
                .font(.caption2)
                .foregroundColor(.secondary)
                .monospacedDigit()
            }
          }
        } else {
          Text("上游未提供此窗口")
            .font(.caption)
            .foregroundColor(.secondary)
        }
      }
      .padding(.vertical, 4)
    }
  }

  private func paceBadge(_ pace: QuotaPaceState) -> some View {
    let color: Color = {
      switch pace {
      case .ahead: return .orange
      case .on: return .secondary
      case .under: return .green
      }
    }()
    return Text(pace.label)
      .font(.caption2.weight(.semibold))
      .foregroundColor(color)
      .padding(.horizontal, 7)
      .padding(.vertical, 2)
      .background(color.opacity(0.14), in: Capsule())
  }

  private func t3ProgressBar(
    title: String,
    remainingPercent: Double,
    evenPaceRemainingPercent: Double?,
    provider: QuotaProvider
  ) -> some View {
    let fillColor: Color = {
      if remainingPercent <= 10 { return .red }
      if remainingPercent <= 30 { return .orange }
      return provider.accentColor
    }()
    return GeometryReader { geo in
      let width = max(0, geo.size.width)
      let fillWidth = width * CGFloat(max(0, min(100, remainingPercent)) / 100)
      ZStack(alignment: .leading) {
        Capsule()
          .fill(Color.secondary.opacity(0.18))
          .frame(height: 8)
        Capsule()
          .fill(fillColor)
          .frame(width: fillWidth, height: 8)
        if let evenPaceRemainingPercent {
          let clamped = max(2, min(98, evenPaceRemainingPercent))
          let tickX = width * CGFloat(clamped / 100)
          RoundedRectangle(cornerRadius: 1)
            .fill(Color.primary)
            .frame(width: 2, height: 12)
            .overlay(
              RoundedRectangle(cornerRadius: 1)
                .stroke(Color(UIColor.systemBackground), lineWidth: 0.75)
            )
            .offset(x: max(0, tickX - 1))
            .accessibilityHidden(true)
        }
      }
    }
    .frame(height: 12)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(title)
    .accessibilityValue("\(Int(remainingPercent.rounded()))%")
  }

  private func resetCountdown(_ remaining: TimeInterval) -> String {
    let totalMinutes = max(0, Int(remaining / 60))
    if totalMinutes < 60 {
      return totalMinutes <= 1 ? "距重置不足 1 分钟" : "距重置还有 \(totalMinutes) 分钟"
    }
    let totalHours = totalMinutes / 60
    let days = totalHours / 24
    let hours = totalHours % 24
    let mins = totalMinutes % 60
    if days > 0 {
      return "距重置还有 \(days) 天 \(hours) 小时"
    }
    return mins > 0 ? "距重置还有 \(hours) 小时 \(mins) 分钟" : "距重置还有 \(hours) 小时"
  }
}
