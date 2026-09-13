import SwiftUI

struct QuickReplyEditorView: View {
  @EnvironmentObject private var store: LocalQuickReplyStore
  @Environment(\.dismiss) private var dismiss
  private let id: UUID?
  @State private var title: String
  @State private var text: String
  @State private var failure: String?
  @State private var editingBody = false

  init(item: LocalQuickReply? = nil, initialBody: String = "") {
    id = item?.id
    _title = State(initialValue: item?.title ?? "")
    _text = State(initialValue: item?.body ?? initialBody)
  }

  var body: some View {
    Form {
      Section(header: Text("标题")) {
        TextField("可选，留空从正文生成", text: $title)
          .accessibilityIdentifier("quick-reply-title")
      }
      Section(header: Text("完整正文"), footer: Text("技能名称按普通文本原样保存，不会自动执行。正文最多 64 KiB。")) {
        CommandTextView(
          text: $text, isFocused: $editingBody, collapsesWhenUnfocused: false,
          accessibilityLabel: "快捷回复正文"
        )
        .frame(height: 260)
        .accessibilityIdentifier("quick-reply-body")
      }
      if let failure { Section { Text(failure).foregroundColor(.red) } }
      if let error = store.readError { Section { Text(error).foregroundColor(.red) } }
      Section {
        Button(store.saving ? "保存中…" : "保存") {
          failure = nil
          Task {
            do {
              try await store.save(id: id, title: title, body: text)
              dismiss()
            } catch { failure = error.localizedDescription }
          }
        }
        .disabled(!store.canEdit || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityIdentifier("quick-reply-save")
      }
    }
    .disabled(store.saving)
    .navigationTitle(id == nil ? "新增快捷回复" : "编辑快捷回复")
    .navigationBarTitleDisplayMode(.inline)
    .navigationBarBackButtonHidden(store.saving)
    .task { await store.loadIfNeeded() }
  }
}
