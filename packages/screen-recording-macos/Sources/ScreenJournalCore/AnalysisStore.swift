import Foundation
import SQLite3

// Owned exclusively by AnalysisCoordinator. A failure here never closes records.sqlite.
final class AnalysisStore {
    private var db: OpaquePointer?
    init(paths: StorePaths) throws {
        let file = try paths.file("analysis.sqlite")
        for suffix in ["-wal", "-shm", "-journal"] { _ = try paths.file("analysis.sqlite" + suffix) }
        guard sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else { throw JournalReadError("ANALYSIS_UNAVAILABLE") }
        do {
            sqlite3_busy_timeout(db, 1000)
            let version = Int(try scalar("PRAGMA user_version") ?? "0") ?? -1
            guard (0...4).contains(version) else { throw JournalReadError("INCOMPATIBLE") }
            try execute("PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON")
            if version == 0 { try transaction { try execute(analysisSchema) } }
            if version < 2 { try transaction { try execute("CREATE TABLE agent_cursors(thread_id TEXT PRIMARY KEY,cursor TEXT NOT NULL,coverage TEXT NOT NULL); CREATE TABLE agent_events(id TEXT PRIMARY KEY,occurred_ms INTEGER NOT NULL,body TEXT NOT NULL,batch_id TEXT); PRAGMA user_version=2;") } }
            if version < 3 { try transaction { try execute("CREATE TABLE analysis_observations(batch_id TEXT PRIMARY KEY,body TEXT NOT NULL); PRAGMA user_version=3;") } }
            if version < 4 { try transaction { try execute("CREATE TABLE card_lineage(from_card TEXT NOT NULL,to_card TEXT NOT NULL,operation_id TEXT NOT NULL,kind TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(from_card,to_card,operation_id)); PRAGMA user_version=4;") } }
            try execute("PRAGMA max_page_count=49152; PRAGMA journal_size_limit=8388608")
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch { sqlite3_close(db); db = nil; throw error }
    }
    deinit { sqlite3_close(db) }
    func execute(_ sql: String, _ arguments: [Any?] = []) throws {
        if arguments.isEmpty {
            guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw error() }; return
        }
        let statement = try prepare(sql, arguments); defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_DONE else { throw error() }
    }
    func rows(_ sql: String, _ arguments: [Any?] = []) throws -> [[String: String]] {
        let statement = try prepare(sql, arguments); defer { sqlite3_finalize(statement) }
        var result: [[String: String]] = []
        while true {
            let code = sqlite3_step(statement)
            if code == SQLITE_DONE { return result }
            guard code == SQLITE_ROW else { throw error() }
            var row: [String: String] = [:]
            for index in 0..<sqlite3_column_count(statement) {
                if let value = sqlite3_column_text(statement, index) { row[String(cString: sqlite3_column_name(statement, index))] = String(cString: value) }
            }
            result.append(row)
        }
    }
    func scalar(_ sql: String, _ arguments: [Any?] = []) throws -> String? { try rows(sql, arguments).first?.values.first }
    func transaction(_ body: () throws -> Void) throws {
        try execute("BEGIN IMMEDIATE")
        do { try body(); try execute("COMMIT") } catch { try? execute("ROLLBACK"); throw error }
    }
    private func prepare(_ sql: String, _ arguments: [Any?]) throws -> OpaquePointer {
        var pointer: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &pointer, nil) == SQLITE_OK, let statement = pointer else { throw error() }
        for (offset, value) in arguments.enumerated() {
            let index = Int32(offset + 1)
            let code: Int32
            switch value {
            case let string as String: code = sqlite3_bind_text(statement, index, string, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            case let number as Int: code = sqlite3_bind_int64(statement, index, Int64(number))
            case let number as Int64: code = sqlite3_bind_int64(statement, index, number)
            case let number as UInt32: code = sqlite3_bind_int64(statement, index, Int64(number))
            case let number as Double: code = sqlite3_bind_double(statement, index, number)
            case nil: code = sqlite3_bind_null(statement, index)
            default: sqlite3_finalize(statement); throw journalError("unsupported_database_value")
            }
            if code != SQLITE_OK { sqlite3_finalize(statement); throw error() }
        }
        return statement
    }
    private func error() -> JournalError { journalError("sqlite: \(String(cString: sqlite3_errmsg(db)))") }
}

private let analysisSchema = """
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO metadata VALUES ('revision','0');
CREATE TABLE batches(id TEXT PRIMARY KEY,input_hash TEXT UNIQUE NOT NULL,day TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,
 manifest TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,worker TEXT,generation INTEGER NOT NULL DEFAULT 0,
 expires INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,error TEXT,updated INTEGER NOT NULL);
CREATE TABLE coverage(capture_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE);
CREATE TABLE attempts(batch_id TEXT NOT NULL,generation INTEGER NOT NULL,started INTEGER NOT NULL,ended INTEGER,error TEXT,PRIMARY KEY(batch_id,generation));
CREATE TABLE matters(id TEXT PRIMARY KEY,created INTEGER NOT NULL);
CREATE TABLE cards(id TEXT PRIMARY KEY,matter_id TEXT NOT NULL,day TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,updated INTEGER NOT NULL);
CREATE TABLE activity_spans(card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,actor TEXT NOT NULL);
CREATE TABLE evidence_refs(id TEXT PRIMARY KEY,body TEXT NOT NULL);
CREATE TABLE card_revisions(card_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(card_id,revision));
CREATE TABLE receipts(operation_id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE export_snapshots(id TEXT PRIMARY KEY,day TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL);
CREATE INDEX batches_queue ON batches(state,next_attempt,start_ms);
CREATE INDEX cards_day ON cards(day);
PRAGMA user_version=1;
"""
