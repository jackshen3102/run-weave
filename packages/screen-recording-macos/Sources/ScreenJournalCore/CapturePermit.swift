import Foundation

// Linearizes cancellation with the short synchronous encoder/index append.
// Configuration is invalidated before new policy is published on the main actor.
final class CapturePermit: @unchecked Sendable {
    private let lock = NSLock()
    private var generation = 0
    func invalidate() -> Int {
        lock.lock(); defer { lock.unlock() }
        generation += 1; return generation
    }
    func withCurrent<T>(_ expected: Int, _ operation: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        guard generation == expected else { throw journalError("capture_generation_expired") }
        return try operation()
    }
}
