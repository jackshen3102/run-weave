import Foundation

// Shared by the storage owner and decoders. Cancellation never releases a lease;
// only the decoder's actual completion does so.
final class SegmentReadCoordinator: @unchecked Sendable {
    final class Lease: @unchecked Sendable {
        let id = UUID()
        let segmentID: String
        private let lock = NSLock()
        private var cancelled = false
        private var cancellation: (() -> Void)?
        init(_ segmentID: String) { self.segmentID = segmentID }
        func check() throws { if lock.withLock({ cancelled }) { throw JournalReadError("FRAME_GONE") }; try Task.checkCancellation() }
        func onCancel(_ body: @escaping () -> Void) {
            let run = lock.withLock { cancellation = body; return cancelled }
            if run { body() }
        }
        func cancel() {
            let body = lock.withLock { cancelled = true; return cancellation }
            body?()
        }
    }
    private let lock = NSLock()
    private var leases: [UUID: Lease] = [:]
    private var invalid = Set<String>()
    private var revision = 0
    private var subscribers: [UUID: AsyncStream<Int>.Continuation] = [:]
    var invalidationRevision: Int { lock.withLock { revision } }
    var activeCount: Int { lock.withLock { leases.count } }
    func activeCount(for segmentID: String) -> Int { lock.withLock { leases.values.filter { $0.segmentID == segmentID }.count } }
    func acquire(_ segmentID: String) throws -> Lease {
        try lock.withLock {
            guard !invalid.contains(segmentID) else { throw JournalReadError("FRAME_GONE") }
            let lease = Lease(segmentID); leases[lease.id] = lease; return lease
        }
    }
    func release(_ lease: Lease) { _ = lock.withLock { leases.removeValue(forKey: lease.id) } }
    func changes() -> AsyncStream<Int> {
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let id = UUID()
            let current = lock.withLock { subscribers[id] = continuation; return revision }
            continuation.yield(current)
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }; _ = self.lock.withLock { self.subscribers.removeValue(forKey: id) }
            }
        }
    }
    func removed(_ segmentID: String) { _ = lock.withLock { invalid.remove(segmentID) } }
    func invalidate(_ segmentID: String) -> Bool {
        let pending: [Lease] = lock.withLock {
            if invalid.insert(segmentID).inserted { revision += 1 }
            return leases.values.filter { $0.segmentID == segmentID }
        }
        let notification = lock.withLock { (revision, Array(subscribers.values)) }
        notification.1.forEach { $0.yield(notification.0) }
        pending.forEach { $0.cancel() }
        return pending.isEmpty
    }
    func cancelAll() { lock.withLock { Array(leases.values) }.forEach { $0.cancel() } }
}
struct JournalFramePermit {
    let frame: JournalIndexedCapture
    let url: URL
    let lease: SegmentReadCoordinator.Lease
    var validationGate: URL? = nil
}
