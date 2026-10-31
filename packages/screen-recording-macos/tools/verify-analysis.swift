import Foundation
import CoreGraphics

@main
struct AnalysisVerify {
    static func main() async throws {
        let args = CommandLine.arguments
        guard (2...3).contains(args.count), args.count == 2 || ["--boundaries", "--bad-analysis", "--queue-faults", "--queue-reopen", "--revisions", "--retirement"].contains(args[2]) else {
            throw journalError("usage: ScreenJournalAnalysisVerify ISOLATED_FIXTURE_ROOT [--boundaries|--bad-analysis|--queue-faults|--queue-reopen|--revisions|--retirement]")
        }
        let paths = try StorePaths(root: URL(fileURLWithPath: args[1]),validation: true)
        let engine = try StorageEngine(paths: paths)
        let settings = RecordingSettings()
        let service = JournalReadService(engine: engine,settings: settings)
        let status = try await service.status()
        func call<T: Decodable>(_ method: String, _ value: [String: Any], _: T.Type) async throws -> T {
            let data = try JSONSerialization.data(withJSONObject: value,options: [.sortedKeys])
            let (body,_) = try await service.analysisRequest(method,input: String(decoding: data,as: UTF8.self))
            return try JSONDecoder().decode(T.self,from: body)
        }
        if args.count == 3, args[2] == "--queue-reopen" {
            let db = try AnalysisStore(paths: paths)
            guard try db.scalar("SELECT state FROM batches WHERE id='valid'") == "failed",
                  try db.scalar("SELECT attempts FROM batches WHERE id='valid'") == "3",
                  try db.scalar("SELECT state FROM batches WHERE id='expired'") == "source-expired" else { throw journalError("persisted_queue_fixture_required") }
            let owner = try AnalysisCoordinator(paths: paths,engine: engine,deviceID: status.deviceID)
            let claim = try await owner.claim(workerID: UUID().uuidString,expectedDeviceID: status.deviceID,effectiveFrom: 1,settings: settings,captureState: "paused")
            guard claim?.manifest.batchID != "valid", try db.scalar("SELECT attempts FROM batches WHERE id='valid'") == "3" else { throw journalError("process_restart_reset_budget") }
            print(try analysisJSON(["newProcessPreservesFailureBudget":true,"expiredStateSurvives":true]))
            await service.shutdown(); return
        }
        if args.count == 3, args[2] == "--boundaries" {
            try await verifyBoundaries(paths: paths,engine: engine,deviceID: status.deviceID)
            await service.shutdown(); return
        }
        if args.count == 3, args[2] == "--bad-analysis" {
            try await verifyBadAnalysis(paths: paths, engine: engine, service: service)
            await service.shutdown(); return
        }
        if args.count == 3, args[2] == "--queue-faults" {
            try await verifyQueueFaults(paths: paths, engine: engine, deviceID: status.deviceID)
            await service.shutdown(); return
        }
        if args.count == 3, args[2] == "--revisions" {
            try await verifyRevisions(service: service,deviceID: status.deviceID)
            await service.shutdown(); return
        }
        let worker = UUID().uuidString
        let claim: AnalysisClaim? = try await call("claimAnalysis",["workerID":worker,"expectedDeviceID":status.deviceID,"effectiveFrom":1],AnalysisClaim?.self)
        guard let claim, let frame = claim.manifest.captures.first(where: { !$0.privacyPlaceholder }) else { throw journalError("fixture_ready_frames_required") }
        let competitor: AnalysisClaim? = try await call("claimAnalysis",["workerID":UUID().uuidString,"expectedDeviceID":status.deviceID,"effectiveFrom":1],AnalysisClaim?.self)
        guard competitor == nil else { throw journalError("double_claim") }
        let identity: [String: Any] = ["batchID":claim.manifest.batchID,"workerID":worker,"generation":claim.generation]
        let renewed: [String:Int64] = try await call("renewAnalysis",identity,[String:Int64].self)
        guard renewed["expiresAt"] ?? 0 > journalNowMs() else { throw journalError("renew_failed") }
        let card: [String:Any] = ["cardID":NSNull(),"matterID":NSNull(),"baseRevision":NSNull(),"title":"隔离采样观察","summary":"仅记录测试画面，不推断任务完成。","detail":"验证来源身份与提交事务。","actor":"person","state":"documented","projectID":NSNull(),"spans":[["startMs":frame.capturedAtMs,"endMs":frame.capturedAtMs,"actor":"person"]],"evidenceIDs":[frame.id]]
        let op = UUID().uuidString
        var request = identity.merging(["operationID":op,"inputHash":claim.manifest.inputHash,"result":["cards":[card],"observation":"隔离样本"]]) { _,new in new }
        var stale = request; stale["generation"] = claim.generation+1
        do { let _: AnalysisReceipt = try await call("commitAnalysis",stale,AnalysisReceipt.self); throw journalError("stale_generation_accepted") } catch let error as JournalReadError { guard error.code == "LEASE_LOST" else { throw error } }
        let receipt: AnalysisReceipt = try await call("commitAnalysis",request,AnalysisReceipt.self)
        let replay: AnalysisReceipt = try await call("commitAnalysis",request,AnalysisReceipt.self)
        guard receipt.cardIDs == replay.cardIDs,receipt.revision == replay.revision else { throw journalError("duplicate_commit") }
        let queried: AnalysisReceipt? = try await call("analysisReceipt",["operationID":op],AnalysisReceipt?.self)
        guard queried?.cardIDs == receipt.cardIDs else { throw journalError("receipt_lost") }
        request["result"] = ["cards":[card],"observation":"changed"]
        do { let _: AnalysisReceipt = try await call("commitAnalysis",request,AnalysisReceipt.self); throw journalError("operation_reuse_accepted") } catch let error as JournalReadError { guard error.code == "CONFLICT" else { throw error } }
        let exported: AnalysisExport = try await call("analysisExport",["day":claim.manifest.day],AnalysisExport.self)
        guard exported.cards.contains(where: { $0.cardID == receipt.cardIDs.first }), exported.evidence.contains(where: { $0.id == frame.id }) else { throw journalError("partial_commit") }
        do { let _: AnalysisExport = try await call("analysisExport",["day":claim.manifest.day,"snapshotRevision":exported.revision-1],AnalysisExport.self); throw journalError("old_snapshot_accepted") } catch let error as JournalReadError { guard error.code == "CONFLICT" else { throw error } }
        let otherDay = claim.manifest.day == "2026-10-30" ? "2026-10-29" : "2026-10-30"
        let _: AnalysisExport = try await call("analysisExport",["day":otherDay],AnalysisExport.self)
        let stable: AnalysisExport = try await call("analysisExport",["day":claim.manifest.day,"snapshotRevision":exported.revision],AnalysisExport.self)
        guard stable.contentHash == exported.contentHash, stable.generatedAt == exported.generatedAt else { throw journalError("unrelated_day_changed_snapshot") }
        if args.count == 3, args[2] == "--retirement" {
            let before = try await engine.analysisDayCaptures(claim.manifest.day,settings: settings)
            var short = settings; short.retentionDays = 1
            _ = try await engine.maintain(settings: short)
            let retired = try await engine.analysisRetiredCaptures(day: claim.manifest.day)
            guard retired.count == before.count, !retired.isEmpty else { throw journalError("retirement_fixture_must_be_two_days_old") }
            let after: AnalysisExport = try await call("analysisExport",["day":claim.manifest.day],AnalysisExport.self)
            guard after.coverage == "partial", after.cards.contains(where: { $0.cardID == receipt.cardIDs.first }),
                  after.missingIntervals.contains(where: { $0.reason == "expired-unprocessed" }) else { throw journalError("lost_unseen_capture_coverage") }
            do { let _: [String:String] = try await call("resolveAnalysisCapture",["captureID":frame.id],[String:String].self); throw journalError("retired_frame_resolved") }
            catch let error as JournalReadError { guard error.code == "FRAME_GONE" else { throw error } }
            print(try analysisJSON(["retiredCaptures":retired.count,"permanentUnprocessedGaps":after.missingIntervals.filter { $0.reason == "expired-unprocessed" }.count,"textCardsPreserved":after.cards.count]))
        }
        print(try analysisJSON(["singleClaim":true,"renewal":true,"staleGenerationRejected":true,"atomicCommit":true,"idempotentReplay":true,"receiptQuery":true,"operationConflict":true,"snapshotConflict":true,"dateRevisionIsolation":true]))
        await service.shutdown()
    }
    static func verifyBoundaries(paths: StorePaths, engine: StorageEngine, deviceID: String) async throws {
        let settings = RecordingSettings()
        guard try await engine.analysisPage(after: 0,settings: settings).frames.isEmpty else { throw journalError("empty_raw_fixture_required") }
        _ = try await engine.prepare(settings: settings)
        let permit = CapturePermit(), generation = permit.invalidate(), worker = UUID().uuidString
        let owner = try AnalysisCoordinator(paths: paths,engine: engine,deviceID: deviceID)
        let context = CGContext(data: nil,width: 64,height: 64,bitsPerComponent: 8,bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        context.setFillColor(CGColor(gray: 0.5,alpha: 1)); context.fill(CGRect(x: 0,y: 0,width: 64,height: 64))
        var sequence = 0
        func append(_ ms: Int64) async throws {
            let frame = CapturedFrame(image: context.makeImage()!,capturedAt: Date(timeIntervalSince1970: Double(ms)/1000),displayID: 999,applicationID: "synthetic",idleSeconds: 0,placeholder: false)
            try await engine.prepareAppend(frame)
            for _ in 0..<100 {
                if try await engine.append(frame,sequence: sequence,permit: permit,generation: generation) { sequence += 1; return }
                try await Task.sleep(for: .milliseconds(20))
            }
            throw journalError("encoder_busy")
        }
        func claim(_ state: String = "recording") async throws -> AnalysisClaim? {
            try await owner.claim(workerID: worker,expectedDeviceID: deviceID,effectiveFrom: 1,settings: settings,captureState: state)
        }
        var manifests: [AnalysisManifest] = []
        func finish(_ value: AnalysisClaim) async throws {
            let result = try JSONDecoder().decode(AnalysisResult.self,from: Data("{\"cards\":[],\"observation\":\"boundary fixture\"}".utf8))
            _ = try await owner.commit(batchID: value.manifest.batchID,workerID: worker,generation: value.generation,operationID: UUID().uuidString,inputHash: value.manifest.inputHash,result: result)
            manifests.append(value.manifest)
        }
        let now = journalNowMs()
        let midnight = Int64(ISO8601DateFormatter().date(from: analysisDay(now)+"T00:00:00+08:00")!.timeIntervalSince1970*1000)
        try await append(midnight-2000); try await append(midnight+2000); try await engine.finalize()
        for _ in 0..<4 { if let c = try await claim() { try await finish(c) } }
        guard manifests.count == 2, Set(manifests.map(\.day)).count == 2,
              manifests.allSatisfy({ $0.captures.count == 1 }) else { throw journalError("cross_day_tail_lost") }
        // A full 15-minute batch is mature even while recording remains active.
        for i in 0..<90 { try await append(now-3600000+Int64(i)*10000) }
        try await engine.finalize()
        for _ in 0..<4 { if let c = try await claim() { try await finish(c) } }
        guard manifests.contains(where: { $0.captures.count == 90 && $0.endMs-$0.startMs == 890000 }) else { throw journalError("full_batch_lost") }
        try await append(now-1000)
        guard try await claim() == nil else { throw journalError("writing_frame_claimed") }
        try await engine.finalize()
        for _ in 0..<3 { guard try await claim() == nil else { throw journalError("active_short_tail_claimed") } }
        var tail: AnalysisClaim?
        for _ in 0..<3 { if let c = try await claim("paused") { tail = c; break } }
        guard let tail, tail.manifest.captures.count == 1 else { throw journalError("paused_tail_lost") }
        try await finish(tail)
        // Commit an older timestamp only after the scan has passed newer captures.
        try await append(midnight-60000); try await engine.finalize()
        var late: AnalysisClaim?
        for _ in 0..<4 { if let c = try await claim("paused") { late = c; break } }
        guard let late, late.manifest.startMs == midnight-60000 else { throw journalError("late_ready_frame_lost") }
        try await finish(late)
        let ids = manifests.flatMap { $0.captures.map(\.id) }
        guard ids.count == 94, Set(ids).count == 94 else { throw journalError("duplicate_capture_coverage") }
        _ = try await engine.shutdown(settings: settings)
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["crossDayShortTails":true,"fullBatch":true,"writingExcluded":true,"activeTailWaits":true,"pausedTailScheduled":true,"lateReadyRediscovered":true,"uniqueCaptures":ids.count]),as: UTF8.self))
    }

    // Real capture storage pipeline with generated pixels; never reads the user's screen.
    static func verifyBadAnalysis(paths: StorePaths, engine: StorageEngine, service: JournalReadService) async throws {
        guard !FileManager.default.fileExists(atPath: try paths.file("analysis.sqlite").path) else { throw journalError("empty_analysis_fixture_required") }
        let settings = RecordingSettings()
        _ = try await engine.prepare(settings: settings)
        let permit = CapturePermit(), generation = permit.invalidate()
        let context = CGContext(data: nil,width: 320,height: 180,bitsPerComponent: 8,bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        context.setFillColor(CGColor(red: 0.1,green: 0.4,blue: 0.8,alpha: 1)); context.fill(CGRect(x: 0,y: 0,width: 320,height: 180))
        func append(_ sequence: Int) async throws {
            let frame = CapturedFrame(image: context.makeImage()!,capturedAt: Date(),displayID: 999,
                applicationID: "com.runweave.synthetic-fixture",idleSeconds: 0,placeholder: false)
            try await engine.prepareAppend(frame)
            for _ in 0..<100 {
                if try await engine.append(frame,sequence: sequence,permit: permit,generation: generation) { try await engine.finalize(); return }
                try await Task.sleep(for: .milliseconds(20))
            }
            throw journalError("fixture_encoder_busy")
        }
        try await append(0)
        let first = try await engine.analysisPage(after: 0,settings: settings).frames.first!
        let read = try await engine.permit(first,settings: settings)
        let reader = PlaybackFrameReader()
        let before = try await reader.jpegBatch([read], variant: .full)
        await engine.release(read)
        do { let db = try AnalysisStore(paths: paths); try db.execute("PRAGMA user_version=999; PRAGMA wal_checkpoint(TRUNCATE)") }
        do { _ = try await service.analysisRequest("analysisStatus",input: "{}"); throw journalError("bad_schema_accepted") }
        catch let error as JournalReadError { guard error.code == "INCOMPATIBLE" else { throw error } }
        try await append(1)
        _ = try await engine.maintain(settings: settings)
        let all = try await engine.analysisPage(after: 0,settings: settings).frames
        guard all.count == 2 else { throw journalError("analysis_failure_stopped_capture") }
        let reread = try await engine.permit(first,settings: settings)
        let after = try await reader.jpegBatch([reread], variant: .full)
        await engine.release(reread)
        guard before == after else { throw journalError("analysis_failure_changed_media") }
        _ = try await engine.shutdown(settings: settings)
        print(try analysisJSON(["unsupportedAnalysisSchemaRejected":true,"capturePipelineContinued":true,"rawFrameUnchanged":true,"analysisFilePreserved":FileManager.default.fileExists(atPath: try paths.file("analysis.sqlite").path)]))
    }

    static func verifyRevisions(service: JournalReadService, deviceID: String) async throws {
        func call<T: Decodable>(_ method: String, _ value: [String:Any], _: T.Type) async throws -> T {
            let data = try JSONSerialization.data(withJSONObject: value,options: [.sortedKeys])
            let (body,_) = try await service.analysisRequest(method,input: String(decoding: data,as: UTF8.self))
            return try JSONDecoder().decode(T.self,from: body)
        }
        let worker = UUID().uuidString, thread = UUID().uuidString, start = journalNowMs()-60000
        var cursor = "", previous: [AnalysisCard] = []
        for step in 0..<3 {
            let time = start+Int64(step)*10000, eventID = "fixture-event-"+String(step)
            let event: [String:Any] = ["id":eventID,"provider":"codex","threadID":thread,"eventID":eventID,"projectID":NSNull(),"occurredAtMs":time,"kind":"assistant","text":"Synthetic revision fixture","derived":false,"independentSuccess":false]
            let _: [String:Bool] = try await call("ingestAnalysisEvents",["expectedDeviceID":deviceID,"threadID":thread,"expectedCursor":cursor,"cursor":String(step+1),"coverage":"complete","events":[event]],[String:Bool].self)
            cursor = String(step+1)
            let claim: AnalysisClaim? = try await call("claimAnalysis",["workerID":worker,"expectedDeviceID":deviceID,"effectiveFrom":start-1000],AnalysisClaim?.self)
            guard let claim, claim.manifest.captures.isEmpty else { throw journalError("empty_isolated_root_required") }
            func card(_ old: AnalysisCard?, _ times: [Int64], _ refs: [String]) -> [String:Any] {
                ["cardID":old?.cardID as Any? ?? NSNull(),"matterID":old?.matterID as Any? ?? NSNull(),"baseRevision":old?.revision as Any? ?? NSNull(),"title":"隔离修订","summary":"split/merge fixture","detail":"无个人材料","actor":"agent","state":"agent-reported","projectID":NSNull(),"spans":times.map { ["startMs":$0,"endMs":$0,"actor":"agent"] as [String:Any] },"evidenceIDs":refs]
            }
            var cards: [[String:Any]], replacements: [[String:Any]] = []
            if step == 0 { cards = [card(nil,[time],[eventID])] }
            else if step == 1 {
                cards = [card(previous[0],[start],["fixture-event-0"]),card(nil,[time],[eventID])]
                cards[1]["matterID"] = previous[0].matterID
                replacements = [["cardID":previous[0].cardID,"baseRevision":previous[0].revision,"targetIndexes":[0,1]]]
            } else {
                let retained = previous.first { $0.revision == 2 }!
                cards = [card(retained,[start,start+10000,time],["fixture-event-0","fixture-event-1",eventID])]
                replacements = previous.map { ["cardID":$0.cardID,"baseRevision":$0.revision,"targetIndexes":[0]] }
            }
            let result: [String:Any] = ["cards":cards,"observation":"explicit lineage fixture","rewriteSpan":step == 0 ? NSNull() : ["startMs":start,"endMs":time] as Any,"replacements":replacements]
            let request: [String:Any] = ["batchID":claim.manifest.batchID,"workerID":worker,"generation":claim.generation,"operationID":UUID().uuidString,"inputHash":claim.manifest.inputHash,"result":result]
            let receipt: AnalysisReceipt = try await call("commitAnalysis",request,AnalysisReceipt.self)
            let replay: AnalysisReceipt = try await call("commitAnalysis",request,AnalysisReceipt.self)
            guard receipt.cardIDs == replay.cardIDs else { throw journalError("lineage_replay_failed") }
            let exported: AnalysisExport = try await call("analysisExport",["day":claim.manifest.day],AnalysisExport.self)
            guard exported.cards.count == (step == 1 ? 2 : 1) else { throw journalError("replacement_card_count") }
            previous = exported.cards
        }
        guard previous.first?.revision == 3, previous.first?.spans.count == 3 else { throw journalError("merge_identity_lost") }
        print(try analysisJSON(["explicitSplit":true,"explicitMerge":true,"stableRetainedIdentity":true,"lineageReplay":true,"historicalPointSpansPreserved":true]))
    }

    // Direct ledger edits below are fault injection confined to an empty validation store.
    static func verifyQueueFaults(paths: StorePaths, engine: StorageEngine, deviceID: String) async throws {
        let db = try AnalysisStore(paths: paths)
        guard try db.scalar("SELECT id FROM batches LIMIT 1") == nil else { throw journalError("empty_analysis_fixture_required") }
        let now = journalNowMs(), worker = UUID().uuidString, day = analysisDay(journalNowMs())
        let expired = JournalCapture(id: "expired", sessionID: "fixture", sequence: 0, capturedAtMs: now-60000,
            timezoneOffsetSeconds: 28800, displayID: 999, frontmostApplication: nil, privacyPlaceholder: false, availableUntilMs: now-1)
        for (id,frames,start) in [("expired",[expired],now-60000),("valid",[JournalCapture](),now-30000),("later",[JournalCapture](),now-10000)] {
            let manifest = AnalysisManifest(batchID: id,deviceID: deviceID,day: day,inputHash: id,promptVersion: "fixture",
                startMs: start,endMs: start,captures: frames,intervals: [],context: [],evidence: [],agentCoverage: "unknown")
            try db.execute("INSERT INTO batches(id,input_hash,day,start_ms,end_ms,manifest,state,updated) VALUES (?,?,?,?,?,?,'pending',?)", [id,id,day,start,start,try analysisJSON(manifest),now])
        }
        var owner = try AnalysisCoordinator(paths: paths,engine: engine,deviceID: deviceID)
        func claim(_ owner: AnalysisCoordinator) async throws -> AnalysisClaim? {
            try await owner.claim(workerID: worker,expectedDeviceID: deviceID,effectiveFrom: 1,settings: RecordingSettings(),captureState: "paused")
        }
        guard let first = try await claim(owner), first.manifest.batchID == "valid",
              try db.scalar("SELECT state FROM batches WHERE id='expired'") == "source-expired" else { throw journalError("expired_head_blocked_ready_work") }
        // Persisted deadline is behind the real clock; no production clock override.
        try db.execute("UPDATE batches SET expires=? WHERE id='valid'",[now-1])
        owner = try AnalysisCoordinator(paths: paths,engine: engine,deviceID: deviceID)
        guard let second = try await claim(owner), second.attempt == 2, second.generation == first.generation+1 else { throw journalError("lease_restart_lost") }
        do { _ = try await owner.renew(batchID: "valid",workerID: worker,generation: first.generation); throw journalError("old_owner_renewed") }
        catch let error as JournalReadError { guard error.code == "LEASE_LOST" else { throw error } }
        try await owner.fail(batchID: "valid",workerID: worker,generation: second.generation,code: "FIXTURE")
        guard let later = try await claim(owner), later.manifest.batchID == "later" else { throw journalError("backoff_blocked_other_work") }
        try await owner.fail(batchID: "later",workerID: worker,generation: later.generation,code: "FIXTURE")
        try db.execute("UPDATE batches SET next_attempt=0 WHERE id='valid'")
        owner = try AnalysisCoordinator(paths: paths,engine: engine,deviceID: deviceID)
        guard let third = try await claim(owner), third.attempt == 3 else { throw journalError("attempt_budget_reset") }
        try await owner.fail(batchID: "valid",workerID: worker,generation: third.generation,code: "FIXTURE")
        owner = try AnalysisCoordinator(paths: paths,engine: engine,deviceID: deviceID)
        guard try await claim(owner) == nil, try db.scalar("SELECT state FROM batches WHERE id='valid'") == "failed" else { throw journalError("fourth_attempt_accepted") }
        print(try analysisJSON(["expiredHeadSkipped":true,"persistedLeaseRecovered":true,"oldGenerationRejected":true,"backoffDoesNotBlock":true,"attemptBudgetSurvivesOwnerRestart":true]))
    }

}
