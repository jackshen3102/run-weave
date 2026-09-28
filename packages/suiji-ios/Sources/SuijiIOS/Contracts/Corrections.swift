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
