import Foundation

struct CorrectionEntry: Codable, Sendable, Identifiable {
  let canonical: String
  var variants: [String]
  var id: String { canonical }
}
struct CorrectionLexicon: Codable, Sendable {
  let version: Int
  let entries: [CorrectionEntry]
}
struct CorrectionTerm: Codable, Sendable {
  let variant: String
  let canonical: String
}
struct SuijiCorrection: Codable, Sendable {
  let id: String
  let status: String
  let createdAt: String
  let historyId: String?
  let correctedText: String?
  let uncertainTerms: [String]?
  let suggestedTerms: [CorrectionTerm]?
  let lexiconVersion: Int?
  let error: String?
}
struct LexiconIntent: Codable, Sendable {
  let key: String
  let expectedVersion: Int
  let entries: [CorrectionEntry]
}

struct CorrectionPreferences: Codable, Sendable {
  let version: Int
  let historyEnabled: Bool
  let learningEpoch: Int
}
struct CorrectionHistoryItem: Codable, Sendable, Identifiable {
  let id: String
  let createdAt: String
  let finalizedAt: String
  let inputText: String
  let correctedText: String
  let finalText: String
  let recordId: String
  let recordVersion: Int
}
struct CorrectionHistoryPage: Codable, Sendable {
  let items: [CorrectionHistoryItem]
  let nextCursor: String?
}
struct CorrectionTrace: Codable, Sendable {
  let correctionId: String
  let inputText: String
  let correctedText: String
  let applied: Bool
}
struct CorrectionFeedbackIntent: Codable, Sendable {
  let correctionId: String
  let key: String
  let recordId: String
  let recordVersion: Int
  let saveKey: String
}
