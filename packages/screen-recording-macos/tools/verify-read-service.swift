import Foundation
import Darwin

@main struct ReadServiceVerification {
    static func main() throws {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count == 4, args[0] == "--socket", args[2] == "--fixture-manifest",
              args[1].hasPrefix("/"), args[3].hasPrefix("/"),
              !args[1].hasPrefix(StorePaths.standard.path), !args[3].hasPrefix(StorePaths.standard.path) else {
            throw JournalReadError("INVALID_ARGUMENT", "Explicit isolated socket and fixture manifest required")
        }
        let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[3]))) as? [String: Any]
        guard manifest?["synthetic"] as? Bool == true else { throw JournalReadError("INVALID_ARGUMENT") }
        let client = ProbeClient(path: args[1])
        let status: JournalStatus = try client.json("status", [:])
        var cursor: String?; var dates: [JournalDay] = []
        repeat {
            let page: JournalPage<JournalDay> = try client.json("days", cursor.map { ["limit": 3, "cursor": $0] } ?? ["limit": 3])
            dates += page.items; cursor = page.nextCursor
        } while cursor != nil
        guard status.availability == "ready", !dates.isEmpty else { throw JournalReadError("MEDIA_UNAVAILABLE") }
        var allRanges: [JournalRange] = []; var revision = ""; var pages = 0
        for date in dates {
            cursor = nil
            repeat {
                var params: [String: Any] = ["day": date.day, "limit": 3]
                if let cursor { params["cursor"] = cursor }
                let page: JournalPage<JournalRange> = try client.json("ranges", params)
                allRanges += page.items; cursor = page.nextCursor; revision = page.catalogRevision; pages += 1
            } while cursor != nil
        }
        guard Set(allRanges.map(\.rangeID)).count == allRanges.count,
              let range = allRanges.max(by: { $0.sampleCount < $1.sampleCount }) else { throw JournalReadError("INVALID_PROTOCOL") }
        if let expected = manifest?["localRanges"] as? [[String: Any]] {
            guard Set(expected.compactMap { $0["rangeID"] as? String }) == Set(allRanges.map(\.rangeID)) else { throw JournalReadError("FIXTURE_RANGE_MISMATCH") }
            for value in allRanges {
                guard let item = expected.first(where: { $0["rangeID"] as? String == value.rangeID }),
                      item["sampleCount"] as? Int == value.sampleCount,
                      (item["startMs"] as? NSNumber)?.int64Value == value.startMs,
                      (item["endMs"] as? NSNumber)?.int64Value == value.endMs else { throw JournalReadError("FIXTURE_RANGE_MISMATCH") }
            }
        }
        let view: JournalView = try client.json("openView", ["rangeID": range.rangeID, "catalogRevision": revision])
        defer { _ = try? client.request("closeView", ["viewID": view.viewID]) }
        var count = 0
        var privateCount = 0
        for capture in view.captures where capture.privacyPlaceholder {
            let value = try client.request("frame", ["viewID": view.viewID, "captureID": capture.id, "variant": "full"])
            guard value.0 == 422, capture.frontmostApplication == nil else { throw JournalReadError("PRIVACY_MISMATCH") }
            privateCount += 1
        }
        for capture in [view.captures.first, view.captures.dropFirst(view.captures.count / 2).first, view.captures.last].compactMap({ $0 }) where !capture.privacyPlaceholder {
            let result = try client.request("frame", ["viewID": view.viewID, "captureID": capture.id, "variant": "preview"])
            guard result.0 == 200, result.1.starts(with: [0xff,0xd8]) else { throw JournalReadError("MEDIA_UNAVAILABLE") }; count += 1
        }
        let missing = try client.request("frame", ["viewID": view.viewID, "captureID": UUID().uuidString, "variant": "full"])
        guard missing.0 == 404 else { throw JournalReadError("INVALID_PROTOCOL") }
        let available: JournalAvailability = try client.json("availability", ["viewID": view.viewID])
        guard available.invalidCaptureIDs.isEmpty else { throw JournalReadError("FRAME_GONE") }
        var extras: [String] = []
        defer { for id in extras { _ = try? client.request("closeView", ["viewID": id]) } }
        for _ in 0..<7 {
            let extra: JournalView = try client.json("openView", ["rangeID": range.rangeID, "catalogRevision": revision])
            extras.append(extra.viewID)
        }
        let busy = try client.request("openView", ["rangeID": range.rangeID, "catalogRevision": revision])
        guard busy.0 == 429 else { throw JournalReadError("VIEW_LIMIT_MISMATCH") }
        _ = try client.request("closeView", ["viewID": view.viewID])
        guard try client.request("closeView", ["viewID": view.viewID]).0 == 200 else { throw JournalReadError("CLOSE_NOT_IDEMPOTENT") }
        let report: [String: Any] = ["ok": true, "source": "synthetic socket integration", "serverEpoch": status.serverEpoch,
            "sampledJPEGFrames": count, "privacyFrames": privateCount, "pages": pages, "viewLimitStatus": busy.0, "rangeCount": allRanges.count, "unknownCaptureStatus": missing.0,
            "limitations": ["Does not establish real capture or UI acceptance", "Does not exercise delayed decoder cleanup or authentication"]]
        print(String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
private struct ProbeClient {
    let path: String
    func json<T: Decodable>(_ method: String, _ params: [String: Any]) throws -> T {
        let result = try request(method, params)
        guard result.0 == 200 else { throw JournalReadError("REQUEST_FAILED") }
        return try JSONDecoder().decode(T.self, from: result.1)
    }
    func request(_ method: String, _ params: [String: Any]) throws -> (Int, Data) {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0); guard fd >= 0 else { throw JournalReadError("NOT_RUNNING") }
        defer { Darwin.close(fd) }
        var noSignal: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        var timeout = timeval(tv_sec: 5, tv_usec: 0)
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bytes = Array(path.utf8); guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { throw JournalReadError("INVALID_ARGUMENT") }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes + [0]) }
        let connected = withUnsafePointer(to: &address) { p in p.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard connected == 0 else { throw JournalReadError("NOT_RUNNING") }
        let id = UUID().uuidString
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "requestId": id, "method": method, "params": params, "payloadLength": 0])
        var length = UInt32(data.count).bigEndian
        let wire = withUnsafeBytes(of: &length) { Data($0) } + data
        // Deliberately fragment every request; stream framing cannot depend on read boundaries.
        for byte in wire { var b = byte; guard send(fd, &b, 1, 0) == 1 else { throw JournalReadError("NOT_RUNNING") } }
        func read(_ count: Int) throws -> Data {
            var data = Data(count: count); var offset = 0
            while offset < count {
                let n = data.withUnsafeMutableBytes { recv(fd, $0.baseAddress!.advanced(by: offset), count - offset, 0) }
                guard n > 0 else { throw JournalReadError("INVALID_PROTOCOL") }; offset += n
            }; return data
        }
        let size = try read(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard size > 0, size <= 65536 else { throw JournalReadError("INVALID_PROTOCOL") }
        guard let header = try JSONSerialization.jsonObject(with: read(Int(size))) as? [String: Any],
              header["requestId"] as? String == id, let count = header["payloadLength"] as? Int,
              let status = header["status"] as? Int, count >= 0, count <= 8 * 1024 * 1024 else { throw JournalReadError("INVALID_PROTOCOL") }
        return (status, try read(count))
    }
}
