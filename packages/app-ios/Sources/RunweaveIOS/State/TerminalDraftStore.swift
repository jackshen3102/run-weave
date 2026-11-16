import Combine
import Foundation

/// Mutable draft data has a per-terminal notification boundary; archives stay owned by AppSession.
@MainActor
final class TerminalDraftStore {
  struct Snapshot: Equatable {
    let text: String
    let suppressedQuickInput: Bool
    let unconfirmedInput: Bool
  }

  final class Record: ObservableObject {
    @Published private(set) var snapshot: Snapshot
    init(_ snapshot: Snapshot) { self.snapshot = snapshot }
    fileprivate func replace(_ next: Snapshot) { if snapshot != next { snapshot = next } }
  }

  let changes = PassthroughSubject<Void, Never>()
  private(set) var text: [String: String] = [:]
  private(set) var suppressed = Set<String>()
  private(set) var unconfirmed = Set<String>()
  private var records: [String: Record] = [:]

  func snapshot(_ id: String) -> Snapshot {
    Snapshot(text: text[id] ?? "", suppressedQuickInput: suppressed.contains(id),
      unconfirmedInput: unconfirmed.contains(id))
  }

  func record(_ id: String) -> Record {
    if let record = records[id] { return record }
    let record = Record(snapshot(id)); records[id] = record
    return record
  }

  func replaceText(_ next: [String: String]) {
    guard text != next else { return }
    let ids = Set(text.keys).union(next.keys).filter { text[$0] != next[$0] }
    text = next; publish(Set(ids))
  }
  func replaceSuppressed(_ next: Set<String>) {
    let ids = suppressed.symmetricDifference(next)
    suppressed = next; publish(ids)
  }
  func replaceUnconfirmed(_ next: Set<String>) {
    let ids = unconfirmed.symmetricDifference(next)
    unconfirmed = next; publish(ids)
  }

  func edit(_ value: String, id: String, suppressQuickInput: Bool) {
    let before = snapshot(id)
    if before.text != value { unconfirmed.remove(id) }
    if value.isEmpty { suppressed.remove(id); text.removeValue(forKey: id) }
    else {
      if suppressQuickInput { suppressed.insert(id) }
      text[id] = value
    }
    if before != snapshot(id) { publish([id]) }
  }

  func setUnconfirmed(_ value: Bool, id: String) {
    guard unconfirmed.contains(id) != value else { return }
    if value { unconfirmed.insert(id) } else { unconfirmed.remove(id) }
    records[id]?.replace(snapshot(id))
    changes.send()
  }

  func clearContents() {
    text = [:]; suppressed = []; unconfirmed = []
    for (id, record) in records { record.replace(snapshot(id)) }
    changes.send()
  }

  func resetScope() {
    clearContents()
    records.removeAll()
  }

  private func publish(_ ids: Set<String>) {
    guard !ids.isEmpty else { return }
    for id in ids { records[id]?.replace(snapshot(id)) }
    changes.send()
  }
}
