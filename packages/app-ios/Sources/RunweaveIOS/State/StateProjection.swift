import Combine
import Foundation

/// A view observes a value it uses, rather than every mutation of a service owner.
@MainActor
final class StateProjection<Value: Equatable>: ObservableObject {
  @Published private(set) var value: Value
  private let read: () -> Value
  private let isVisible: () -> Bool
  private var subscription: AnyCancellable?
  private var pending = false
  private var active = true

  init(changes: AnyPublisher<Void, Never>, isVisible: @escaping () -> Bool = { true }, read: @escaping () -> Value) {
    self.read = read; self.isVisible = isVisible
    value = read()
    subscription = changes.sink { [weak self] in self?.invalidate() }
  }

  func setActive(_ next: Bool) {
    active = next
    if next { refresh() }
  }

  func invalidate() {
    guard active, !pending else { return }
    pending = true
    // ObservableObject publishes before mutation. Coalesce a transaction and read
    // its completed values, including changes from more than one source.
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.pending = false
      self.refresh()
    }
  }

  private func refresh() {
    guard active, isVisible() else { return }
    let next = read()
    if value != next {
      value = next
    }
  }
}
