import Foundation

enum QuotaPaceState: String {
  case ahead
  case on
  case under

  var label: String {
    switch self {
    case .ahead: return "消耗偏快"
    case .on: return "进度均衡"
    case .under: return "余量充裕"
    }
  }
}

struct QuotaWindowPaceInfo {
  let remainingPercent: Double
  let evenPaceRemainingPercent: Double?
  let pace: QuotaPaceState?
}

/// Mirrors shared/app-server/codex-quota. Reset timestamps are Unix seconds.
struct CodexQuotaSnapshot: Decodable {
  let protocolVersion: Int
  let status: String
  let observedAt: String?
  let sampleAgeMs: Double?
  let weekly: Window?
  let shortWindow: Window?

  struct Window: Decodable {
    let usedPercent: Double
    let windowDurationMins: Double
    let resetsAt: Double?
    var remaining: Double { max(0, min(100, 100 - usedPercent)) }

    func paceInfo(at date: Date = .now) -> QuotaWindowPaceInfo {
      let rem = remaining
      guard let resetsAt, resetsAt.isFinite, resetsAt > 0,
        windowDurationMins > 0, windowDurationMins.isFinite
      else {
        return QuotaWindowPaceInfo(remainingPercent: rem, evenPaceRemainingPercent: nil, pace: nil)
      }
      let durationSec = windowDurationMins * 60
      let remainingTimeSec = resetsAt - date.timeIntervalSince1970
      guard remainingTimeSec > 0, remainingTimeSec <= durationSec else {
        return QuotaWindowPaceInfo(remainingPercent: rem, evenPaceRemainingPercent: nil, pace: nil)
      }
      let elapsedFraction = max(0, min(1, (durationSec - remainingTimeSec) / durationSec))
      let evenPaceRemaining = max(0, min(100, (1 - elapsedFraction) * 100))
      let delta = usedPercent - elapsedFraction * 100
      let pace: QuotaPaceState = delta > 5 ? .ahead : (delta < -5 ? .under : .on)
      return QuotaWindowPaceInfo(
        remainingPercent: rem,
        evenPaceRemainingPercent: evenPaceRemaining,
        pace: pace
      )
    }
  }

  var message: String? {
    switch status {
    case "ok": return nil
    case "unavailable": return "App Server 暂不可用"
    case "incompatible": return "当前服务版本不支持 Codex 额度，请更新后重试"
    case "unsupported": return "当前版本或登录方式不支持 Codex 额度"
    case "not_logged_in": return "请先在 App Server 所在电脑登录 Codex 的 ChatGPT 订阅"
    default: return "额度更新失败，请稍后重试"
    }
  }
}

/// Mirrors shared/app-server/agy-quota. Reset timestamps are Unix seconds.
struct AgyQuotaSnapshot: Decodable {
  let protocolVersion: Int
  let status: String
  let observedAt: String?
  let sampleAgeMs: Double?
  let groups: [Group]

  struct Window: Decodable, Identifiable {
    let id: String
    let label: String
    let kind: String
    let usedPercent: Double
    let windowDurationMins: Double
    let resetsAt: Double?
    var remaining: Double { max(0, min(100, 100 - usedPercent)) }
    var asQuotaWindow: CodexQuotaSnapshot.Window {
      CodexQuotaSnapshot.Window(
        usedPercent: usedPercent,
        windowDurationMins: windowDurationMins,
        resetsAt: resetsAt
      )
    }
  }

  struct Group: Decodable, Identifiable {
    let id: String
    let name: String
    let description: String?
    let weekly: Window?
    let shortWindow: Window?
    let windows: [Window]
  }

  var message: String? {
    switch status {
    case "ok": return nil
    case "unavailable": return "AGY 额度服务暂不可用"
    case "incompatible": return "当前服务版本不支持 AGY 额度，请更新后重试"
    case "unsupported": return "当前环境未安装或不支持 Antigravity (agy) 订阅额度"
    case "not_logged_in": return "请先在当前电脑完成 Antigravity (agy) 账号登录"
    default: return "AGY 额度更新失败，请稍后重试"
    }
  }
}

extension APIClient {
  func codexQuota(force: Bool) async throws -> CodexQuotaSnapshot {
    try await authorized("/api/codex/quota" + (force ? "?refresh=1" : ""))
  }

  func agyQuota(force: Bool) async throws -> AgyQuotaSnapshot {
    try await authorized("/api/agy/quota" + (force ? "?refresh=1" : ""))
  }
}
