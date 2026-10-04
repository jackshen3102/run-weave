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

  func attach(_ scroll: UIScrollView) {
    if scrollView === scroll { return }
    scrollView?.panGestureRecognizer.removeTarget(self, action: #selector(dragged))
    scrollView = scroll
    scroll.panGestureRecognizer.addTarget(self, action: #selector(dragged))
  }
  @objc private func dragged() { saved = []; restoring = false }
  func capture() {
    guard let scroll = scrollView else { return }
    let top = scroll.convert(scroll.bounds, to: nil).minY
    let ordered = frames.sorted { $0.value.minY < $1.value.minY }
    guard let first = ordered.firstIndex(where: { $0.value.maxY > top }) else { return }
    saved = ordered.prefix(first + 1).reversed().map { ($0.key, $0.value.minY - top) }
    fallback = scroll.contentOffset.y
    restoring = false
  }
  func commit() { restoring = true; update(frames) }
  func update(_ next: [String: CGRect]) {
    frames = next
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
