import Clarity
import SwiftUI
import UIKit

/// Freeze the read's transport and session, so an editor never writes to another computer.
struct FileEditTarget: Identifiable {
  let id = UUID()
  let file: PreviewFile
  let api: APIClient
  let generation: Int
}

struct FileEditor: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  let projectID: String
  let target: FileEditTarget
  let onSaved: (PreviewFile) -> Void
  @State private var baseline: PreviewFile
  @State private var draft: String
  @State private var busy = false
  @State private var failure: String?
  @State private var conflict = false
  @State private var saved = false
  @State private var confirmation: Confirmation?

  private enum Confirmation: String, Identifiable {
    case discard, reload, overwrite
    var id: String { rawValue }
  }

  init(session: AppSession, projectID: String, target: FileEditTarget,
       onSaved: @escaping (PreviewFile) -> Void) {
    self.session = session
    self.projectID = projectID
    self.target = target
    self.onSaved = onSaved
    _baseline = State(initialValue: target.file)
    _draft = State(initialValue: target.file.content)
  }

  private var dirty: Bool { draft != baseline.content }
  private var current: Bool {
    session.generation == target.generation && session.api === target.api && session.authenticated
  }
  private var writable: Bool {
    baseline.base == "project" && !baseline.readonly && baseline.mtimeMs != nil
  }
  private var tooLarge: Bool { draft.utf8.count > 1024 * 1024 }
  private var canSave: Bool { current && writable && dirty && !tooLarge && !busy }

  var body: some View {
    NavigationView {
      VStack(alignment: .leading, spacing: 8) {
        Text(baseline.path).font(.caption).foregroundColor(.secondary).lineLimit(2)
        if !current {
          Text("连接已变化，不能保存到原电脑。可复制草稿后关闭并重新打开文件。")
            .foregroundColor(.orange)
        }
        if tooLarge { Text("内容超过 1 MiB，无法保存。请缩小文件内容。").foregroundColor(.red) }
        if let failure { Text(failure).foregroundColor(.red).accessibilityIdentifier("file-editor-error") }
        if conflict {
          HStack {
            Button("重新读取") { confirmation = .reload }.disabled(busy || !current)
            Spacer()
            Button("覆盖磁盘文件", role: .destructive) { confirmation = .overwrite }
              .disabled(!canSave)
          }
        }
        if saved && !dirty { Text("已保存").foregroundColor(.secondary).accessibilityIdentifier("file-editor-saved") }
        FileEditorText(text: $draft, editable: !busy)
          .clarityMask()
      }
      .padding(.horizontal).padding(.top, 8)
      .navigationTitle("编辑文件")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(dirty ? "取消" : "关闭") {
            if dirty { confirmation = .discard } else { dismiss() }
          }.disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(busy ? "处理中…" : "保存") { save() }
            .disabled(!canSave).accessibilityIdentifier("file-editor-save")
        }
        ToolbarItem(placement: .bottomBar) {
          HStack {
            Button("复制草稿") { UIPasteboard.general.string = draft }
            Spacer()
            Button("重新读取") {
              if dirty { confirmation = .reload } else { reload() }
            }.disabled(busy || !current)
          }
        }
      }
      .alert(item: $confirmation) { action in
        switch action {
        case .discard:
          return Alert(title: Text("放弃未保存的修改？"),
            primaryButton: .destructive(Text("放弃修改")) { dismiss() },
            secondaryButton: .cancel(Text("继续编辑")))
        case .reload:
          return Alert(title: Text("重新读取磁盘文件？"), message: Text("这会替换当前草稿，未保存的修改将丢失。"),
            primaryButton: .destructive(Text("重新读取")) { reload() },
            secondaryButton: .cancel())
        case .overwrite:
          return Alert(title: Text("覆盖磁盘上的修改？"), message: Text("将用当前草稿覆盖文件，其他程序的修改会被替换。"),
            primaryButton: .destructive(Text("覆盖文件")) { save(overwrite: true) },
            secondaryButton: .cancel())
        }
      }
    }
    .navigationViewStyle(.stack)
    .interactiveDismissDisabled(dirty || busy)
  }

  private func save(overwrite: Bool = false) {
    guard canSave else { return }
    busy = true
    failure = nil
    conflict = false
    saved = false
    let content = draft
    Task { @MainActor in
      defer { busy = false }
      guard current else { failure = "连接已变化，未发送保存请求。草稿已保留。"; return }
      do {
        let value = try await target.api.savePreviewFile(
          projectID: projectID, file: baseline, content: content, overwrite: overwrite)
        guard current else {
          failure = "连接已变化，保存结果未确认。草稿已保留，请在原电脑核对文件。"
          return
        }
        baseline = value
        draft = value.content
        conflict = false
        saved = true
        onSaved(value)
      } catch {
        if case APIError.http(409) = error {
          conflict = true
          failure = "文件或项目上下文已变化，未保存当前草稿。请重新读取核对，或明确选择覆盖文件。"
        } else if case APIError.http(413) = error {
          failure = "文件超过 1 MiB，无法保存。草稿已保留。"
        } else if case APIError.http(415) = error {
          failure = "磁盘文件已变为二进制文件，无法保存。草稿已保留。"
        } else if isRequestCancellation(error) || isInputResultUncertain(error) {
          failure = "保存结果未确认，草稿已保留。请先核对磁盘文件；不会自动重试。"
        } else {
          failure = displayError(error) + "。草稿已保留。"
        }
      }
    }
  }

  private func reload() {
    guard !busy, current else { return }
    busy = true
    failure = nil
    Task { @MainActor in
      defer { busy = false }
      guard current else { failure = "连接已变化，未替换当前草稿。"; return }
      do {
        let value = try await target.api.file(projectID: projectID, path: baseline.path, force: true)
        guard current else { failure = "连接已变化，未替换当前草稿。"; return }
        baseline = value
        draft = value.content
        conflict = false
        saved = false
        onSaved(value)
      } catch { failure = "重新读取失败，草稿已保留。" + previewError(error) }
    }
  }
}

private struct FileEditorText: UIViewRepresentable {
  @Binding var text: String
  let editable: Bool

  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.delegate = context.coordinator
    view.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
    view.textColor = .label
    view.backgroundColor = .systemBackground
    view.autocapitalizationType = .none
    view.autocorrectionType = .no
    view.spellCheckingType = .no
    view.smartQuotesType = .no
    view.smartDashesType = .no
    view.smartInsertDeleteType = .no
    view.alwaysBounceVertical = true
    view.keyboardDismissMode = .interactive
    view.accessibilityLabel = "文件内容"
    view.accessibilityIdentifier = "file-editor-content"
    return view
  }
  func updateUIView(_ view: UITextView, context: Context) {
    context.coordinator.parent = self
    view.isEditable = editable
    if view.text != text { view.text = text }
  }
  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: FileEditorText
    init(_ parent: FileEditorText) { self.parent = parent }
    func textViewDidChange(_ textView: UITextView) { parent.text = textView.text }
  }
}
