import SwiftUI
import UIKit

struct CommandTextView: UIViewRepresentable {
  @Binding var text: String
  @Binding var isFocused: Bool
  var collapsesWhenUnfocused = true
  var accessibilityLabel = "命令草稿"
  var maximumHeight: CGFloat? = nil
  var onHeightChange: ((CGFloat) -> Void)? = nil
  var editor: CommandTextEditor? = nil

  func makeUIView(context: Context) -> GrowingCommandTextView {
    let view = GrowingCommandTextView()
    editor?.view = view
    view.font = .preferredFont(forTextStyle: .body)
    view.adjustsFontForContentSizeCategory = true
    view.autocapitalizationType = .none
    view.autocorrectionType = .no
    view.spellCheckingType = .no
    view.smartQuotesType = .no
    view.smartDashesType = .no
    view.smartInsertDeleteType = .no
    view.accessibilityLabel = accessibilityLabel
    view.backgroundColor = .clear
    view.textContainer.maximumNumberOfLines = 1
    view.textContainer.lineBreakMode = .byTruncatingTail
    view.delegate = context.coordinator
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return view
  }
  func updateUIView(_ view: GrowingCommandTextView, context: Context) {
    context.coordinator.parent = self
    let expanded = isFocused || !collapsesWhenUnfocused
    view.textContainer.maximumNumberOfLines = expanded ? 0 : 1
    view.textContainer.lineBreakMode = expanded ? .byWordWrapping : .byTruncatingTail
    view.maximumHeight = maximumHeight
    view.onHeightChange = onHeightChange
    // Never replace an in-progress IME composition with the previous committed SwiftUI value.
    if view.markedTextRange == nil, view.text != text {
      view.text = text
      view.revealSelectionAfterLayout = isFocused
    }
    view.setNeedsLayout()
    if !expanded { view.setContentOffset(.zero, animated: false) }
    if !isFocused, view.isFirstResponder { view.resignFirstResponder() }
    if isFocused, !view.isFirstResponder {
      DispatchQueue.main.async {
        guard context.coordinator.parent.isFocused, view.window != nil else { return }
        view.becomeFirstResponder()
      }
    }
  }
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  @available(iOS 16.0, *)
  func sizeThatFits(_ proposal: ProposedViewSize, uiView: GrowingCommandTextView, context: Context) -> CGSize? {
    guard maximumHeight != nil, let width = proposal.width, let height = proposal.height else { return nil }
    return CGSize(width: width, height: height)
  }
  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: CommandTextView
    init(_ parent: CommandTextView) { self.parent = parent }
    func textViewDidBeginEditing(_ textView: UITextView) { parent.isFocused = true }
    func textViewDidEndEditing(_ textView: UITextView) { parent.isFocused = false }
    func textViewDidChange(_ textView: UITextView) {
      parent.text = textView.text
      if let view = textView as? GrowingCommandTextView {
        view.revealSelectionAfterLayout = true
        view.setNeedsLayout()
      }
    }
  }
}

/// Keep UIKit's selection and undo behavior when inserting a saved phrase.
@MainActor
final class CommandTextEditor: ObservableObject {
  fileprivate weak var view: GrowingCommandTextView?

  func insert(_ text: String) -> String? {
    guard let view else { return nil }
    view.unmarkText()
    view.insertText(text)
    view.revealSelectionAfterLayout = true
    view.setNeedsLayout()
    return view.text
  }
}

/// Opt-in growing behavior with scrolling once the available height is filled.
final class GrowingCommandTextView: UITextView {
  var maximumHeight: CGFloat?
  var onHeightChange: ((CGFloat) -> Void)?
  var revealSelectionAfterLayout = false
  private var measuredHeight: CGFloat = 0
  private var reportedHeight: CGFloat = 0
  private var reportPending = false
  private var previousSize: CGSize = .zero

  override func layoutSubviews() {
    super.layoutSubviews()
    guard let maximumHeight, bounds.width > 0, let font else { return }
    let minimum = ceil(font.lineHeight + textContainerInset.top + textContainerInset.bottom)
    let needed = max(minimum, ceil(sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude)).height))
    // Report natural height. Keeping a previously capped height would prevent growth when
    // the keyboard disappears without any text change.
    measuredHeight = needed
    if bounds.size != previousSize {
      previousSize = bounds.size
      revealSelectionAfterLayout = isFirstResponder
    }
    let scrolls = needed > maximumHeight + 0.5
    if isScrollEnabled != scrolls {
      isScrollEnabled = scrolls
      if !scrolls { setContentOffset(.zero, animated: false) }
    }
    if !reportPending, abs(measuredHeight - reportedHeight) > 0.5 || revealSelectionAfterLayout {
      reportPending = true
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.reportPending = false
        if abs(self.measuredHeight - self.reportedHeight) > 0.5 {
          self.reportedHeight = self.measuredHeight
          self.onHeightChange?(self.measuredHeight)
        }
        if self.revealSelectionAfterLayout {
          self.revealSelectionAfterLayout = false
          if self.isFirstResponder, self.isScrollEnabled {
            self.scrollRangeToVisible(self.selectedRange)
          }
        }
      }
    }
  }
}
