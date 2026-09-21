import Foundation

// Mirrors packages/shared/src/terminal/snapshot-share.ts.
struct TerminalSnapshotShareResponse: Decodable {
  let shareUrl: String
  let sharePath: String
  let title: String
  let createdAt: String
  let expiresAt: String
  let lineCount: Int

  func resolveURL() throws -> URL {
    let pattern = #"\A/share/terminal/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\?expires=([1-9][0-9]{0,15})&signature=[A-Za-z0-9_-]{43}\z"#
    let expression = try NSRegularExpression(pattern: pattern)
    let range = NSRange(sharePath.startIndex..., in: sharePath)
    guard let match = expression.firstMatch(in: sharePath, range: range),
      let expiryRange = Range(match.range(at: 1), in: sharePath),
      let expiry = Int64(sharePath[expiryRange]), expiry <= 9_007_199_254_740_991
    else { throw APIError.invalidResponse }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = formatter.date(from: expiresAt),
      Int64((date.timeIntervalSince1970 * 1000).rounded()) == expiry,
      let components = URLComponents(string: shareUrl),
      components.scheme == "https",
      let host = components.host, !host.isEmpty,
      components.user == nil, components.password == nil, components.fragment == nil,
      components.percentEncodedPath + "?" + (components.percentEncodedQuery ?? "") == sharePath,
      let url = components.url
    else { throw APIError.invalidResponse }
    // The central Host owns the read URL; never derive it from the Backend connection.
    return url
  }
}

struct TerminalSnapshotShare: Identifiable {
  let url: URL
  var id: URL { url }
}

// Decode only known sharing codes; never display arbitrary server response text.
struct TerminalSnapshotShareFailure: Decodable, LocalizedError {
  let code: String

  private var details: (status: Int, message: String)? {
    switch code {
    case "SNAPSHOT_PUBLISH_NOT_CONFIGURED":
      return (503, "当前电脑尚未配置公网分享服务，请配置分享服务地址和上传凭据后重启后端。")
    case "SNAPSHOT_PUBLISH_FAILED":
      return (502, "终端快照上传失败，请检查分享服务地址、上传凭据和网络连接。")
    case "SNAPSHOT_CAPTURE_UNAVAILABLE":
      return (503, "暂时无法读取终端内容，请检查电脑上的终端服务后重试。")
    case "SNAPSHOT_TARGET_NOT_FOUND":
      return (404, "要分享的终端或分屏已不存在，请重新打开终端后再分享。")
    case "SNAPSHOT_TARGET_UNAVAILABLE":
      return (409, "当前终端暂不支持快照分享。")
    case "SNAPSHOT_TOO_LARGE":
      return (413, "终端快照超过 10 MiB，无法分享。")
    case "SNAPSHOT_BUSY":
      return (429, "正在处理的分享请求过多，请稍后重试。")
    case "SNAPSHOT_STORAGE_FULL":
      return (507, "分享服务存储空间已满，请稍后重试或联系管理员。")
    case "SNAPSHOT_STORAGE_FAILED":
      return (500, "终端快照保存失败，请稍后重试。")
    default: return nil
    }
  }

  var errorDescription: String? { details?.message }

  static func decode(status: Int, data: Data) -> Error? {
    guard let failure = try? JSONDecoder().decode(Self.self, from: data),
      failure.details?.status == status
    else { return nil }
    return failure
  }
}
