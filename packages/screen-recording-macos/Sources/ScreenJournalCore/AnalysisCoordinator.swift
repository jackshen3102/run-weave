import Foundation

actor AnalysisCoordinator {
    private let store: AnalysisStore
    private let engine: StorageEngine
    private let deviceID: String
    init(paths: StorePaths, engine: StorageEngine, deviceID: String) throws {
        store = try AnalysisStore(paths: paths); self.engine = engine; self.deviceID = deviceID
    }
    private var lastMaintenance: Int64 = 0
    func maintain() throws {
        let now = journalNowMs()
        guard now-lastMaintenance >= 3600000 else { return }
        let cutoff = now-30*86400000
        let affectedDays = try store.rows("SELECT DISTINCT day FROM cards WHERE updated<? UNION SELECT DISTINCT day FROM batches WHERE end_ms<?", [cutoff,cutoff])
        try store.transaction {
            try store.execute("DELETE FROM analysis_observations WHERE batch_id IN (SELECT id FROM batches WHERE end_ms<?)", [cutoff])
            try store.execute("DELETE FROM attempts WHERE batch_id IN (SELECT id FROM batches WHERE end_ms<?)", [cutoff])
            try store.execute("DELETE FROM batches WHERE end_ms<?", [cutoff])
            try store.execute("DELETE FROM cards WHERE updated<?", [cutoff])
            try store.execute("DELETE FROM card_revisions WHERE created<?", [cutoff])
            try store.execute("DELETE FROM card_lineage WHERE created<?", [cutoff])
            try store.execute("DELETE FROM receipts WHERE created<?", [cutoff])
            try store.execute("DELETE FROM export_snapshots WHERE created<?", [cutoff])
            try store.execute("DELETE FROM agent_events WHERE occurred_ms<?", [cutoff])
            try store.execute("DELETE FROM matters WHERE id NOT IN (SELECT matter_id FROM cards)")
            try store.execute("DELETE FROM evidence_refs WHERE id NOT IN (SELECT DISTINCT json_each.value FROM cards,json_each(cards.body,'$.evidenceIDs'))")
            for row in affectedDays { if let day = row["day"] { try changed(day: day) } }
        }
        try store.execute("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum(2048)")
        lastMaintenance = now
    }
    private func revision() throws -> Int { Int(try store.scalar("SELECT value FROM metadata WHERE key='revision'") ?? "0") ?? 0 }
    private func dayRevision(_ day: String) throws -> Int { Int(try store.scalar("SELECT value FROM metadata WHERE key=?", ["dayRevision:"+day]) ?? "0") ?? 0 }
    private func changed(day: String) throws {
        try store.execute("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'")
        try store.execute("INSERT INTO metadata VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1", ["dayRevision:"+day])
    }
    func observeSource(_ revision: String, day: String) throws {
        let fingerprint = revision + ":" + (try store.scalar("SELECT value FROM metadata WHERE key='effectiveFrom'") ?? "disabled")
        if try store.scalar("SELECT value FROM metadata WHERE key=?", ["sourceRevision:"+day]) != fingerprint {
            try store.transaction {
                try store.execute("INSERT OR REPLACE INTO metadata VALUES (?,?)", ["sourceRevision:"+day,fingerprint]); try changed(day: day)
            }
        }
    }
    private func decode<T: Decodable>(_ text: String, as: T.Type = T.self) throws -> T { try JSONDecoder().decode(T.self, from: Data(text.utf8)) }
    private func cards(day: String? = nil) throws -> [AnalysisCard] {
        let rows = try store.rows("SELECT body FROM cards" + (day == nil ? "" : " WHERE day=?") + " ORDER BY updated,id", day.map { [$0] } ?? [])
        return try rows.map { try decode($0["body"] ?? "") }
    }
    private func contextEvidence(_ context: [AnalysisCard]) throws -> [AnalysisEvidence] {
        try Set(context.flatMap(\.evidenceIDs)).sorted().compactMap { id in
            guard let body = try store.scalar("SELECT body FROM evidence_refs WHERE id=?", [id]) else { return nil }
            return try decode(body)
        }
    }
    func status() throws -> AnalysisStatus {
        let reconciled = try store.scalar("SELECT value FROM metadata WHERE key='scanReconciledAt'") != nil
        let through = reconciled ? try store.scalar("SELECT MAX(end_ms) FROM batches WHERE state='complete' AND end_ms < COALESCE((SELECT MIN(start_ms) FROM batches WHERE state!='complete'),9223372036854775807)").flatMap(Int64.init) : nil
        return AnalysisStatus(deviceID: deviceID, state: "ready", revision: try revision(),
            queueCount: Int(try store.scalar("SELECT COUNT(*) FROM batches WHERE state IN ('pending','running')") ?? "0") ?? 0,
            failedCount: Int(try store.scalar("SELECT COUNT(*) FROM batches WHERE state IN ('failed','source-expired')") ?? "0") ?? 0,
            latestSuccessMs: try store.scalar("SELECT MAX(updated) FROM batches WHERE state='complete'").flatMap(Int64.init),
            processedThroughMs: through, days: try store.rows("SELECT DISTINCT day FROM cards UNION SELECT DISTINCT day FROM batches ORDER BY day DESC").compactMap { $0["day"] })
    }
    // Scan physical insertion order, repeatedly wrapping. A late ready segment is
    // rediscovered even when its wall time is older than already processed work.
    private func discover(effectiveFrom: Int64, settings: RecordingSettings, captureState: String) async throws {
        let cursor = Int64(try store.scalar("SELECT value FROM metadata WHERE key='scanCursor'") ?? "0") ?? 0
        let page = try await engine.analysisPage(after: cursor, settings: settings)
        var fresh: [JournalCapture] = []
        for frame in page.frames where frame.capture.capturedAtMs >= effectiveFrom {
            if try store.scalar("SELECT capture_id FROM coverage WHERE capture_id=?", [frame.capture.id]) == nil { fresh.append(frame.capture) }
        }
        var groups: [[JournalCapture]] = []; var group: [JournalCapture] = []
        for frame in fresh {
            if let first = group.first, let last = group.last,
               frame.sessionID != last.sessionID || frame.capturedAtMs < last.capturedAtMs || frame.capturedAtMs - last.capturedAtMs > 120000 || analysisDay(frame.capturedAtMs) != analysisDay(first.capturedAtMs) || frame.capturedAtMs - first.capturedAtMs >= 900000 {
                groups.append(group); group = []
            }
            group.append(frame)
        }
        if !group.isEmpty { groups.append(group) }
        let now = journalNowMs()
        // Four newly frozen batches per pass. Cursor advances only when all
        // candidates have been inspected; waiting tails are found on the next wrap.
        var created = 0
        for (index, captures) in groups.enumerated() {
            guard created < 4, let first = captures.first, let last = captures.last else { break }
            let mature = last.capturedAtMs - first.capturedAtMs >= 890000 || index < groups.count - 1 || captureState != "recording" || now - last.capturedAtMs >= 1200000 || analysisDay(last.capturedAtMs) != analysisDay(now)
            guard mature else { continue }
            let context = try cards().filter { $0.spans.contains { $0.endMs >= first.capturedAtMs - 2700000 && $0.startMs <= first.capturedAtMs } }
            let inputHash = analysisHash(try analysisJSON(captures) + analysisJSON(context) + "screen-timeline-v1")
            let id = UUID().uuidString
            let evidence = captures.filter { !$0.privacyPlaceholder }.map { AnalysisEvidence(id: $0.id, source: "screen", occurredAtMs: $0.capturedAtMs, captureID: $0.id) }
            let manifest = AnalysisManifest(batchID: id, deviceID: deviceID, day: analysisDay(first.capturedAtMs), inputHash: inputHash,
                promptVersion: "screen-timeline-v1", startMs: first.capturedAtMs, endMs: last.capturedAtMs, captures: captures,
                intervals: JournalReadCatalog.intervals(for: captures, events: []), context: context, evidence: evidence + (try contextEvidence(context)), agentCoverage: "unknown")
            try store.transaction {
                try store.execute("INSERT INTO batches(id,input_hash,day,start_ms,end_ms,manifest,state,updated) VALUES (?,?,?,?,?,?,'pending',?)", [id,inputHash,manifest.day,manifest.startMs,manifest.endMs,try analysisJSON(manifest),now])
                for c in captures { try store.execute("INSERT INTO coverage VALUES (?,?)", [c.id,id]) }
                try changed(day: manifest.day)
            }
            created += 1
        }
        if created < 4 {
            try store.execute("INSERT OR REPLACE INTO metadata VALUES ('scanCursor',?)", [String(page.cursor)])
            if page.frames.isEmpty { try store.execute("INSERT OR REPLACE INTO metadata VALUES ('scanReconciledAt',?)", [String(now)]) }
        }
    }
    func agentCursor(deviceID: String, threadID: String) throws -> [String:String] {
        guard deviceID == self.deviceID else { throw JournalReadError("CONFLICT") }
        let cursor = try store.scalar("SELECT cursor FROM agent_cursors WHERE thread_id=?", [threadID]) ?? ""
        return ["cursor":cursor,"threadAfter":cursor]
    }
    func ingest(deviceID: String, threadID: String, expected: String, cursor: String, coverage: String, events: [AnalysisAgentEvent]) throws {
        guard deviceID == self.deviceID, cursor.utf8.count <= 1024, ["complete","partial","unavailable"].contains(coverage), events.count <= 100,
              try analysisJSON(events).utf8.count <= 32000 else { throw JournalReadError("INVALID_ARGUMENT") }
        let current = try agentCursor(deviceID: deviceID,threadID: threadID)["cursor"] ?? ""
        if current == cursor, current != expected { return }
        guard current == expected else { throw JournalReadError("CONFLICT") }
        for event in events {
            guard event.threadID == threadID, event.provider == "codex", ["assistant","tool"].contains(event.kind), !event.id.isEmpty,
                  event.id.count <= 200, event.eventID.count <= 256, event.occurredAtMs > 0, event.occurredAtMs <= journalNowMs()+60000,
                  event.text.utf8.count <= 32000, !event.independentSuccess || event.kind == "tool" else { throw JournalReadError("INVALID_ARGUMENT") }
        }
        try store.transaction {
            for event in events where !event.derived {
                try store.execute("INSERT OR IGNORE INTO agent_events VALUES (?,?,?,NULL)", [event.id,event.occurredAtMs,try analysisJSON(event)])
            }
            try store.execute("INSERT OR REPLACE INTO agent_cursors VALUES (?,?,?)", [threadID,cursor,coverage])
        }
    }
    private func discoverAgents() throws {
        let rows = try store.rows("SELECT id,body FROM agent_events WHERE batch_id IS NULL ORDER BY occurred_ms,id LIMIT 100")
        var events: [AnalysisAgentEvent] = []; var bytes = 0
        for row in rows {
            let event: AnalysisAgentEvent = try decode(row["body"] ?? "")
            if let first = events.first, analysisDay(first.occurredAtMs) != analysisDay(event.occurredAtMs) || event.occurredAtMs-first.occurredAtMs > 900000 { break }
            if bytes + event.text.utf8.count > 32000 { break }
            events.append(event); bytes += event.text.utf8.count
        }
        guard let first = events.first, let last = events.last else { return }
        let context = try cards().filter { $0.spans.contains { $0.endMs >= first.occurredAtMs-2700000 && $0.startMs <= first.occurredAtMs } }
        let id = UUID().uuidString, now = journalNowMs()
        let evidence = events.map { AnalysisEvidence(id: $0.id,source: "agent",occurredAtMs: $0.occurredAtMs,provider: $0.provider,threadID: $0.threadID,eventID: $0.eventID,text: $0.text,kind: $0.kind,independentSuccess: $0.independentSuccess) }
        let manifest = AnalysisManifest(batchID: id,deviceID: deviceID,day: analysisDay(first.occurredAtMs),inputHash: analysisHash(try analysisJSON(events)+analysisJSON(context)),promptVersion: "screen-timeline-v1",startMs: first.occurredAtMs,endMs: last.occurredAtMs,captures: [],intervals: [],context: context,evidence: evidence + (try contextEvidence(context)),agentCoverage: "partial")
        try store.transaction {
            try store.execute("INSERT INTO batches(id,input_hash,day,start_ms,end_ms,manifest,state,updated) VALUES (?,?,?,?,?,?,'pending',?)", [id,manifest.inputHash,manifest.day,manifest.startMs,manifest.endMs,try analysisJSON(manifest),now])
            for event in events { try store.execute("UPDATE agent_events SET batch_id=? WHERE id=?", [id,event.id]) }
            try changed(day: manifest.day)
        }
    }
    func claim(workerID: String, expectedDeviceID: String, effectiveFrom: Int64, settings: RecordingSettings, captureState: String) async throws -> AnalysisClaim? {
        guard expectedDeviceID == deviceID, UUID(uuidString: workerID) != nil, effectiveFrom > 0, effectiveFrom <= journalNowMs() else { throw JournalReadError("INVALID_ARGUMENT") }
        try maintain()
        // Discovery awaits the capture actor, so re-check leases after the await.
        try await discover(effectiveFrom: effectiveFrom, settings: settings, captureState: captureState)
        try discoverAgents()
        let now = journalNowMs()
        try store.execute("INSERT OR IGNORE INTO metadata VALUES ('effectiveFrom',?)", [String(effectiveFrom)])
        if try store.scalar("SELECT id FROM batches WHERE state='running' AND expires>? LIMIT 1", [now]) != nil { return nil }
        let expiredDays = try store.rows("SELECT DISTINCT day FROM batches WHERE state='running' AND expires<=?", [now])
        try store.transaction {
            try store.execute("UPDATE batches SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,error='LEASE_EXPIRED' WHERE state='running' AND expires<=?", [now])
            for row in expiredDays { if let day = row["day"] { try changed(day: day) } }
        }
        guard let row = try store.rows("SELECT * FROM batches WHERE state='pending' AND attempts<3 AND next_attempt<=? ORDER BY start_ms,id LIMIT 1", [now]).first,
              let id = row["id"] else { return nil }
        let manifest: AnalysisManifest = try decode(row["manifest"] ?? "")
        if manifest.captures.contains(where: { $0.availableUntilMs <= now }) {
            try store.transaction {
                try store.execute("UPDATE batches SET state='source-expired',error='SOURCE_EXPIRED',updated=? WHERE id=?", [now,id]); try changed(day: manifest.day)
            }; return nil
        }
        let generation = (Int(row["generation"] ?? "0") ?? 0) + 1
        let attempt = (Int(row["attempts"] ?? "0") ?? 0) + 1
        try store.transaction {
            try store.execute("UPDATE batches SET state='running',worker=?,generation=?,attempts=?,expires=?,updated=? WHERE id=?", [workerID,generation,attempt,now+300000,now,id])
            try store.execute("INSERT INTO attempts(batch_id,generation,started) VALUES (?,?,?)", [id,generation,now])
            try changed(day: manifest.day)
        }
        return AnalysisClaim(manifest: manifest, workerID: workerID, generation: generation, expiresAt: now+300000, attempt: attempt)
    }
    private func owned(batchID: String, workerID: String, generation: Int) throws -> AnalysisManifest {
        guard let row = try store.rows("SELECT manifest FROM batches WHERE id=? AND worker=? AND generation=? AND state='running' AND expires>?", [batchID,workerID,generation,journalNowMs()]).first else { throw JournalReadError("LEASE_LOST") }
        return try decode(row["manifest"] ?? "")
    }
    func renew(batchID: String, workerID: String, generation: Int) throws -> Int64 {
        _ = try owned(batchID: batchID, workerID: workerID, generation: generation)
        let expires = journalNowMs()+300000
        try store.execute("UPDATE batches SET expires=? WHERE id=?", [expires,batchID]); return expires
    }
    func frame(batchID: String, workerID: String, generation: Int, captureID: String) throws -> JournalCapture {
        let manifest = try owned(batchID: batchID, workerID: workerID, generation: generation)
        guard let frame = manifest.captures.first(where: { $0.id == captureID && !$0.privacyPlaceholder && $0.availableUntilMs > journalNowMs() }) else { throw JournalReadError("FRAME_GONE") }
        return frame
    }
    func fail(batchID: String, workerID: String, generation: Int, code: String) throws {
        let manifest = try owned(batchID: batchID, workerID: workerID, generation: generation)
        let attempts = Int(try store.scalar("SELECT attempts FROM batches WHERE id=?", [batchID]) ?? "3") ?? 3
        let now = journalNowMs()
        try store.transaction {
            try store.execute("UPDATE batches SET state=?,error=?,next_attempt=?,expires=0,updated=? WHERE id=?", [attempts >= 3 ? "failed" : "pending",code,now+(attempts == 1 ? 60000 : 300000),now,batchID])
            try store.execute("UPDATE attempts SET ended=?,error=? WHERE batch_id=? AND generation=?", [now,code,batchID,generation])
            try changed(day: manifest.day)
        }
    }
    func receipt(_ operationID: String) throws -> AnalysisReceipt? {
        guard let body = try store.scalar("SELECT body FROM receipts WHERE operation_id=?", [operationID]) else { return nil }; return try decode(body)
    }
    func commit(batchID: String, workerID: String, generation: Int, operationID: String, inputHash: String, result: AnalysisResult) throws -> AnalysisReceipt {
        let bodyHash = analysisHash(inputHash + (try analysisJSON(result)))
        if let row = try store.rows("SELECT input_hash,body FROM receipts WHERE operation_id=?", [operationID]).first {
            guard row["input_hash"] == bodyHash else { throw JournalReadError("CONFLICT") }; return try decode(row["body"] ?? "")
        }
        let manifest = try owned(batchID: batchID, workerID: workerID, generation: generation)
        guard manifest.inputHash == inputHash, result.cards.count <= 32, result.observation.utf8.count <= 4000 else { throw JournalReadError("INVALID_ARGUMENT") }
        let allowed = Set(manifest.evidence.map(\.id)); let now = journalNowMs()
        guard manifest.captures.allSatisfy({ $0.availableUntilMs > now }) else { throw JournalReadError("FRAME_GONE") }
        let replacements = result.replacements ?? []
        guard replacements.count <= 32, (result.rewriteSpan != nil) == !replacements.isEmpty else { throw JournalReadError("INVALID_ARGUMENT") }
        let replaced = Set(replacements.map(\.cardID))
        guard replaced.count == replacements.count else { throw JournalReadError("INVALID_ARGUMENT") }
        if let rewrite = result.rewriteSpan {
            guard rewrite.startMs >= manifest.startMs-2700000, rewrite.endMs <= manifest.endMs, rewrite.endMs >= rewrite.startMs else { throw JournalReadError("INVALID_ARGUMENT") }
            for item in replacements {
                guard let old = manifest.context.first(where: { $0.cardID == item.cardID }), old.revision == item.baseRevision,
                      Int(try store.scalar("SELECT revision FROM cards WHERE id=?", [item.cardID]) ?? "-1") == item.baseRevision,
                      old.spans.allSatisfy({ $0.startMs >= rewrite.startMs && $0.endMs <= rewrite.endMs && analysisDay($0.startMs) == manifest.day }),
                      !item.targetIndexes.isEmpty, Set(item.targetIndexes).count == item.targetIndexes.count,
                      item.targetIndexes.allSatisfy({ result.cards.indices.contains($0) }) else { throw JournalReadError("CONFLICT") }
            }
        }
        let previousSpans = manifest.context.filter { replaced.contains($0.cardID) }.flatMap(\.spans)
        var output: [AnalysisCard] = []
        // Existing primary activity is protected as well as other cards in this
        // response. Late source material cannot double count an occupied span.
        var mainSpans = try cards(day: manifest.day).filter { !replaced.contains($0.cardID) }.flatMap(\.spans).filter { $0.actor != "agent" }
        for (cardIndex, card) in result.cards.enumerated() {
            guard !card.title.isEmpty, card.title.count <= 200, card.summary.count <= 2000, card.detail.count <= 8000,
                  ["person","agent","mixed"].contains(card.actor), ["discussed","documented","attempted","progress","agent-reported","verified"].contains(card.state),
                  !card.evidenceIDs.isEmpty, Set(card.evidenceIDs).isSubset(of: allowed), !card.spans.isEmpty, card.spans.count <= 32 else { throw JournalReadError("INVALID_ARGUMENT") }
            // Screen-only input cannot establish background execution or success.
            let refs = manifest.evidence.filter { card.evidenceIDs.contains($0.id) }
            guard card.state != "verified" || refs.contains(where: { $0.source == "agent" && $0.kind == "tool" && $0.independentSuccess == true }) else { throw JournalReadError("INVALID_ARGUMENT") }
            let onlyScreen = refs.allSatisfy { $0.source == "screen" }
            let onlyAgent = refs.allSatisfy { $0.source == "agent" }
            guard !onlyScreen || (card.actor == "person" && ["discussed","documented"].contains(card.state)) else { throw JournalReadError("INVALID_ARGUMENT") }
            guard !onlyAgent || card.actor == "agent" else { throw JournalReadError("INVALID_ARGUMENT") }
            for span in card.spans {
                guard span.actor == card.actor, span.startMs >= (result.rewriteSpan?.startMs ?? manifest.startMs), span.endMs <= manifest.endMs, span.endMs >= span.startMs,
                      !manifest.intervals.contains(where: { $0.startMs < span.endMs && $0.endMs > span.startMs }) else { throw JournalReadError("INVALID_ARGUMENT") }
                if span.startMs < manifest.startMs {
                    // Historical rewriting can use only an already evidenced
                    // contiguous span, never fill a previous sampling gap.
                    guard previousSpans.contains(where: { $0.actor == span.actor && $0.startMs <= span.startMs && $0.endMs >= min(span.endMs,manifest.startMs) }) else { throw JournalReadError("INVALID_ARGUMENT") }
                }
                guard span.actor == "agent" || !mainSpans.contains(where: { $0.startMs < span.endMs && $0.endMs > span.startMs }) else { throw JournalReadError("CONFLICT") }
                if span.actor != "agent" { mainSpans.append(span) }
            }
            if let id = card.cardID, replaced.contains(id) {
                guard replacements.contains(where: { $0.cardID == id && $0.targetIndexes.contains(cardIndex) }) else { throw JournalReadError("INVALID_ARGUMENT") }
            }
            var previous: AnalysisCard?
            if let id = card.cardID {
                previous = manifest.context.first { $0.cardID == id }
                guard let old = previous, old.revision == card.baseRevision, old.matterID == card.matterID, old.spans.allSatisfy({ analysisDay($0.startMs) == manifest.day }),
                      Int(try store.scalar("SELECT revision FROM cards WHERE id=?", [id]) ?? "-1") == old.revision else { throw JournalReadError("CONFLICT") }
            } else {
                guard card.baseRevision == nil else { throw JournalReadError("INVALID_ARGUMENT") }
                if let matter = card.matterID { guard manifest.context.contains(where: { $0.matterID == matter }) else { throw JournalReadError("INVALID_ARGUMENT") } }
            }
            output.append(AnalysisCard(cardID: previous?.cardID ?? UUID().uuidString, matterID: previous?.matterID ?? card.matterID ?? UUID().uuidString,
                revision: (previous?.revision ?? 0)+1, title: card.title, summary: card.summary, detail: card.detail, actor: card.actor, state: card.state,
                projectID: card.projectID, spans: (previous.map { replaced.contains($0.cardID) ? [] : $0.spans } ?? []) + card.spans, evidenceIDs: Array(Set((previous?.evidenceIDs ?? []) + card.evidenceIDs)).sorted(), updatedAt: now))
        }
        guard Set(output.map(\.cardID)).count == output.count else { throw JournalReadError("INVALID_ARGUMENT") }
        let next = try dayRevision(manifest.day)+1
        let receipt = AnalysisReceipt(operationID: operationID,batchID: batchID,revision: next,cardIDs: output.map(\.cardID))
        try store.transaction {
            for item in replacements {
                for target in item.targetIndexes {
                    let targetID = output[target].cardID
                    let kind = item.targetIndexes.count > 1 ? "split" : replacements.filter { $0.targetIndexes.contains(target) }.count > 1 ? "merge" : "rewrite"
                    try store.execute("INSERT INTO card_lineage VALUES (?,?,?,?,?)", [item.cardID,targetID,operationID,kind,now])
                }
                if !output.contains(where: { $0.cardID == item.cardID }) { try store.execute("DELETE FROM cards WHERE id=?", [item.cardID]) }
            }
            for card in output {
                let body = try analysisJSON(card)
                try store.execute("INSERT OR IGNORE INTO matters VALUES (?,?)", [card.matterID,now])
                try store.execute("INSERT OR REPLACE INTO cards VALUES (?,?,?,?,?,?)", [card.cardID,card.matterID,manifest.day,card.revision,body,now])
                try store.execute("INSERT INTO card_revisions VALUES (?,?,?,?)", [card.cardID,card.revision,body,now])
                try store.execute("DELETE FROM activity_spans WHERE card_id=?", [card.cardID])
                for span in card.spans { try store.execute("INSERT INTO activity_spans VALUES (?,?,?,?)", [card.cardID,span.startMs,span.endMs,span.actor]) }
            }
            for var evidence in manifest.evidence {
                evidence.text = nil
                try store.execute("INSERT OR IGNORE INTO evidence_refs VALUES (?,?)", [evidence.id,try analysisJSON(evidence)])
            }
            try store.execute("UPDATE agent_events SET body='' WHERE batch_id=?", [batchID])
            try store.execute("INSERT OR REPLACE INTO analysis_observations VALUES (?,?)", [batchID,result.observation])
            if var object = try JSONSerialization.jsonObject(with: Data(analysisJSON(manifest).utf8)) as? [String:Any], let refs = object["evidence"] as? [[String:Any]] {
                object["evidence"] = refs.map { ref in var value = ref; value.removeValue(forKey: "text"); return value }
                let sanitized = String(decoding: try JSONSerialization.data(withJSONObject: object,options: [.sortedKeys]),as: UTF8.self)
                try store.execute("UPDATE batches SET manifest=? WHERE id=?", [sanitized,batchID])
            }
            try store.execute("UPDATE batches SET state='complete',expires=0,updated=? WHERE id=?", [now,batchID])
            try store.execute("UPDATE attempts SET ended=? WHERE batch_id=? AND generation=?", [now,batchID,generation])
            try changed(day: manifest.day)
            try store.execute("INSERT INTO receipts VALUES (?,?,?,?)", [operationID,bodyHash,try analysisJSON(receipt),now])
        }
        return receipt
    }
    func export(day: String, snapshotRevision: Int?, hasPending: Bool, raw: [(String, Int64)], retentionDays: Int) throws -> AnalysisExport {
        guard day.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil else { throw JournalReadError("INVALID_ARGUMENT") }
        let rev = try dayRevision(day)
        if let expected = snapshotRevision, expected != rev { throw JournalReadError("CONFLICT") }
        let snapshotID = "\(deviceID):\(day):\(rev)"
        if let body = try store.scalar("SELECT body FROM export_snapshots WHERE id=?", [snapshotID]) { return try decode(body) }
        let values = try cards(day: day)
        var missing = try store.rows("SELECT id,start_ms,end_ms,state FROM batches WHERE day=? AND state!='complete'", [day]).map { AnalysisMissing(startMs: Int64($0["start_ms"] ?? "0") ?? 0,endMs: Int64($0["end_ms"] ?? "0") ?? 0,reason: $0["state"] ?? "unknown",batchID: $0["id"]) }
        let effective = Int64(try store.scalar("SELECT value FROM metadata WHERE key='effectiveFrom'") ?? "0") ?? 0
        let coverage = try store.rows("SELECT c.capture_id,b.state FROM coverage c JOIN batches b ON b.id=c.batch_id WHERE b.day=?", [day])
        let accounted = Set(coverage.compactMap { $0["capture_id"] })
        let unseen = raw.filter { $0.1 >= effective && !accounted.contains($0.0) }
        if let first = unseen.map({ $0.1 }).min(), let last = unseen.map({ $0.1 }).max() { missing.append(AnalysisMissing(startMs: first,endMs: last,reason: "pending-discovery")) }
        if raw.isEmpty && accounted.isEmpty, let start = ISO8601DateFormatter().date(from: day+"T00:00:00+08:00") {
            let startMs = Int64(start.timeIntervalSince1970*1000), endMs = startMs+86400000-1
            if effective > 0 && effective <= endMs && endMs < journalNowMs()-Int64(retentionDays)*86400000 {
                missing.append(AnalysisMissing(startMs: max(startMs,effective),endMs: endMs,reason: "expired-unprocessed"))
            }
        }
        let ids = Set(values.flatMap(\.evidenceIDs))
        let evidence: [AnalysisEvidence] = try ids.sorted().compactMap { id in
            guard let body = try store.scalar("SELECT body FROM evidence_refs WHERE id=?", [id]) else { return nil }; return try decode(body)
        }
        let observations = try store.rows("SELECT o.body FROM analysis_observations o JOIN batches b ON b.id=o.batch_id WHERE b.day=? ORDER BY b.start_ms LIMIT 100", [day]).compactMap { $0["body"] }.joined(separator: "\n")
        let now = journalNowMs()
        // Until discovery has reconciled raw coverage, exports remain partial;
        // an empty analysis ledger is never proof that a day had no work.
        var result = AnalysisExport(deviceID: deviceID,day: day,snapshotID: snapshotID,revision: rev,generatedAt: now,sourceReadAt: now,
            coverage: effective > 0 && missing.isEmpty && !hasPending ? "complete" : "partial",missingIntervals: missing,cards: values,evidence: evidence,summary: (hasPending ? "原始材料尚在写入；仅已记录范围" : "仅已记录范围；后台来源覆盖未知") + "\n" + observations,contentHash: "")
        result.contentHash = analysisHash(try analysisJSON(result))
        let body = try analysisJSON(result)
        guard body.utf8.count < 8*1024*1024 else { throw JournalReadError("BUSY") }
        try store.execute("INSERT OR REPLACE INTO export_snapshots VALUES (?,?,?,?,?)", [snapshotID,day,rev,body,now])
        return result
    }
    func card(_ id: String) throws -> AnalysisCard {
        guard let body = try store.scalar("SELECT body FROM cards WHERE id=?", [id]) else { throw JournalReadError("NOT_FOUND") }; return try decode(body)
    }
    func retry(batchID: String, expectedRevision: Int, operationID: String) throws -> AnalysisReceipt {
        let requestHash = analysisHash("retry:"+batchID+":"+String(expectedRevision))
        if let row = try store.rows("SELECT input_hash,body FROM receipts WHERE operation_id=?", [operationID]).first {
            guard row["input_hash"] == requestHash else { throw JournalReadError("CONFLICT") }; return try decode(row["body"] ?? "")
        }
        guard let day = try store.scalar("SELECT day FROM batches WHERE id=?", [batchID]), try dayRevision(day) == expectedRevision, let state = try store.scalar("SELECT state FROM batches WHERE id=?", [batchID]), ["failed","pending"].contains(state) else { throw JournalReadError("CONFLICT") }
        let next = expectedRevision+1, now = journalNowMs()
        let receipt = AnalysisReceipt(operationID: operationID,batchID: batchID,revision: next,cardIDs: [])
        try store.transaction {
            // Attempts remain cumulative in the attempts ledger; explicit retry
            // starts a new bounded cycle, never resets its generation.
            try store.execute("UPDATE batches SET attempts=0,state='pending',next_attempt=0,updated=? WHERE id=?", [now,batchID])
            try changed(day: day)
            try store.execute("INSERT INTO receipts VALUES (?,?,?,?)", [operationID,requestHash,try analysisJSON(receipt),now])
        }; return receipt
    }
}
