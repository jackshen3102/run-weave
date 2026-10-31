import Foundation

@main
struct AnalysisVerify {
    static func main() async throws {
        let args = CommandLine.arguments
        guard (2...3).contains(args.count) else { throw journalError("usage: ScreenJournalAnalysisVerify ISOLATED_FIXTURE_ROOT") }
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
        print(try analysisJSON(["singleClaim":true,"renewal":true,"staleGenerationRejected":true,"atomicCommit":true,"idempotentReplay":true,"receiptQuery":true,"operationConflict":true,"snapshotConflict":true,"dateRevisionIsolation":true]))
        await service.shutdown()
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

}
