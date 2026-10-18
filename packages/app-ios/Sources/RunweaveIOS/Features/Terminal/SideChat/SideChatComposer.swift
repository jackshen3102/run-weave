import SwiftUI
import UIKit

struct SideChatComposer: View {
  @ObservedObject var model: SideChatModel
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  private var compact: Bool { verticalSizeClass == .compact }
  var body: some View {
    VStack(spacing: 8) {
      HStack(alignment: .bottom, spacing: 10) {
        SideChatTextEditor(model: model)
          .frame(minHeight: compact ? 32 : 72, maxHeight: compact ? 36 : 120)
          .padding(compact ? 4 : 6).background(Color(.secondarySystemBackground)).cornerRadius(12)
        if compact { sendButton }
      }
      if !compact {
        HStack {
          Text("独立问答 · 只展示最终答案").font(.caption).foregroundColor(.secondary)
          Spacer()
          sendButton
        }
      }
    }.padding(.horizontal).padding(.vertical, compact ? 6 : 16).background(Color(.systemBackground))
  }
  private var sendButton: some View {
    Button("发送") { Task { await model.send() } }
      .buttonStyle(.borderedProminent).disabled(!model.canSend)
      .accessibilityIdentifier("side-chat-send")
  }
}
private struct SideChatTextEditor: UIViewRepresentable {
  @ObservedObject var model: SideChatModel
  func makeCoordinator() -> Coordinator { Coordinator(model) }
  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.font = .preferredFont(forTextStyle: .body)
    view.adjustsFontForContentSizeCategory = true
    view.backgroundColor = .clear
    view.accessibilityLabel = "旁聊消息"
    view.accessibilityIdentifier = "side-chat-input"
    view.text = model.draft.text
    view.selectedRange = selection(view)
    view.delegate = context.coordinator
    context.coordinator.view = view
    model.commitEditor = { [weak coordinator = context.coordinator] in
      guard let coordinator, let view = coordinator.view else { return }
      view.unmarkText(); coordinator.capture(view)
    }
    return view
  }
  func updateUIView(_ view: UITextView, context: Context) {
    view.isEditable = model.pending?.kind != "end"
    guard view.markedTextRange == nil, view.text != model.draft.text else { return }
    let draft = model.draft
    view.text = draft.text
    let count = (draft.text as NSString).length
    let start = min(count, max(0, draft.start))
    view.selectedRange = NSRange(location: start, length: min(count - start, max(0, draft.end - start)))
  }
  private func selection(_ view: UITextView) -> NSRange {
    let count = (view.text as NSString).length
    let start = min(count, max(0, model.draft.start))
    return NSRange(location: start, length: min(count - start, max(0, model.draft.end - start)))
  }
  @MainActor final class Coordinator: NSObject, UITextViewDelegate {
    let model: SideChatModel
    weak var view: UITextView?
    init(_ model: SideChatModel) { self.model = model }
    func capture(_ view: UITextView) {
      model.edit(text: view.text, start: view.selectedRange.location,
        end: view.selectedRange.location + view.selectedRange.length)
    }
    func textViewDidChange(_ textView: UITextView) { capture(textView) }
    func textViewDidChangeSelection(_ textView: UITextView) { capture(textView) }
    func textViewDidEndEditing(_ textView: UITextView) { capture(textView) }
  }
}
