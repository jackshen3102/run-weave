import Foundation

// Mirrors packages/shared/src/terminal/snapshot-share.ts.
struct TerminalSnapshotShareResponse: Decodable {
  let sharePath: String
  let title: String
  let createdAt: String
  let expiresAt: String
  let lineCount: Int

  func resolveURL(base: URL) throws -> URL {
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
      let url = URL(string: base.absoluteString + sharePath)
    else { throw APIError.invalidResponse }
    // Keep the connection's port/path prefix and the signed query unchanged.
    return url
  }
}

struct TerminalSnapshotShare: Identifiable {
  let url: URL
  var id: URL { url }
}
