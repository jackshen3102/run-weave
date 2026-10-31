import Foundation

struct AnalysisSearchRequest: Codable {
    let q: String; let from: String; let to: String; var limit: Int? = nil
}
struct AnalysisSearchItem: Codable, Identifiable {
    var id: String { cardID }
    let day: String; let cardID: String; let matterID: String; let revision: Int
    let title: String; let summary: String; let actor: String; let state: String
    let firstStartMs: Int64; let lastEndMs: Int64; let spanCount: Int
    let matchedFields: [String]
}
struct AnalysisSearchResponse: Codable {
    var schemaVersion = 1
    let deviceID: String; let serverEpoch: String; let revision: Int
    var timeZone = "Asia/Shanghai"
    let q: String; let from: String; let to: String
    let items: [AnalysisSearchItem]; let hasMore: Bool
}
func analysisASCIILower(_ text: String) -> String {
    String(String.UnicodeScalarView(text.unicodeScalars.map { scalar in
        (65...90).contains(scalar.value) ? UnicodeScalar(scalar.value + 32)! : scalar
    }))
}
struct AnalysisSearchQuery {
    let q: String; let from: String; let to: String; let limit: Int; let terms: [String]
    init(_ request: AnalysisSearchRequest, now: Int64) throws {
        guard request.q.utf8.count <= 48000,
              !request.q.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) && !CharacterSet.whitespacesAndNewlines.contains($0) }) else { throw JournalReadError("INVALID_ARGUMENT") }
        var seen = Set<Data>()
        terms = request.q.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty && seen.insert(Data(analysisASCIILower($0).utf8)).inserted }
        q = terms.joined(separator: " ")
        limit = request.limit ?? 100; from = request.from; to = request.to
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai"); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        func validDay(_ value: String) -> Bool {
            guard value.utf8.count == 10, let date = formatter.date(from: value) else { return false }
            return formatter.string(from: date) == value
        }
        guard !terms.isEmpty, terms.count <= 8, q.unicodeScalars.count <= 100, (1...100).contains(limit),
              validDay(from), validDay(to), from <= to,
              from >= analysisDay(now-29*86400000), to <= analysisDay(now) else { throw JournalReadError("INVALID_ARGUMENT") }
    }
}

extension AnalysisStore {
    func search(_ query: AnalysisSearchQuery, cutoff: Int64) throws -> [AnalysisSearchItem] {
        try withQueryBudget {
            // Validate all in-range JSON before filtering; corrupt records cannot look like no matches.
            let range: [Any?] = [query.from, query.to, cutoff]
            if try scalar("SELECT 1 FROM cards WHERE day BETWEEN ? AND ? AND updated>=? AND NOT json_valid(body) LIMIT 1", range) != nil {
                throw JournalReadError("ANALYSIS_UNAVAILABLE")
            }
            let invalid = """
            SELECT 1 FROM cards c WHERE day BETWEEN ? AND ? AND updated>=? AND (
              json_type(body) != 'object' OR
              COALESCE(json_type(body,'$.title'),'null') NOT IN ('null','text') OR
              COALESCE(json_type(body,'$.summary'),'null') NOT IN ('null','text') OR
              COALESCE(json_type(body,'$.spans'),'null') != 'array' OR json_array_length(body,'$.spans')=0 OR
              COALESCE(json_extract(body,'$.actor'),'') NOT IN ('person','agent','mixed') OR
              COALESCE(json_extract(body,'$.state'),'') NOT IN ('discussed','attempted','progress','agent-reported','verified','documented') OR
              EXISTS (SELECT 1 FROM json_each(body,'$.spans') s WHERE
                COALESCE(json_type(s.value,'$.startMs'),'null') != 'integer' OR
                COALESCE(json_type(s.value,'$.endMs'),'null') != 'integer' OR
                json_extract(s.value,'$.endMs') < json_extract(s.value,'$.startMs'))
            ) LIMIT 1
            """
            guard try scalar(invalid, range) == nil else { throw JournalReadError("ANALYSIS_UNAVAILABLE") }
            let match = "(instr(lower(COALESCE(json_extract(c.body,'$.title'),'')),lower(?))>0 OR instr(lower(COALESCE(json_extract(c.body,'$.summary'),'')),lower(?))>0)"
            let sql = """
            SELECT c.day,c.id,c.matter_id,c.revision,
              COALESCE(json_extract(c.body,'$.title'),'') AS title,
              COALESCE(json_extract(c.body,'$.summary'),'') AS summary,
              json_extract(c.body,'$.actor') AS actor,json_extract(c.body,'$.state') AS state,
              (SELECT MIN(json_extract(value,'$.startMs')) FROM json_each(c.body,'$.spans')) AS firstStartMs,
              (SELECT MAX(json_extract(value,'$.endMs')) FROM json_each(c.body,'$.spans')) AS lastEndMs,
              json_array_length(c.body,'$.spans') AS spanCount
            FROM cards c WHERE c.day BETWEEN ? AND ? AND c.updated>=? AND
            \(Array(repeating: match,count: query.terms.count).joined(separator: " AND "))
            ORDER BY lastEndMs DESC,c.id DESC LIMIT ?
            """
            let bindings: [String] = query.terms.flatMap { [$0, $0] }
            let args: [Any?] = range + bindings.map { $0 as Any? } + [query.limit+1]
            return try rows(sql, args).map { row in
                guard let day = row["day"], let id = row["id"], let matter = row["matter_id"],
                      let revision = row["revision"].flatMap(Int.init), let title = row["title"], let summary = row["summary"],
                      let actor = row["actor"], let state = row["state"],
                      let first = row["firstStartMs"].flatMap(Int64.init), let last = row["lastEndMs"].flatMap(Int64.init),
                      let count = row["spanCount"].flatMap(Int.init) else { throw JournalReadError("ANALYSIS_UNAVAILABLE") }
                let terms = query.terms.map(analysisASCIILower)
                let fields = [("title",title),("summary",summary)].compactMap { field, text in
                    terms.contains(where: { Data(analysisASCIILower(text).utf8).range(of: Data($0.utf8)) != nil }) ? field : nil
                }
                return AnalysisSearchItem(day: day, cardID: id, matterID: matter, revision: revision, title: title,
                    summary: summary, actor: actor, state: state, firstStartMs: first, lastEndMs: last, spanCount: count, matchedFields: fields)
            }
        }
    }
}
