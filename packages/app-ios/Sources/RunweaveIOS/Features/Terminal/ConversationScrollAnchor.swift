import SwiftUI
import UIKit

struct ConversationMessageFrames: PreferenceKey {
  static var defaultValue: [String: CGRect] = [:]
  static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
    value.merge(nextValue(), uniquingKeysWith: { _, next in next })
  }
}

/// Preserve the visible point within a long message, rather than just scrollTo(messageID).
@MainActor final class ConversationScrollAnchor: NSObject, ObservableObject {
  weak var scrollView: UIScrollView?
  private var frames: [String: CGRect] = [:]
  private var saved: [(String, CGFloat)] = []
  private var fallback: CGFloat = 0
  private var restoring = false
  private var contentSizeObservation: NSKeyValueObservation?
  private struct Candidate: Codable { let id: String; let offset: CGFloat }
  private struct Position: Codable {
    let candidates: [Candidate]
    let top: CGFloat
    let updatedAt: TimeInterval
  }
  private static let storageKey = "native.conversation.positions.v1"
  private var positionKey: String?
  private var pendingSave: DispatchWorkItem?
  private var dirty = false

  func bind(_ key: String?) {
    guard key != positionKey else { return }
    persist()
    positionKey = key
    saved = []; fallback = 0; restoring = false; dirty = false
    guard let key, let position = Self.positions()[key], position.top.isFinite,
      position.candidates.allSatisfy({ $0.offset.isFinite }) else { return }
    saved = position.candidates.map { ($0.id, $0.offset) }
    fallback = position.top
    restoring = true
  }
  private static func positions() -> [String: Position] {
    guard let data = DevicePreferences.store.data(forKey: storageKey),
      let positions = try? JSONDecoder().decode([String: Position].self, from: data) else { return [:] }
    return positions
  }
  func persist() {
    pendingSave?.cancel(); pendingSave = nil
    guard dirty, let positionKey else { return }
    var positions = Self.positions()
    positions[positionKey] = Position(candidates: saved.map { Candidate(id: $0.0, offset: $0.1) },
      top: fallback, updatedAt: Date().timeIntervalSince1970)
    let recent = positions.sorted { $0.value.updatedAt > $1.value.updatedAt }.prefix(100)
    if let data = try? JSONEncoder().encode(Dictionary(uniqueKeysWithValues: recent.map { ($0.key, $0.value) })) {
      DevicePreferences.store.set(data, forKey: Self.storageKey)
      dirty = false
    }
  }

  func attach(_ scroll: UIScrollView) {
    if scrollView === scroll { return }
    scrollView?.panGestureRecognizer.removeTarget(self, action: #selector(dragged))
    scrollView = scroll
    scroll.panGestureRecognizer.addTarget(self, action: #selector(dragged))
    // SwiftUI may publish the restored snapshot before the UIKit probe attaches.
    // Retry after this layout pass so the saved anchor also applies on first open.
    contentSizeObservation = scroll.observe(\.contentSize, options: [.initial, .new]) { [weak self] _, _ in
      DispatchQueue.main.async {
        guard let self, self.restoring else { return }
        self.update(self.frames)
      }
    }
  }
  @objc private func dragged() { restoring = false }
  func capture() {
    guard let scroll = scrollView else { return }
    let top = scroll.convert(scroll.bounds, to: nil).minY
    let ordered = frames.sorted { $0.value.minY < $1.value.minY }
    guard let first = ordered.firstIndex(where: { $0.value.maxY > top }) else { return }
    saved = ordered.prefix(first + 1).suffix(8).reversed().map { ($0.key, $0.value.minY - top) }
    fallback = scroll.contentOffset.y
    restoring = false
    guard positionKey != nil else { return }
    dirty = true
    if pendingSave == nil {
      let work = DispatchWorkItem { [weak self] in self?.persist() }
      pendingSave = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
    }
  }
  func commit() { restoring = true; update(frames) }
  func update(_ next: [String: CGRect]) {
    frames = next
    guard !next.isEmpty else { return }
    if !restoring { capture(); return }
    guard restoring, let scroll = scrollView, !scroll.isDragging, !scroll.isDecelerating else { return }
    let top = scroll.convert(scroll.bounds, to: nil).minY
    let survivor = saved.first { next[$0.0] != nil }
    let target = survivor.map { scroll.contentOffset.y + next[$0.0]!.minY - top - $0.1 } ?? fallback
    let minY = -scroll.adjustedContentInset.top
    let maxY = max(minY, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
    let clamped = min(maxY, max(minY, target))
    if abs(scroll.contentOffset.y - clamped) > 0.5 { scroll.setContentOffset(CGPoint(x: 0, y: clamped), animated: false) }
  }
  func latest() {
    saved = []; restoring = false
    guard let scroll = scrollView else { return }
    let top = max(-scroll.adjustedContentInset.top, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
    scroll.setContentOffset(CGPoint(x: 0, y: top), animated: false)
  }
}

struct ConversationScrollProbe: UIViewRepresentable {
  let anchor: ConversationScrollAnchor
  func makeUIView(context: Context) -> UIView { Probe(anchor: anchor) }
  func updateUIView(_ uiView: UIView, context: Context) { (uiView as? Probe)?.findScroll() }
  private final class Probe: UIView {
    let anchor: ConversationScrollAnchor
    init(anchor: ConversationScrollAnchor) { self.anchor = anchor; super.init(frame: .zero); isUserInteractionEnabled = false }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func didMoveToWindow() { super.didMoveToWindow(); findScroll() }
    override func layoutSubviews() { super.layoutSubviews(); findScroll() }
    func findScroll() {
      var parent = superview
      while let view = parent {
        if let scroll = view as? UIScrollView { anchor.attach(scroll); return }
        parent = view.superview
      }
    }
  }
}
