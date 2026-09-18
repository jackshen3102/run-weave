import SwiftUI

/// Each screen owns its confirmation; the project model serializes writes across screens.
struct PreviewMutationConfirmation: ViewModifier {
  @ObservedObject var model: ProjectChangesModel
  @Binding var target: PreviewMutation?
  @State private var failure: String?

  func body(content: Content) -> some View {
    content
      .overlay(alignment: .top) {
        if model.mutating {
          ProgressView("正在处理…").padding(12).background(.regularMaterial)
        }
      }
      .confirmationDialog(
        target?.title ?? "文件操作",
        isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }),
        titleVisibility: .visible, presenting: target
      ) { mutation in
        Button(mutation.title, role: .destructive) {
          Task {
            do { try await model.mutate(mutation) }
            catch is CancellationError { }
            catch { failure = previewMutationError(error) }
          }
        }.disabled(model.mutating)
        Button("取消", role: .cancel) { target = nil }
      } message: { mutation in
        Text(mutation.message)
      }
      .alert("操作未完成", isPresented: Binding(
        get: { failure != nil }, set: { if !$0 { failure = nil } }
      )) {
        Button("好", role: .cancel) { failure = nil }
      } message: { Text(failure ?? "") }
  }
}
