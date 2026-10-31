import Foundation
import Darwin

struct JournalSocketRequest: Decodable {
    let version: Int
    let requestId: String
    let method: String
    let params: [String: JournalParameter]
    let payloadLength: Int?
}
enum JournalParameter: Codable {
    case text(String), number(Int)
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let text = try? c.decode(String.self) { self = .text(text) }
        else { self = .number(try c.decode(Int.self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .text(let text): try c.encode(text); case .number(let number): try c.encode(number) }
    }
    var text: String? { if case .text(let text) = self { return text }; return nil }
    var number: Int? { if case .number(let number) = self { return number }; return nil }
}
struct JournalSocketResponse: Encodable {
    let requestId: String
    let status: Int
    let code: String
    let payloadLength: Int
    let contentType: String
    let serverEpoch: String
}
final class JournalReadSocketServer: @unchecked Sendable {
    private let service: JournalReadService
    private let path: String
    private let validation: Bool
    private let lock = NSLock()
    private var listener: DispatchSourceRead?
    private var clients = Set<Int32>()
    private var stopped = false
    private let queue = DispatchQueue(label: "ScreenJournal.read.socket", qos: .userInitiated, attributes: .concurrent)
    init(paths: StorePaths, service: JournalReadService) throws {
        self.service = service
        validation = paths.validation
        path = try paths.file("runtime/read.sock").path
        var address = sockaddr_un()
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { throw JournalReadError("SOCKET_PATH_TOO_LONG") }
        // Called only after the exclusive writer lock and recovery succeeded.
        var info = stat()
        if lstat(path, &info) == 0 {
            guard (info.st_mode & S_IFMT) == S_IFSOCK, info.st_uid == getuid() else { throw JournalReadError("UNSAFE_SOCKET") }
            guard unlink(path) == 0 else { throw JournalReadError("SOCKET_UNAVAILABLE") }
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw JournalReadError("SOCKET_UNAVAILABLE") }
        var owned = true
        defer { if owned { Darwin.close(fd) } }
        address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { target in target.copyBytes(from: bytes + [0]) }
        let bound = withUnsafePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard bound == 0 else { throw JournalReadError("SOCKET_UNAVAILABLE") }
        guard chmod(path, 0o600) == 0, listen(fd, 4) == 0 else { unlink(path); throw JournalReadError("SOCKET_UNAVAILABLE") }
        _ = fcntl(fd, F_SETFL, O_NONBLOCK)
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.acceptClients(fd) }
        source.setCancelHandler { Darwin.close(fd) }
        listener = source; owned = false; source.resume()
    }
    private func acceptClients(_ fd: Int32) {
        while true {
            let client = accept(fd, nil, nil)
            if client < 0 { return }
            var uid: uid_t = 0, gid: gid_t = 0
            guard getpeereid(client, &uid, &gid) == 0, uid == getuid() else { Darwin.close(client); continue }
            _ = fcntl(client, F_SETFL, fcntl(client, F_GETFL) & ~O_NONBLOCK)
            var noSignal: Int32 = 1
            _ = setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
            var timeout = timeval(tv_sec: 5, tv_usec: 0)
            _ = setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            _ = setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            let admitted = lock.withLock {
                if stopped || clients.count >= 4 { return false }
                clients.insert(client); return true
            }
            guard admitted else { rejectBusy(client); Darwin.close(client); continue }
            queue.async { [self] in handle(client) }
        }
    }
    private func rejectBusy(_ fd: Int32) {
        // A bounded rejection path never obtains a view, reader, or storage lease.
        let deadline = ContinuousClock.now.advanced(by: .milliseconds(100))
        do {
            let size = try read(fd, count: 4, deadline: deadline).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            guard size > 0, size <= 65536 else { return }
            let request = try JSONDecoder().decode(JournalSocketRequest.self, from: read(fd, count: Int(size), deadline: deadline))
            guard request.requestId.utf8.count <= 128 else { return }
            let body = try JSONEncoder().encode(JournalReadError("BUSY", retryable: true))
            let header = try JSONEncoder().encode(JournalSocketResponse(requestId: request.requestId, status: 429, code: "BUSY", payloadLength: body.count, contentType: "application/json", serverEpoch: service.serverEpoch))
            var length = UInt32(header.count).bigEndian
            try write(fd, data: withUnsafeBytes(of: &length) { Data($0) } + header + body, deadline: deadline)
        } catch { }
    }
    private func read(_ fd: Int32, count: Int, deadline: ContinuousClock.Instant) throws -> Data {
        var result = Data(count: count); var offset = 0
        while offset < count {
            guard ContinuousClock.now < deadline else { throw JournalReadError("TIMEOUT") }
            let remaining = ContinuousClock.now.duration(to: deadline).components
            var timeout = timeval(tv_sec: Int(remaining.seconds), tv_usec: Int32(max(1, remaining.attoseconds / 1_000_000_000_000)))
            _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            let n = result.withUnsafeMutableBytes { recv(fd, $0.baseAddress!.advanced(by: offset), count - offset, 0) }
            if n < 0 && errno == EINTR { continue }
            guard n > 0 else { throw JournalReadError("INVALID_ARGUMENT") }; offset += n
        }
        return result
    }
    private func write(_ fd: Int32, data: Data, deadline: ContinuousClock.Instant) throws {
        var offset = 0
        while offset < data.count {
            guard ContinuousClock.now < deadline else { throw JournalReadError("TIMEOUT") }
            let remaining = ContinuousClock.now.duration(to: deadline).components
            var timeout = timeval(tv_sec: Int(remaining.seconds), tv_usec: Int32(max(1, remaining.attoseconds / 1_000_000_000_000)))
            _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            let n = data.withUnsafeBytes { send(fd, $0.baseAddress!.advanced(by: offset), data.count - offset, 0) }
            if n < 0 && errno == EINTR { continue }
            guard n > 0 else { throw JournalReadError("NOT_RUNNING") }; offset += n
        }
    }
    private final class Reply: @unchecked Sendable {
        let lock = NSLock()
        var value: (Int, String, String, Data, String)?
        func set(_ value: (Int, String, String, Data, String)) { lock.withLock { self.value = value } }
        func get() -> (Int, String, String, Data, String)? { lock.withLock { value } }
    }
    private func handle(_ fd: Int32) {
        defer { _ = lock.withLock { clients.remove(fd) }; Darwin.close(fd) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        do {
            let size = try read(fd, count: 4, deadline: deadline).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            guard size > 0, size <= 65536 else { return }
            let request = try JSONDecoder().decode(JournalSocketRequest.self, from: read(fd, count: Int(size), deadline: deadline))
            guard request.requestId.utf8.count <= 128, request.payloadLength == nil || request.payloadLength == 0 else { return }
            let reply = Reply()
            let task = Task { [service, validation] in
                let epoch = service.serverEpoch
                do {
                    guard request.version == 1 else { throw JournalReadError("INCOMPATIBLE") }
                    #if DEBUG
                    if validation, request.method == "diagnostics", request.params.isEmpty {
                        reply.set((200, "OK", "application/json", try JSONEncoder().encode(await service.diagnostics()), epoch))
                        return
                    }
                    #endif
                    let (body, type) = try await Self.dispatch(request, service: service)
                    reply.set((200, "OK", type, body, epoch))
                } catch {
                    let safe = error as? JournalReadError ?? JournalReadError("MEDIA_UNAVAILABLE")
                    reply.set((safe.httpStatus, safe.code, "application/json", (try? JSONEncoder().encode(safe)) ?? Data(), epoch))
                }
            }
            defer { task.cancel() }
            while reply.get() == nil {
                if ContinuousClock.now >= deadline || lock.withLock({ stopped }) { return }
                var byte: UInt8 = 0
                let peek = recv(fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT)
                if peek == 0 || peek > 0 { return } // EOF or forbidden pipelining
                if errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR { return }
                Thread.sleep(forTimeInterval: 0.01)
            }
            guard let (status, code, type, body, epoch) = reply.get(), body.count <= 8 * 1024 * 1024 else { return }
            let header = try JSONEncoder().encode(JournalSocketResponse(requestId: request.requestId, status: status, code: code,
                payloadLength: body.count, contentType: type, serverEpoch: epoch))
            var length = UInt32(header.count).bigEndian
            try write(fd, data: withUnsafeBytes(of: &length) { Data($0) }, deadline: deadline); try write(fd, data: header, deadline: deadline); try write(fd, data: body, deadline: deadline)
        } catch { /* No paths, credentials, or image content in transport diagnostics. */ }
    }
    private static func dispatch(_ r: JournalSocketRequest, service: JournalReadService) async throws -> (Data, String) {
        func text(_ key: String) throws -> String {
            guard let value = r.params[key]?.text, !value.isEmpty, value.utf8.count <= 1024, !value.contains("/"), !value.contains("\\"), !value.contains("\0") else { throw JournalReadError("INVALID_ARGUMENT") }; return value
        }
        func json<T: Encodable>(_ value: T) throws -> (Data, String) { (try JSONEncoder().encode(value), "application/json") }
        let allowed: [String: Set<String>] = ["status": [], "days": ["cursor", "limit"], "ranges": ["day", "cursor", "limit"],
            "thumbnail": ["rangeID", "catalogRevision"], "openView": ["rangeID", "catalogRevision"], "availability": ["viewID"],
            "frame": ["viewID", "captureID", "variant"], "closeView": ["viewID"]]
        guard let keys = allowed[r.method], Set(r.params.keys).isSubset(of: keys) else { throw JournalReadError("INVALID_ARGUMENT") }
        if r.params["cursor"] != nil && r.params["cursor"]?.text == nil { throw JournalReadError("INVALID_ARGUMENT") }
        if r.params["limit"] != nil && r.params["limit"]?.number == nil { throw JournalReadError("INVALID_ARGUMENT") }
        switch r.method {
        case "status": return try json(await service.status())
        case "days": return try json(await service.days(cursor: r.params["cursor"]?.text, limit: r.params["limit"]?.number ?? 7))
        case "ranges": return try json(await service.ranges(day: text("day"), cursor: r.params["cursor"]?.text, limit: r.params["limit"]?.number ?? 100))
        case "openView": return try json(await service.open(rangeID: text("rangeID"), catalogRevision: text("catalogRevision")))
        case "availability": return try json(await service.availability(viewID: text("viewID")))
        case "frame":
            guard let variant = JournalVariant(rawValue: try text("variant")) else { throw JournalReadError("INVALID_ARGUMENT") }
            return (try await service.frame(viewID: text("viewID"), captureID: text("captureID"), variant: variant), "image/jpeg")
        case "thumbnail": return (try await service.thumbnail(rangeID: text("rangeID"), catalogRevision: text("catalogRevision")), "image/jpeg")
        case "closeView": await service.close(viewID: try text("viewID")); return try json(["released": true])
        default: throw JournalReadError("INVALID_ARGUMENT")
        }
    }
    func shutdown() async {
        let source = lock.withLock { stopped = true; return listener }
        source?.cancel()
        lock.withLock { for fd in clients { Darwin.shutdown(fd, SHUT_RDWR) } }
        while lock.withLock({ !clients.isEmpty }) { try? await Task.sleep(for: .milliseconds(20)) }
        await service.shutdown()
        unlink(path)
    }
}
