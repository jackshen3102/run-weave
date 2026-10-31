import Foundation
import SQLite3

final class RecordStore {
    private var db: OpaquePointer?
    let paths: StorePaths
    let readOnly: Bool
    init(paths: StorePaths, readOnly: Bool = false) throws {
        self.paths = paths; self.readOnly = readOnly
        let file = try paths.file("records.sqlite")
        for suffix in ["-wal", "-shm", "-journal"] { _ = try paths.file("records.sqlite" + suffix) }
        let flags = readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE
        guard sqlite3_open_v2(file.path, &db, flags | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else { throw journalError("database_open_failed") }
        sqlite3_busy_timeout(db, 5000)
        do {
            let version = Int(try scalar("PRAGMA user_version") ?? "0") ?? -1
            guard version <= 1 else { throw journalError("schema_too_new: \(version)") }
            try execute("PRAGMA foreign_keys=ON")
            if !readOnly {
                try execute("PRAGMA journal_mode=WAL"); try execute("PRAGMA synchronous=FULL")
                try execute("PRAGMA auto_vacuum=INCREMENTAL")
                if version == 0 { try transaction { try execute(storeSchema); try execute("INSERT INTO device VALUES (?,?)", [UUID().uuidString, Date().timeIntervalSince1970]) } }
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            } else { try execute("PRAGMA query_only=ON") }
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
    func event(_ state: String, _ reason: String, affected: Int = 0, at: Date = Date()) throws {
        let now = at.timeIntervalSince1970
        let last = try rows("SELECT * FROM state_events ORDER BY id DESC LIMIT 1").first
        if let last, last["state"] == state, last["reason"] == reason {
            try execute("UPDATE state_events SET ended=?, affected=affected+? WHERE id=?", [now, affected, last["id"]])
        } else {
            if let last, let id = last["id"] { try execute("UPDATE state_events SET ended=? WHERE id=?", [now, id]) }
            try execute("INSERT INTO state_events(started,ended,state,reason,affected) VALUES (?,?,?,?,?)", [now, now, state, reason, affected])
        }
        try execute("DELETE FROM state_events WHERE id NOT IN (SELECT id FROM state_events ORDER BY id DESC LIMIT 10000)")
    }
    func segments() throws -> [SegmentRecord] {
        try rows("SELECT * FROM segments ORDER BY started,id").map { row in
            guard let id = row["id"], UUID(uuidString: id) != nil, let path = row["path"], let state = row["state"],
                  let start = Double(row["started"] ?? ""), let end = Double(row["ended"] ?? ""),
                  let width = Int(row["width"] ?? ""), let height = Int(row["height"] ?? ""),
                  let display = UInt32(row["display_id"] ?? ""), let frames = Int(row["frames"] ?? "") else { throw journalError("invalid_segment_row") }
            guard path == "pending/\(id).mp4" || path == "media/\(id).mp4" else { throw journalError("invalid_segment_path") }
            return SegmentRecord(id: id, path: path, state: state, start: start, end: end, width: width, height: height, displayID: display, frames: frames)
        }
    }
    func checkpoint() throws { try execute("PRAGMA wal_checkpoint(TRUNCATE)"); try execute("PRAGMA incremental_vacuum") }
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
