import SwiftUI

struct QuickReplyLibraryView: View {
  private struct EditorTarget: Identifiable {
    let id = UUID()
    let item: BackendQuickInput?
  }

  @EnvironmentObject private var model: BackendQuickInputModel
  @ObservedObject var session: AppSession
  @State private var editorTarget: EditorTarget?
  @State private var deleting: BackendQuickInput?
  @State private var failure: String?
  @State private var editMode: EditMode = .inactive

  init(session: AppSession, initiallySorting: Bool = false) {
    self.session = session
    _editMode = State(initialValue: initiallySorting ? .active : .inactive)
  }

  private var visible: [BackendQuickInput] { model.items }
  var body: some View {
    List {
      if model.loading { ProgressView("正在读取…") }
      if let error = model.failure {
        Section {
          Text(error).foregroundColor(.red)
          Button("重试读取") { Task { await session.refresh(); await model.refresh(session) } }
        }
      }
      if let failure { Text(failure).foregroundColor(.red) }
      if model.failure == nil && !model.loading {
        if visible.isEmpty {
          Text("还没有快捷指令，点击新增保存常用命令。")
            .foregroundColor(.secondary)
        }
        ForEach(visible) { item in
          VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
              Button {
                edit(item)
              } label: {
                VStack(alignment: .leading, spacing: 6) {
                  Text(item.title).font(.headline).foregroundColor(.primary)
                  Text(item.data).font(.subheadline).foregroundColor(.secondary).lineLimit(3)
                }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
              }
              .buttonStyle(.plain)
              .accessibilityHint("查看全文并编辑")
              Menu {
                Button("查看全文 / 编辑") { edit(item) }
                Button("删除", role: .destructive) { deleting = item }
              } label: {
                Image(systemName: "ellipsis").frame(width: 44, height: 44)
              }.accessibilityLabel("管理 \(item.title)")
            }
          }
          .deleteDisabled(!model.canEdit(session))
          .moveDisabled(!model.canEdit(session))
        }
        .onDelete { offsets in
          if let index = offsets.first { deleting = visible[index] }
        }
        .onMove { offsets, destination in
          Task {
            do { try await model.move(session, from: offsets, to: destination) }
            catch {
              await model.refresh(session)
              if !(error is CancellationError) { failure = displayError(error) }
            }
          }
        }
        .disabled(!model.canEdit(session))
      }
    }
    .environment(\.editMode, $editMode)
    .navigationTitle("快捷指令")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItemGroup(placement: .navigationBarTrailing) {
        Button(editMode == .active ? "完成" : "排序") {
          editMode = editMode == .active ? .inactive : .active
        }.disabled(!model.canEdit(session) || model.items.isEmpty)
        Button("新增") { editorTarget = EditorTarget(item: nil) }
          .disabled(!model.canEdit(session))
          .accessibilityIdentifier("quick-reply-add")
      }
    }
    .sheet(item: $editorTarget) { target in
      NavigationView { QuickReplyEditorView(session: session, item: target.item) }
        .mobileAnalyticsScreen(.quickReplyEditor)
        .navigationViewStyle(.stack)
    }
    .confirmationDialog("删除快捷指令？", isPresented: Binding(
      get: { deleting != nil }, set: { if !$0 { deleting = nil } }
    ), titleVisibility: .visible) {
      if let item = deleting {
        Button("删除", role: .destructive) {
          Task {
            do { try await model.delete(session, id: item.id) }
            catch { if !(error is CancellationError) { failure = displayError(error) } }
          }
          deleting = nil
        }
      }
      Button("取消", role: .cancel) { deleting = nil }
    }
    .task(id: session.generation) {
      await model.loadIfNeeded(session)
    }
    .mobileAnalyticsScreen(.quickReplies)
  }

  private func edit(_ item: BackendQuickInput) { editorTarget = EditorTarget(item: item) }
}
