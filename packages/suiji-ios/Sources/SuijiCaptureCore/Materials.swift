import Foundation

public struct MaterialInput: Codable, Equatable, Sendable {
  public var captureId: String
  public var capturedAt: String
  public var materialDate: String
  public var inputType: String
  public var sourceUrl: String?
  public init(inputType: String = "text", sourceUrl: String? = nil, date: Date = Date()) {
    captureId = UUID().uuidString
    capturedAt = ISO8601DateFormatter().string(from: Date())
    materialDate = Self.day(date); self.inputType = inputType; self.sourceUrl = sourceUrl
  }
  public static func day(_ date: Date) -> String {
    let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "Asia/Shanghai"); formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
  }
  public var date: Date { ISO8601DateFormatter().date(from: materialDate + "T00:00:00+08:00") ?? Date() }
}
public struct MaterialMetadata: Codable, Equatable, Sendable {
  public let captureId: String
  public let capturedAt: String
  public let materialDate: String
  public let inputType: String
  public let sourceUrl: String?
  public let sourceHash: String
  public let processedVersion: Int?
  public let processedAt: String?
  public var input: MaterialInput {
    var value = MaterialInput(inputType: inputType, sourceUrl: sourceUrl)
    value.captureId = captureId; value.capturedAt = capturedAt; value.materialDate = materialDate; return value
  }
  public func status(version: Int) -> String {
    processedVersion == version ? "已整理" : processedVersion == nil ? "待整理" : "待重新整理"
  }
  public var typeLabel: String { inputType == "image" ? "截图" : inputType == "link" ? "链接" : "文字" }
}
