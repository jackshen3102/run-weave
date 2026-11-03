import Foundation
import ImageIO
import os

private struct ScreenRecordingBytes: Decodable {
    let data: Data
    init(_ data: Data) { self.data = data }
    init(from decoder: Decoder) throws { throw ScreenRecordingReadError("MEDIA_UNAVAILABLE") }
}
extension APIClient {
    private func screenError(_ status: Int, _ body: Data) -> Error? {
        // Let authorized() handle 401 and the existing refresh-token lifecycle.
        if status == 401 { return nil }
        if let value = try? JSONDecoder().decode(ScreenRecordingReadError.self, from: body) { return value }
        if status == 404 { return ScreenRecordingReadError("UPDATE_REQUIRED") }
        return nil
    }
    func screenAnalysisConversation(provider: String, threadID: String) async throws -> TerminalConversation.Target? {
        try await authorized("/api/screen-recording/analysis/conversations/\(Self.pathComponent(threadID))?provider=\(Self.pathComponent(provider))", requestTimeout: 5, decodeError: screenError)
    }
    func screenAnalysisSearch(_ request: ScreenAnalysisSearchRequest) async throws -> ScreenAnalysisSearchResponse {
        var components = URLComponents()
        components.path = "/api/screen-recording/analysis/search"
        components.queryItems = [URLQueryItem(name: "q", value: request.q), URLQueryItem(name: "from", value: request.from),
            URLQueryItem(name: "to", value: request.to), URLQueryItem(name: "limit", value: String(request.limit ?? 100))]
        // URLComponents leaves '+' literal, while HTTP query parsers treat it as a space.
        guard let path = components.string?.replacingOccurrences(of: "+", with: "%2B") else { throw APIError.invalidResponse }
        return try await authorized(path, requestTimeout: 5, decodeError: screenError)
    }
    func screenAnalysisStatus() async throws -> ScreenAnalysisStatus {
        try await authorized("/api/screen-recording/analysis/status", requestTimeout: 5, decodeError: screenError)
    }
    func screenAnalysisExport(day: String) async throws -> ScreenAnalysisExport {
        try await authorized("/api/screen-recording/analysis/export?day=\(Self.pathComponent(day))", requestTimeout: 5, decodeError: screenError)
    }
    func screenAnalysisRetry(batchID: String, revision: Int, operationID: String) async throws -> ScreenAnalysisReceipt {
        return try await authorized("/api/screen-recording/analysis/retry", method: "POST", body: ["batchID": batchID, "expectedRevision": revision, "operationID": operationID], requestTimeout: 5, decodeError: screenError)
    }
    func screenAnalysisResolve(captureID: String) async throws -> [String:String] {
        try await authorized("/api/screen-recording/analysis/captures/\(Self.pathComponent(captureID))", requestTimeout: 5, decodeError: screenError)
    }
    func screenStatus() async throws -> ScreenRecordingStatus {
        try await authorized("/api/screen-recording/status", requestTimeout: 5, decodeError: screenError)
    }
    func screenDays(cursor: String? = nil) async throws -> ScreenRecordingPage<ScreenRecordingDay> {
        let query = cursor.map { "&cursor=\(Self.pathComponent($0))" } ?? ""
        return try await authorized("/api/screen-recording/days?limit=30" + query, requestTimeout: 5, decodeError: screenError)
    }
    func screenRanges(day: String, cursor: String? = nil) async throws -> ScreenRecordingPage<ScreenRecordingRange> {
        let query = cursor.map { "&cursor=\(Self.pathComponent($0))" } ?? ""
        return try await authorized("/api/screen-recording/ranges?limit=200&day=\(Self.pathComponent(day))" + query, requestTimeout: 5, decodeError: screenError)
    }
    func screenOpen(rangeID: String, catalogRevision: String, captureID: String? = nil) async throws -> ScreenRecordingView {
        var body: [String: Any] = ["rangeID": rangeID, "catalogRevision": catalogRevision]
        if let captureID { body["captureID"] = captureID }
        return try await authorized("/api/screen-recording/views", method: "POST", body: body, requestTimeout: 5, decodeError: screenError)
    }
    func screenPage(viewID: String, offset: Int?, atMs: Int64?) async throws -> ScreenRecordingView {
        var body: [String: Any] = ["viewID": viewID]
        if let offset { body["offset"] = offset }
        if let atMs { body["atMs"] = atMs }
        return try await authorized("/api/screen-recording/views", method: "POST", body: body, requestTimeout: 5, decodeError: screenError)
    }
    func screenAvailability(viewID: String) async throws -> ScreenRecordingAvailability {
        try await authorized("/api/screen-recording/views/\(Self.pathComponent(viewID))/availability", requestTimeout: 5, decodeError: screenError)
    }
    func screenPackage(viewID: String) async throws -> ScreenRecordingPackage {
        try await authorized("/api/screen-recording/views/\(Self.pathComponent(viewID))/package", requestTimeout: 120, decodeError: screenError,
            download: { try ScreenRecordingPackage(download: $0) })
    }
    func screenFrame(viewID: String, captureID: String, variant: ScreenRecordingVariant) async throws -> Data {
        try await screenJPEG("/api/screen-recording/views/\(Self.pathComponent(viewID))/frames/\(Self.pathComponent(captureID))?variant=\(variant.rawValue)")
    }
    func screenThumbnail(rangeID: String, catalogRevision: String) async throws -> Data {
        try await screenJPEG("/api/screen-recording/ranges/\(Self.pathComponent(rangeID))/thumbnail?catalogRevision=\(Self.pathComponent(catalogRevision))")
    }
    private func screenJPEG(_ path: String) async throws -> Data {
        let value: ScreenRecordingBytes = try await authorized(path, requestTimeout: 5, decodeError: screenError, decode: { data in
            guard data.count <= 8 * 1024 * 1024, data.starts(with: [0xff, 0xd8]) else { throw ScreenRecordingReadError("MEDIA_UNAVAILABLE") }
            return ScreenRecordingBytes(data)
        })
        return value.data
    }
    func screenClose(viewID: String) async {
        struct Released: Decodable { let released: Bool }
        let _: Released? = try? await authorized("/api/screen-recording/views/\(Self.pathComponent(viewID))", method: "DELETE", requestTimeout: 5, decodeError: screenError)
    }
}

