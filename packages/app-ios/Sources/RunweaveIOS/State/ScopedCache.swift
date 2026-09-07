import Foundation

/// Owned by one APIClient (one connection + endpoint). Never persisted with credentials or file contents.
struct ScopedCache {
  struct Entry {
    let data: Data
    let fetchedAt: Date
    var accessedAt: Date
  }
  final class Flight {
    let task: Task<Data, Error>
    var invalidated = false
    init(task: Task<Data, Error>) { self.task = task }
    func cancel() {
      invalidated = true
      task.cancel()
    }
  }
  var entries: [String: Entry] = [:]
  var flights: [String: Flight] = [:]
  // Match the old query defaults. A byte cap also bounds decoded asset response storage on iOS.
  static let staleTime: TimeInterval = 15
  static let retention: TimeInterval = 30 * 60
  static let capacity = 32 * 1024 * 1024

  mutating func value(_ key: String, freshOnly: Bool) -> Data? {
    let now = Date()
    entries = entries.filter { now.timeIntervalSince($0.value.accessedAt) < Self.retention }
    guard var entry = entries[key] else { return nil }
    entry.accessedAt = now
    entries[key] = entry
    guard !freshOnly || now.timeIntervalSince(entry.fetchedAt) < Self.staleTime else { return nil }
    return entry.data
  }
  mutating func insert(_ data: Data, key: String) {
    guard data.count <= Self.capacity else { return }
    entries[key] = Entry(data: data, fetchedAt: Date(), accessedAt: Date())
    var bytes = entries.values.reduce(0) { $0 + $1.data.count }
    for item in entries.sorted(by: { $0.value.accessedAt < $1.value.accessedAt }) {
      guard bytes > Self.capacity else { break }
      bytes -= item.value.data.count
      entries.removeValue(forKey: item.key)
    }
  }
  mutating func clear() {
    for flight in flights.values { flight.cancel() }
    flights.removeAll()
    entries.removeAll()
  }
}

extension APIClient {
  func cachedPreview<T: Decodable>(
    _ path: String, force: Bool = false, decode: ((Data) throws -> T)? = nil
  ) async throws -> T {
    guard hasCredentials() else { throw APIError.credentialsUnavailable }
    let parse: (Data) throws -> T = decode ?? { try JSONDecoder().decode(T.self, from: $0) }
    if !force, let data = previewCache.value(path, freshOnly: true) { return try parse(data) }
    let flight: ScopedCache.Flight
    if !force, let existing = previewCache.flights[path] {
      flight = existing
    } else {
      previewCache.flights[path]?.cancel()
      flight = ScopedCache.Flight(
        task: Task {
          try await self.authorized(path, decode: { $0 }) as Data
        })
      previewCache.flights[path] = flight
    }
    do {
      let data = try await flight.task.value
      guard !flight.invalidated else { throw CancellationError() }
      let value = try parse(data)
      if previewCache.flights[path] === flight {
        previewCache.insert(data, key: path)
        previewCache.flights.removeValue(forKey: path)
      }
      try Task.checkCancellation()
      return value
    } catch {
      if previewCache.flights[path] === flight {
        previewCache.flights.removeValue(forKey: path)
      }
      throw error
    }
  }
}
