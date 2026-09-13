import Foundation

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

extension APIClient {
  func codexQuota(force: Bool) async throws -> CodexQuotaSnapshot {
    try await authorized("/api/codex/quota" + (force ? "?refresh=1" : ""))
  }
}
