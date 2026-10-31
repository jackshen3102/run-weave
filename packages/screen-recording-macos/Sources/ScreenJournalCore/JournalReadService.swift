import Foundation

actor JournalReadService {
    let serverEpoch = UUID().uuidString
    private var analysisCoordinator: AnalysisCoordinator?
    private let engine: StorageEngine
    private var settings: RecordingSettings
    private var captureState = "stopped"
    private struct Snapshot {
        let view: JournalView
        let frames: [String: JournalIndexedCapture]
        let created: ContinuousClock.Instant
        var touched: ContinuousClock.Instant
        let bytes: Int
    }
    private var views: [String: Snapshot] = [:]
    private var activeReads: [String: [UUID: SegmentReadCoordinator.Lease]] = [:]
    private let decoders = [PlaybackFrameReader(), PlaybackFrameReader()]
    private var busySlots = Set<Int>()
    private struct CacheEntry { let data: Data; let cost: Int; let segment: String; let thumb: Bool }
    private var cache: [String: CacheEntry] = [:]
    private var order: [String] = []
    private var observedRevision = -1
    private var closed = false
    #if DEBUG
    private var presentationMilliseconds: [Int] = []
    private var servedJPEGBytes = 0
    private var peakDecoders = 0
    private var peakPrefetch = 0
    #endif
    private var expirationTask: Task<Void, Never>?
    private var invalidationTask: Task<Void, Never>?
    init(engine: StorageEngine, settings: RecordingSettings) { self.engine = engine; self.settings = settings }
    func startObserving() async {
        let stream = await engine.readChanges()
        invalidationTask = Task { [weak self] in
            for await revision in stream {
                guard !Task.isCancelled else { return }
                await self?.invalidateCache(revision)
            }
        }
    }
    private func invalidateCache(_ revision: Int) {
        if revision != observedRevision { cache.removeAll(); order.removeAll(); observedRevision = revision }
    }
    func update(settings: RecordingSettings, captureState: String) { self.settings = settings; self.captureState = captureState; prune() }
    private func armExpiration() {
        expirationTask?.cancel(); expirationTask = nil
        guard !closed, let deadline = views.values.map({ min($0.created.advanced(by: .seconds(1800)), $0.touched.advanced(by: .seconds(60))) }).min() else { return }
        expirationTask = Task { [weak self] in
            do { try await ContinuousClock().sleep(until: deadline, tolerance: .milliseconds(10)) } catch { return }
            await self?.prune()
        }
    }
    private func prune() {
        let now = ContinuousClock.now
        let expired = views.filter { $0.value.created.duration(to: now) >= .seconds(1800) || $0.value.touched.duration(to: now) >= .seconds(60) }.map(\.key)
        for id in expired { close(viewID: id) }
        armExpiration()
    }
    private func snapshot(_ id: String) throws -> Snapshot {
        guard !closed else { throw JournalReadError("NOT_RUNNING") }
        prune()
        guard var value = views[id] else { throw JournalReadError("VIEW_EXPIRED") }
        value.touched = .now; views[id] = value; armExpiration(); return value
    }
    private func catalog() async throws -> JournalCatalog {
        guard !closed else { throw JournalReadError("NOT_RUNNING") }
        return try await engine.catalog(settings: settings)
    }
    private func analysis() async throws -> AnalysisCoordinator {
        if let analysisCoordinator { return analysisCoordinator }
        let c = try await catalog()
        // Initialization failures stay in this domain and never tear down capture.
        let value = try AnalysisCoordinator(paths: engine.paths, engine: engine, deviceID: c.deviceID)
        analysisCoordinator = value
        await engine.registerAnalysis(value)
        return value
    }
    func analysisRequest(_ method: String, input: String) async throws -> (Data, String) {
        guard input.utf8.count <= 48000 else { throw JournalReadError("INVALID_ARGUMENT") }
        let r = try JSONDecoder().decode(AnalysisRequest.self, from: Data(input.utf8))
        func required(_ text: String?) throws -> String {
            guard let text, !text.isEmpty, text.utf8.count <= 256, !text.contains("\0") else { throw JournalReadError("INVALID_ARGUMENT") }; return text
        }
        func json<T: Encodable>(_ value: T) throws -> (Data, String) { (try JSONEncoder().encode(value), "application/json") }
        let owner = try await analysis()
        switch method {
        case "analysisAgentCursor": return try json(await owner.agentCursor(deviceID: required(r.expectedDeviceID),threadID: required(r.threadID)))
        case "ingestAnalysisEvents":
            guard let cursor = r.cursor, let expected = r.expectedCursor, let coverage = r.coverage, let events = r.events else { throw JournalReadError("INVALID_ARGUMENT") }
            try await owner.ingest(deviceID: required(r.expectedDeviceID),threadID: required(r.threadID),expected: expected,cursor: cursor,coverage: coverage,events: events)
            return try json(["accepted":true])
        case "analysisStatus": return try json(await owner.status())
        case "claimAnalysis":
            guard let from = r.effectiveFrom else { throw JournalReadError("INVALID_ARGUMENT") }
            return try json(await owner.claim(workerID: required(r.workerID), expectedDeviceID: required(r.expectedDeviceID), effectiveFrom: from, settings: settings, captureState: captureState))
        case "renewAnalysis":
            guard let gen = r.generation else { throw JournalReadError("INVALID_ARGUMENT") }
            return try json(["expiresAt": await owner.renew(batchID: required(r.batchID),workerID: required(r.workerID),generation: gen)])
        case "analysisFrame":
            guard let gen = r.generation else { throw JournalReadError("INVALID_ARGUMENT") }
            let c = try await owner.frame(batchID: required(r.batchID),workerID: required(r.workerID),generation: gen,captureID: required(r.captureID))
            let frame = try await engine.analysisCapture(c.id, settings: settings)
            let data = try await image(frame, variant: .full, viewID: nil)
            _ = try await owner.frame(batchID: required(r.batchID),workerID: required(r.workerID),generation: gen,captureID: c.id)
            return (data,"image/jpeg")
        case "commitAnalysis":
            guard let gen = r.generation, let result = r.result else { throw JournalReadError("INVALID_ARGUMENT") }
            return try json(await owner.commit(batchID: required(r.batchID),workerID: required(r.workerID),generation: gen,operationID: required(r.operationID),inputHash: required(r.inputHash),result: result))
        case "failAnalysis":
            guard let gen = r.generation else { throw JournalReadError("INVALID_ARGUMENT") }
            let code = try required(r.code)
            guard code.range(of: "^[A-Z_]{1,80}$", options: .regularExpression) != nil else { throw JournalReadError("INVALID_ARGUMENT") }
            try await owner.fail(batchID: required(r.batchID),workerID: required(r.workerID),generation: gen,code: code); return try json(["released":true])
        case "analysisReceipt": return try json(await owner.receipt(required(r.operationID)))
        case "retryAnalysis":
            guard let rev = r.expectedRevision else { throw JournalReadError("INVALID_ARGUMENT") }
            return try json(await owner.retry(batchID: required(r.batchID),expectedRevision: rev,operationID: required(r.operationID)))
        case "analysisCard": return try json(await owner.card(required(r.cardID)))
        case "analysisExport", "analysisCards":
            let c = try await catalog()
            let day = try required(r.day)
            let raw = try await engine.analysisDayCaptures(day, settings: settings)
            let pending = try await engine.analysisDayPending(day) || (c.hasPending && day == analysisDay(journalNowMs()))
            let retired = try await engine.analysisRetiredCaptures(day: day)
            let expiredDay = day < analysisDay(journalNowMs()-Int64(settings.retentionDays)*86400000)
            let fingerprint = analysisHash(raw.map { $0.0+":"+String($0.1) }.sorted().joined(separator: "|") + String(pending) + String(expiredDay) + retired.map { $0.0+":"+String($0.1) }.sorted().joined(separator: "|"))
            try await owner.observeSource(fingerprint, day: day)
            let value = try await owner.export(day: day, snapshotRevision: r.snapshotRevision, hasPending: pending, raw: raw, retentionDays: settings.retentionDays, retired: retired)
            if method == "analysisExport" { return try json(value) }
            let limit = r.limit ?? 100
            guard (1...100).contains(limit) else { throw JournalReadError("INVALID_ARGUMENT") }
            var offset = 0
            if let cursor = r.cursor {
                let parts = cursor.split(separator: ":")
                guard parts.count == 2, let rev = Int(parts[0]), let n = Int(parts[1]), n >= 0, n <= value.cards.count else { throw JournalReadError("INVALID_ARGUMENT") }
                guard rev == value.revision else { throw JournalReadError("CONFLICT") }; offset = n
            }
            let end = min(value.cards.count, offset+limit)
            return try json(AnalysisCardsPage(items: Array(value.cards[offset..<end]),revision: value.revision,nextCursor: end < value.cards.count ? "\(value.revision):\(end)" : nil))
        case "resolveAnalysisCapture":
            let id = try required(r.captureID), c = try await catalog()
            _ = try await engine.analysisCapture(id, settings: settings)
            for range in c.ranges {
                guard let bounds = c.members[range.rangeID] else { continue }
                let frames = try await engine.rangeFrames(bounds, settings: settings)
                if frames.contains(where: { $0.capture.id == id }) { return try json(["rangeID": range.rangeID,"catalogRevision":c.revision]) }
            }
            throw JournalReadError("FRAME_GONE")
        default: throw JournalReadError("INVALID_ARGUMENT")
        }
    }
    func invalidations() async -> AsyncStream<Int> { await engine.readChanges() }
    func status() async throws -> JournalStatus {
        let catalog = try await catalog()
        return JournalStatus(version: 1, availability: "ready", deviceID: catalog.deviceID, deviceName: Host.current().localizedName ?? "Mac",
            timeZone: TimeZone.current.identifier, serverEpoch: serverEpoch, catalogRevision: catalog.revision, captureState: captureState,
            retentionDays: settings.retentionDays, days: catalog.days, latestReadyMs: catalog.ranges.map(\.endMs).max(), hasPending: catalog.hasPending)
    }
    private struct Cursor: Codable { let revision: String; let offset: Int; let scope: String }
    private func page<T: Codable>(_ items: [T], catalog: JournalCatalog, cursor: String?, limit: Int, maximum: Int, scope: String) throws -> JournalPage<T> {
        guard (1...maximum).contains(limit) else { throw JournalReadError("INVALID_ARGUMENT") }
        var offset = 0
        if let cursor {
            guard cursor.utf8.count < 1024, let bytes = Data(base64Encoded: cursor), let decoded = try? JSONDecoder().decode(Cursor.self, from: bytes), decoded.scope == scope, decoded.offset >= 0 else { throw JournalReadError("INVALID_ARGUMENT") }
            guard decoded.revision == catalog.revision else { throw JournalReadError("CATALOG_CHANGED", retryable: true) }; offset = decoded.offset
        }
        guard offset <= items.count else { throw JournalReadError("INVALID_ARGUMENT") }
        let end = min(items.count, offset + limit)
        let next = end < items.count ? try JSONEncoder().encode(Cursor(revision: catalog.revision, offset: end, scope: scope)).base64EncodedString() : nil
        return JournalPage(items: Array(items[offset..<end]), catalogRevision: catalog.revision, nextCursor: next)
    }
    func days(cursor: String? = nil, limit: Int = 7) async throws -> JournalPage<JournalDay> {
        let c = try await catalog(); return try page(c.days, catalog: c, cursor: cursor, limit: limit, maximum: 30, scope: "days")
    }
    func ranges(day: String, cursor: String? = nil, limit: Int = 100) async throws -> JournalPage<JournalRange> {
        guard day.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil else { throw JournalReadError("INVALID_ARGUMENT") }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current; formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        guard let parsed = formatter.date(from: day), formatter.string(from: parsed) == day else { throw JournalReadError("INVALID_ARGUMENT") }
        let c = try await catalog()
        let boundary = c.days.first { $0.day == day }
        let items = boundary.map { d in c.ranges.filter { $0.startMs >= d.startMs && $0.startMs < d.endMs } } ?? []
        return try page(items, catalog: c, cursor: cursor, limit: limit, maximum: 200, scope: day)
    }
    func open(rangeID: String, catalogRevision: String) async throws -> JournalView {
        let c = try await catalog()
        guard c.revision == catalogRevision else { throw JournalReadError("CATALOG_CHANGED", retryable: true) }
        guard let range = c.ranges.first(where: { $0.rangeID == rangeID }), let bounds = c.members[rangeID] else { throw JournalReadError("NOT_FOUND") }
        let members = try await engine.rangeFrames(bounds, settings: settings)
        guard members.count == range.sampleCount else { throw JournalReadError("CATALOG_CHANGED") }
        let captures = members.map(\.capture)
        let view = JournalView(viewID: UUID().uuidString, serverEpoch: serverEpoch, deviceID: c.deviceID, range: range, captures: captures,
            intervals: JournalReadCatalog.intervals(for: captures, events: c.intervals), expiresAt: min(captures.map(\.availableUntilMs).min() ?? journalNowMs(), journalNowMs() + 1800000))
        let bytes = try JSONEncoder().encode(view).count
        prune()
        guard !closed, views.count < 8, views.values.reduce(0, { $0 + $1.bytes }) + bytes <= 8 * 1024 * 1024 else { throw JournalReadError("BUSY", retryable: true) }
        views[view.viewID] = Snapshot(view: view, frames: Dictionary(uniqueKeysWithValues: members.map { ($0.capture.id, $0) }), created: .now, touched: .now, bytes: bytes)
        armExpiration()
        return view
    }
    func close(viewID: String) {
        views.removeValue(forKey: viewID)
        armExpiration()
        activeReads[viewID]?.values.forEach { $0.cancel() }
        cache.removeAll(); order.removeAll()
    }
    func availability(viewID: String) async throws -> JournalAvailability {
        let value = try snapshot(viewID)
        var invalid: [String] = []
        for frame in value.frames.values {
            do { let permit = try await engine.permit(frame, settings: settings); await engine.release(permit) }
            catch let error as JournalReadError where error.code == "FRAME_GONE" { invalid.append(frame.capture.id) }
            catch { throw JournalReadError("MEDIA_UNAVAILABLE") }
        }
        _ = try snapshot(viewID)
        let revision = await engine.readRevision()
        if revision != observedRevision || !invalid.isEmpty { cache.removeAll(); order.removeAll(); observedRevision = revision }
        return JournalAvailability(checkedAt: journalNowMs(), expiresAt: value.view.expiresAt, invalidCaptureIDs: invalid.sorted(), intervals: value.view.intervals,
            viewState: invalid.count == value.frames.count ? "gone" : "ready")
    }
    func frame(viewID: String, captureID: String, variant: JournalVariant) async throws -> Data {
        let value = try snapshot(viewID)
        guard let frame = value.frames[captureID] else { throw JournalReadError("NOT_FOUND") }
        return try await image(frame, variant: variant, viewID: viewID)
    }
    func thumbnail(rangeID: String, catalogRevision: String) async throws -> Data {
        let c = try await catalog()
        guard c.revision == catalogRevision else { throw JournalReadError("CATALOG_CHANGED", retryable: true) }
        guard let bounds = c.members[rangeID] else { throw JournalReadError("NOT_FOUND") }
        let members = try await engine.rangeFrames(bounds, settings: settings)
        guard let range = c.ranges.first(where: { $0.rangeID == rangeID }), members.count == range.sampleCount else { throw JournalReadError("CATALOG_CHANGED") }
        guard let frame = members.first(where: { !$0.capture.privacyPlaceholder }) else { throw JournalReadError("PRIVATE_FRAME") }
        return try await image(frame, variant: .thumb, viewID: nil)
    }
    private func image(_ frame: JournalIndexedCapture, variant: JournalVariant, viewID: String?) async throws -> Data {
        let permit = try await engine.permit(frame, settings: settings)
        do {
            if let viewID {
                _ = try snapshot(viewID)
                activeReads[viewID, default: [:]][permit.lease.id] = permit.lease
            }
            defer {
                if let viewID {
                    activeReads[viewID]?.removeValue(forKey: permit.lease.id)
                    if activeReads[viewID]?.isEmpty == true { activeReads.removeValue(forKey: viewID) }
                }
            }
            var permits = [permit]
            if let viewID, variant != .thumb, let value = views[viewID] {
                let upcoming = value.frames.values.filter {
                    $0.segmentID == frame.segmentID && $0.frameIndex > frame.frameIndex && $0.frameIndex <= frame.frameIndex + 2 && !$0.capture.privacyPlaceholder
                }.sorted { $0.frameIndex < $1.frameIndex }
                permits += upcoming.map { JournalFramePermit(frame: $0, url: permit.url, lease: permit.lease) }
            }
            let result = try await decode(permits, variant: variant)
            // A cancelled view or cleanup cannot publish a late frame.
            if let viewID { _ = try snapshot(viewID) }
            try permit.lease.check()
            let fresh = try await engine.permit(frame, settings: settings)
            await engine.release(fresh)
            await engine.release(permit)
            #if DEBUG
            servedJPEGBytes += result.count
            #endif
            return result
        } catch {
            await engine.release(permit)
            throw error
        }
    }
    private func decode(_ permits: [JournalFramePermit], variant: JournalVariant) async throws -> Data {
        let permit = permits[0]
        guard !permit.frame.capture.privacyPlaceholder else { throw JournalReadError("PRIVATE_FRAME") }
        let key = serverEpoch + ":" + permit.frame.capture.id + ":" + variant.rawValue
        if let entry = cache[key] { order.removeAll { $0 == key }; order.append(key); return entry.data }
        // Keep the first slot available for interactive full/preview requests.
        let candidates = variant == .thumb ? [1] : Array(decoders.indices)
        guard let slot = candidates.first(where: { !busySlots.contains($0) }) else { throw JournalReadError("BUSY", retryable: true) }
        busySlots.insert(slot); defer { busySlots.remove(slot) }
        #if DEBUG
        peakDecoders = max(peakDecoders, busySlots.count); peakPrefetch = max(peakPrefetch, permits.count - 1)
        #endif
        let batch = try await withTaskCancellationHandler {
            try await decoders[slot].jpegBatch(permits, variant: variant)
        } onCancel: { permit.lease.cancel() }
        try permit.lease.check()
        guard !closed else { throw JournalReadError("NOT_RUNNING") }
        // Account decoded pixels as well as encoded data, so highly compressed
        // frames do not evade the memory budget.
        for item in permits {
        guard let data = batch[item.frame.capture.id] else { continue }
        let key = serverEpoch + ":" + item.frame.capture.id + ":" + variant.rawValue
        let frame = item.frame
        let scale = min(1.0, Double(variant.height ?? frame.height) / Double(max(1, frame.height)))
        let pixels = Double(frame.width) * Double(frame.height) * scale * scale
        let cost = max(data.count, Int(pixels.rounded(.up)) * 4)
        cache[key] = CacheEntry(data: data, cost: cost, segment: permit.frame.segmentID, thumb: variant == .thumb); order.removeAll { $0 == key }; order.append(key)
        while cache.count > 16 || cache.values.filter({ !$0.thumb }).reduce(0, { $0 + $1.cost }) > 128 * 1024 * 1024 || cache.values.filter({ $0.thumb }).reduce(0, { $0 + $1.cost }) > 16 * 1024 * 1024 {
            guard !order.isEmpty else { break }; cache.removeValue(forKey: order.removeFirst())
        }
        }
        guard let result = batch[permit.frame.capture.id] else { throw JournalReadError("MEDIA_UNAVAILABLE") }
        return result
    }
    #if DEBUG
    func recordPresentation(milliseconds: Int) {
        presentationMilliseconds.append(milliseconds)
        if presentationMilliseconds.count > 4096 { presentationMilliseconds.removeFirst() }
    }
    func diagnostics() async -> [String: Int] {
        let samples = presentationMilliseconds.sorted()
        return ["servedJPEGBytes": servedJPEGBytes, "peakDecoders": peakDecoders, "peakPrefetch": peakPrefetch, "presentationSamples": samples.count, "presentationP95Ms": samples.isEmpty ? 0 : samples[min(samples.count - 1, Int(ceil(Double(samples.count) * 0.95)) - 1)],
"views": views.count, "indexBytes": views.values.reduce(0, { $0 + $1.bytes }),
         "decoders": busySlots.count, "leases": await engine.activeReadCount(), "cachedFrames": cache.count,
         "imageBytes": cache.values.filter({ !$0.thumb }).reduce(0, { $0 + $1.cost }),
         "thumbnailBytes": cache.values.filter({ $0.thumb }).reduce(0, { $0 + $1.cost })]
    }
    #endif
    func shutdown() async {
        closed = true; expirationTask?.cancel(); expirationTask = nil; invalidationTask?.cancel(); invalidationTask = nil; views.removeAll(); cache.removeAll(); order.removeAll()
        await engine.stopReads()
        for decoder in decoders { await decoder.reset() }
    }
}
