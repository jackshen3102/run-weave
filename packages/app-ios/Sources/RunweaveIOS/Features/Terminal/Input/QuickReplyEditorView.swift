import SwiftUI
import UIKit

struct QuickReplyEditorView: View {
  @EnvironmentObject private var store: LocalQuickReplyStore
  @Environment(\.dismiss) private var dismiss
  private let id: UUID?
  private let originalTitle: String
  private let originalBody: String
  @State private var title: String
  @State private var text: String
  @State private var failure: String?
  @State private var editingBody = false
  @State private var showingExitConfirmation = false
  @State private var bodyHeight: CGFloat = 64
  @ScaledMetric private var minimumBodyHeight: CGFloat = 64
  @ScaledMetric private var maximumBodyHeight: CGFloat = 260

  init(item: LocalQuickReply? = nil, initialBody: String = "") {
    id = item?.id
    originalTitle = item?.title ?? ""
    originalBody = item?.body ?? ""
    _title = State(initialValue: item?.title ?? "")
    _text = State(initialValue: item?.body ?? initialBody)
  }

  private var hasChanges: Bool { title != originalTitle || text != originalBody }
  private var canSave: Bool {
    store.canEdit && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    Form {
      Section(header: Text("标题")) {
        TextField("可选，留空从正文生成", text: $title)
          .accessibilityIdentifier("quick-reply-title")
      }
      Section(header: Text("正文")) {
        CommandTextView(
          text: $text, isFocused: $editingBody, collapsesWhenUnfocused: false,
          accessibilityLabel: "快捷回复正文", maximumHeight: maximumBodyHeight,
          onHeightChange: { bodyHeight = $0 }
        )
        .frame(height: min(maximumBodyHeight, max(minimumBodyHeight, bodyHeight)))
        .accessibilityIdentifier("quick-reply-body")
      }
      if let failure { Section { Text(failure).foregroundColor(.red) } }
      if let error = store.readError { Section { Text(error).foregroundColor(.red) } }
    }
    .disabled(store.saving)
    .navigationTitle(id == nil ? "新增快捷回复" : "编辑快捷回复")
    .navigationBarTitleDisplayMode(.inline)
    .navigationBarBackButtonHidden(true)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button("返回", action: requestExit).disabled(store.saving)
      }
      ToolbarItem(placement: .confirmationAction) {
        Button(store.saving ? "保存中…" : "保存", action: save)
          .disabled(!canSave)
          .accessibilityIdentifier("quick-reply-save")
      }
    }
    .background {
      QuickReplyDismissGuard(blocked: hasChanges || store.saving, onAttempt: requestExit)
    }
    .interactiveDismissDisabled(hasChanges || store.saving)
    .alert("保存更改？", isPresented: $showingExitConfirmation) {
      Button("保存", action: save).disabled(!canSave)
      Button("放弃更改", role: .destructive) { dismiss() }
      Button("继续编辑", role: .cancel) {}
    }
    .task { await store.loadIfNeeded() }
  }

  private func requestExit() {
    guard !store.saving else { return }
    if hasChanges { showingExitConfirmation = true } else { dismiss() }
  }

  private func save() {
    guard canSave else { return }
    failure = nil
    Task {
      do {
        try await store.save(id: id, title: title, body: text)
        dismiss()
      } catch { failure = error.localizedDescription }
    }
  }
}

/// SwiftUI can disable sheet dismissal, but UIKit also reports an attempted swipe to close.
private struct QuickReplyDismissGuard: UIViewControllerRepresentable {
  var blocked: Bool
  var onAttempt: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIViewController(context: Context) -> Anchor { Anchor() }
  func updateUIViewController(_ view: Anchor, context: Context) {
    context.coordinator.parent = self
    view.attach = { [weak view, weak coordinator = context.coordinator] in
      guard let coordinator else { return }
      var ancestor: UIViewController? = view
      while let parent = ancestor?.parent { ancestor = parent }
      if let presentation = ancestor?.presentationController {
        coordinator.attach(to: presentation)
      }
    }
    DispatchQueue.main.async { [weak view] in view?.attach?() }
  }
  static func dismantleUIViewController(_ view: Anchor, coordinator: Coordinator) {
    view.attach = nil
    if let presentation = coordinator.presentation, presentation.delegate === coordinator {
      presentation.delegate = coordinator.previousDelegate
    }
  }

  final class Anchor: UIViewController {
    var attach: (() -> Void)?
    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      attach?()
    }
  }

  final class Coordinator: NSObject, UIAdaptivePresentationControllerDelegate {
    var parent: QuickReplyDismissGuard
    weak var presentation: UIPresentationController?
    weak var previousDelegate: UIAdaptivePresentationControllerDelegate?
    init(_ parent: QuickReplyDismissGuard) { self.parent = parent }
    func attach(to presentation: UIPresentationController) {
      if presentation.delegate !== self {
        previousDelegate = presentation.delegate
        self.presentation = presentation
        presentation.delegate = self
      }
    }
    func presentationControllerShouldDismiss(_ presentationController: UIPresentationController) -> Bool {
      !parent.blocked
    }
    func presentationControllerDidAttemptToDismiss(_ presentationController: UIPresentationController) {
      parent.onAttempt()
    }
    func presentationControllerWillDismiss(_ presentationController: UIPresentationController) {
      previousDelegate?.presentationControllerWillDismiss?(presentationController)
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
      previousDelegate?.presentationControllerDidDismiss?(presentationController)
    }
  }
}
