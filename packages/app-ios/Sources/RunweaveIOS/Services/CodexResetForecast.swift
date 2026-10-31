import Foundation

struct CodexResetForecast {
  static let sourceURL = URL(string: "https://codexreset.org/")!

  let within24Hours: Double
  let within48Hours: Double
  let checkedAt: Date?

  static func fetch() async throws -> Self {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 20
    configuration.timeoutIntervalForResource = 25
    configuration.httpCookieStorage = nil
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }

    var request = URLRequest(url: sourceURL, cachePolicy: .reloadIgnoringLocalCacheData)
    request.setValue("text/html", forHTTPHeaderField: "Accept")
    let (bytes, response) = try await session.bytes(for: request)
    guard let response = response as? HTTPURLResponse, response.statusCode == 200,
      response.mimeType == "text/html" else { throw URLError(.badServerResponse) }

    // The public page renders the final forecast in these rings. Stop reading once
    // both probabilities arrive; the rest is a large history page.
    var data = Data()
    for try await byte in bytes {
      data.append(byte)
      if data.count.isMultiple(of: 4096), let forecast = parse(data) { return forecast }
      guard data.count < 131_072 else { throw URLError(.cannotParseResponse) }
    }
    guard let forecast = parse(data) else { throw URLError(.cannotParseResponse) }
    return forecast
  }

  static func parse(_ data: Data) -> Self? {
    let html = String(decoding: data, as: UTF8.self)
    func capture(_ pattern: String, in text: String) -> String? {
      guard let expression = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive),
        let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
        let range = Range(match.range(at: 1), in: text) else { return nil }
      return String(text[range])
    }
    func probability(_ horizon: String) -> Double? {
      guard let tag = capture(
        #"(<[^>]*\bdata-testid=["']probability-ring-"# + horizon + #"["'][^>]*>)"#, in: html),
        let raw = capture(#"\bdata-target-value=["']([0-9]+(?:\.[0-9]+)?)["']"#, in: tag),
        let value = Double(raw), (0...100).contains(value) else { return nil }
      return value
    }
    guard let p24 = probability("24h"), let p48 = probability("48h"), p24 <= p48
      else { return nil }
    let timestamp = capture(#"Last check[\s\S]{0,500}?<time\b[^>]*\bdatetime=["']([^"']+)["']"#, in: html)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let checkedAt = timestamp.flatMap { formatter.date(from: $0) }
    return Self(within24Hours: p24, within48Hours: p48, checkedAt: checkedAt)
  }
}