actor ScreenRecordingSource {
    let api: APIClient
    private struct Entry { let data: Data; let cost: Int; let thumb: Bool }
    private var cache: [String: Entry] = [:]
    private var order: [String] = []
    private var activeView: ScreenRecordingView?
    private var confirmed: TimeInterval?
    private var generation = 0
    private var package: ScreenRecordingPackage?
    private var decodingFull = false
    private var decodingThumbnail = false
    init(api: APIClient) { self.api = api }
    func open(rangeID: String, catalogRevision: String, captureID: String? = nil) async throws -> ScreenRecordingView {
        generation += 1
        let token = generation
        let view = try await api.screenOpen(rangeID: rangeID, catalogRevision: catalogRevision, captureID: captureID)
        guard token == generation else { await api.screenClose(viewID: view.viewID); throw CancellationError() }
        activeView = view; confirmed = ProcessInfo.processInfo.systemUptime
        do { try await preparePackage(viewID: view.viewID) }
        catch {
            if token == generation { invalidate(); activeView = nil }
            await api.screenClose(viewID: view.viewID)
            throw error
        }
        return view
    }
    func page(viewID: String, offset: Int? = nil, atMs: Int64? = nil) async throws -> ScreenRecordingView {
        try check(viewID)
        generation += 1
        let token = generation
        let next = try await api.screenPage(viewID: viewID, offset: offset, atMs: atMs)
        let heartbeat = Task {
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
                guard !Task.isCancelled, token == generation else { return }
                _ = try? await api.screenAvailability(viewID: next.viewID)
            }
        }
        defer { heartbeat.cancel() }
        do {
            let downloaded = try await api.screenPackage(viewID: next.viewID)
            try Task.checkCancellation()
            guard token == generation else { throw CancellationError() }
            try downloaded.validate(next)
            let valid = try await api.screenAvailability(viewID: next.viewID)
            guard token == generation, !Task.isCancelled, valid.invalidCaptureIDs.isEmpty else { throw CancellationError() }
            cache.removeAll(); order.removeAll()
            activeView = next; package = downloaded; confirmed = ProcessInfo.processInfo.systemUptime
            await api.screenClose(viewID: viewID)
            return next
        } catch {
            await api.screenClose(viewID: next.viewID)
            throw error
        }
    }
    func preparePackage(viewID: String) async throws {
        try check(viewID)
        guard let view = activeView else { throw ScreenRecordingReadError("VIEW_EXPIRED") }
        if package != nil { return }
        let token = generation
        let heartbeat = Task {
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
                guard !Task.isCancelled, token == generation else { return }
                _ = try? await availability(viewID: viewID)
            }
        }
        defer { heartbeat.cancel() }
        let downloaded = try await api.screenPackage(viewID: viewID)
        try Task.checkCancellation()
        guard token == generation else { throw CancellationError() }
        try check(viewID); try downloaded.validate(view)
        package = downloaded
    }
    func availability(viewID: String) async throws -> ScreenRecordingAvailability {
        let token = generation
        do {
            let value = try await api.screenAvailability(viewID: viewID)
            guard token == generation, activeView?.viewID == viewID else { throw CancellationError() }
            guard value.invalidCaptureIDs.isEmpty, value.expiresAt > screenRecordingNowMs() else { throw ScreenRecordingReadError("FRAME_GONE") }
            confirmed = ProcessInfo.processInfo.systemUptime
            return value
        } catch {
            if token == generation && !Task.isCancelled && !screenRecordingTransient(error) { invalidate() }
            throw error
        }
    }
    private func check(_ viewID: String) throws {
        guard let view = activeView, view.viewID == viewID, view.expiresAt > screenRecordingNowMs(),
              let confirmed, ProcessInfo.processInfo.systemUptime - confirmed <= 5 else { throw ScreenRecordingReadError("VIEW_EXPIRED") }
    }
    @available(iOS 16.0, *)
    func frame(viewID: String, captureID: String, variant: ScreenRecordingVariant) async throws -> Data {
        try check(viewID)
        let key = viewID + ":" + captureID + ":" + variant.rawValue
        if let entry = cache[key] { order.removeAll { $0 == key }; order.append(key); return entry.data }
        let token = generation
        let thumbnail = variant == .thumb
        while thumbnail ? decodingThumbnail : decodingFull {
            try await Task.sleep(nanoseconds: 20_000_000)
            guard token == generation else { throw CancellationError() }
            try check(viewID)
            if let entry = cache[key] { return entry.data }
        }
        try Task.checkCancellation()
        guard let package else { throw ScreenRecordingReadError("VIEW_EXPIRED") }
        if thumbnail { decodingThumbnail = true } else { decodingFull = true }
        defer {
            if thumbnail { decodingThumbnail = false } else { decodingFull = false }
            withExtendedLifetime(package) {}
        }
        let data = try await package.jpeg(captureID: captureID, variant: variant)
        try Task.checkCancellation()
        guard token == generation else { throw CancellationError() }
        try check(viewID)
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 16384, height <= 16384 else { throw ScreenRecordingReadError("MEDIA_UNAVAILABLE") }
        cache[key] = Entry(data: data, cost: max(data.count, width * height * 4), thumb: variant == .thumb)
        order.removeAll { $0 == key }; order.append(key)
        while cache.count > 16 || cache.values.filter({ !$0.thumb }).reduce(0, { $0 + $1.cost }) > 64 * 1024 * 1024 || cache.values.filter({ $0.thumb }).reduce(0, { $0 + $1.cost }) > 8 * 1024 * 1024 {
            guard !order.isEmpty else { break }; cache.removeValue(forKey: order.removeFirst())
        }
        #if DEBUG
        let fullBytes = cache.values.filter { !$0.thumb }.reduce(0) { $0 + $1.cost }
        let thumbBytes = cache.values.filter { $0.thumb }.reduce(0) { $0 + $1.cost }
        Logger(subsystem: "com.runweave.app.native", category: "ScreenRecording").debug("cacheFrames=\(self.cache.count, privacy: .public) imageCacheBytes=\(fullBytes, privacy: .public) thumbnailCacheBytes=\(thumbBytes, privacy: .public)")
        #endif
        return data
    }
    func invalidate() {
        generation += 1; confirmed = nil; cache.removeAll(); order.removeAll(); package = nil
        #if DEBUG
        Logger(subsystem: "com.runweave.app.native", category: "ScreenRecording").debug("cacheCleared frames=0 imageBytes=0 thumbnailBytes=0")
        #endif
    }
    func close(viewID: String) async {
        if activeView?.viewID == viewID { invalidate(); activeView = nil }
        await api.screenClose(viewID: viewID)
    }
}
