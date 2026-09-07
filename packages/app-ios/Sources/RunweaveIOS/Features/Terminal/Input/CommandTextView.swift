import SwiftUI
import UIKit

struct CommandTextView: UIViewRepresentable {
  @Binding var text: String

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
    view.delegate = context.coordinator
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return view
  }
  func updateUIView(_ view: UITextView, context: Context) {
    context.coordinator.parent = self
    if view.text != text { view.text = text }
  }
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: CommandTextView
    init(_ parent: CommandTextView) { self.parent = parent }
    func textViewDidChange(_ textView: UITextView) { parent.text = textView.text }
  }
}
