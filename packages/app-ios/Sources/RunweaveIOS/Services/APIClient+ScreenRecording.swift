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
    func screenOpen(rangeID: String, catalogRevision: String) async throws -> ScreenRecordingView {
        try await authorized("/api/screen-recording/views", method: "POST", body: ["rangeID": rangeID, "catalogRevision": catalogRevision], requestTimeout: 5, decodeError: screenError)
    }
    func screenAvailability(viewID: String) async throws -> ScreenRecordingAvailability {
        try await authorized("/api/screen-recording/views/\(Self.pathComponent(viewID))/availability", requestTimeout: 5, decodeError: screenError)
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
    init(api: APIClient) { self.api = api }
    func open(rangeID: String, catalogRevision: String) async throws -> ScreenRecordingView {
        generation += 1
        let token = generation
        let view = try await api.screenOpen(rangeID: rangeID, catalogRevision: catalogRevision)
        guard token == generation else { await api.screenClose(viewID: view.viewID); throw CancellationError() }
        activeView = view; confirmed = ProcessInfo.processInfo.systemUptime
        return view
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
            if token == generation && !Task.isCancelled { invalidate() }
            throw error
        }
    }
    private func check(_ viewID: String) throws {
        guard let view = activeView, view.viewID == viewID, view.expiresAt > screenRecordingNowMs(),
              let confirmed, ProcessInfo.processInfo.systemUptime - confirmed <= 5 else { throw ScreenRecordingReadError("VIEW_EXPIRED") }
    }
    func frame(viewID: String, captureID: String, variant: ScreenRecordingVariant) async throws -> Data {
        try check(viewID)
        let key = viewID + ":" + captureID + ":" + variant.rawValue
        if let entry = cache[key] { order.removeAll { $0 == key }; order.append(key); return entry.data }
        let token = generation
        let data = try await api.screenFrame(viewID: viewID, captureID: captureID, variant: variant)
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
        generation += 1; confirmed = nil; cache.removeAll(); order.removeAll()
        #if DEBUG
        Logger(subsystem: "com.runweave.app.native", category: "ScreenRecording").debug("cacheCleared frames=0 imageBytes=0 thumbnailBytes=0")
        #endif
    }
    func close(viewID: String) async {
        if activeView?.viewID == viewID { invalidate(); activeView = nil }
        await api.screenClose(viewID: viewID)
    }
}
