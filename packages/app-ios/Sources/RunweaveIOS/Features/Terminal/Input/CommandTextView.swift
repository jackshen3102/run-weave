import SwiftUI
import UIKit

struct CommandTextView: UIViewRepresentable {
  @Binding var text: String
  @Binding var isFocused: Bool

  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.font = .preferredFont(forTextStyle: .body)
    view.adjustsFontForContentSizeCategory = true
    view.autocapitalizationType = .none
    view.autocorrectionType = .no
    view.spellCheckingType = .no
    view.smartQuotesType = .no
    view.smartDashesType = .no
    view.smartInsertDeleteType = .no
    view.accessibilityLabel = "命令草稿"
    view.backgroundColor = .clear
    view.textContainer.maximumNumberOfLines = 1
    view.textContainer.lineBreakMode = .byTruncatingTail
    view.delegate = context.coordinator
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return view
  }
  func updateUIView(_ view: UITextView, context: Context) {
    context.coordinator.parent = self
    view.textContainer.maximumNumberOfLines = isFocused ? 0 : 1
    view.textContainer.lineBreakMode = isFocused ? .byWordWrapping : .byTruncatingTail
    if view.text != text { view.text = text }
    if !isFocused { view.setContentOffset(.zero, animated: false) }
    if !isFocused, view.isFirstResponder { view.resignFirstResponder() }
  }
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: CommandTextView
    init(_ parent: CommandTextView) { self.parent = parent }
    func textViewDidBeginEditing(_ textView: UITextView) { parent.isFocused = true }
    func textViewDidEndEditing(_ textView: UITextView) { parent.isFocused = false }
    func textViewDidChange(_ textView: UITextView) { parent.text = textView.text }
  }
}
