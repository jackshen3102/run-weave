import SwiftUI

struct QuickReplyLibraryView: View {
  private struct EditorTarget: Identifiable {
    let id = UUID()
    let item: BackendQuickInput?
  }

  @EnvironmentObject private var model: BackendQuickInputModel
  @ObservedObject var session: AppSession
  let projectId: String?
  let onSelect: ((BackendQuickInput) -> Void)?
  let onOpenRun: ((ScheduledRun) -> Void)?
  @State private var query = ""
  @State private var editorTarget: EditorTarget?
  @State private var deleting: BackendQuickInput?
  @State private var failure: String?
  @State private var editMode: EditMode = .inactive

  init(session: AppSession, projectId: String? = nil,
    onSelect: ((BackendQuickInput) -> Void)? = nil,
    onOpenRun: ((ScheduledRun) -> Void)? = nil) {
    self.session = session; self.projectId = projectId
    self.onSelect = onSelect; self.onOpenRun = onOpenRun
  }

  private var searching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  private var visible: [BackendQuickInput] { model.visible(query: query.trimmingCharacters(in: .whitespacesAndNewlines)) }
  var body: some View {
    List {
      if model.loading { ProgressView("正在读取…") }
      if let error = model.failure {
        Section {
          Text(error).foregroundColor(.red)
          Button("重试读取") { Task { await session.refresh(); await model.refresh(session) } }
        }
      }
      if projectId != nil, let error = model.runFailure { Text(error).foregroundColor(.red) }
      if let failure { Text(failure).foregroundColor(.red) }
      if model.failure == nil && !model.loading {
        if visible.isEmpty {
          Text(searching ? "没有匹配的快捷回复" : "还没有全局快捷回复，点击新增保存常用段落。")
            .foregroundColor(.secondary)
        }
        ForEach(visible) { item in
          VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
              Button {
                if let onSelect { onSelect(item) } else { edit(item) }
              } label: {
                VStack(alignment: .leading, spacing: 6) {
                  Text(item.title).font(.headline).foregroundColor(.primary)
                  Text(item.data).font(.subheadline).foregroundColor(.secondary).lineLimit(3)
                }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
              }
              .buttonStyle(.plain)
              .accessibilityHint(onSelect == nil ? "查看全文并编辑" : "填入输入框，不会直接发送")
              Menu {
                Button("查看全文 / 编辑") { edit(item) }
                Button("删除", role: .destructive) { deleting = item }
              } label: {
                Image(systemName: "ellipsis").frame(width: 44, height: 44)
              }.accessibilityLabel("管理 \(item.title)")
            }
            if let projectId, let onOpenRun {
              HStack(spacing: 12) {
                if let run = model.run(for: item.id, projectId: projectId) {
                  Text(run.statusLabel).font(.caption).foregroundColor(.secondary)
                  Button("查看运行") { onOpenRun(run) }.font(.caption)
                }
                if model.run(for: item.id, projectId: projectId)?.active != true {
                  Button(model.starting.contains(item.id) ? "提交中…" : "后台运行") {
                    Task {
                      do { _ = try await model.start(session, item: item, projectId: projectId) }
                      catch { if !(error is CancellationError) { failure = displayError(error) } }
                    }
                  }
                  .font(.caption).disabled(model.starting.contains(item.id) || !model.canEdit(session))
                  .accessibilityLabel("后台运行 \(item.title)")
                }
              }.buttonStyle(.borderless)
            }
          }
          .deleteDisabled(!model.canEdit(session))
          .moveDisabled(searching || !model.canEdit(session))
        }
        .onDelete { offsets in
          if let index = offsets.first { deleting = visible[index] }
        }
        .onMove { offsets, destination in
          guard !searching else { return }
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
    .searchable(text: $query, prompt: "搜索标题或正文")
    .onChange(of: query) { _ in editMode = .inactive }
    .navigationTitle("快捷回复")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItemGroup(placement: .navigationBarTrailing) {
        Button(editMode == .active ? "完成" : "排序") {
          editMode = editMode == .active ? .inactive : .active
        }.disabled(searching || !model.canEdit(session) || model.items.isEmpty)
        Button("新增") { editorTarget = EditorTarget(item: nil) }
          .disabled(!model.canEdit(session))
          .accessibilityIdentifier("quick-reply-add")
      }
    }
    .sheet(item: $editorTarget) { target in
      NavigationView { QuickReplyEditorView(session: session, item: target.item) }
        .navigationViewStyle(.stack)
    }
    .confirmationDialog("删除快捷回复？", isPresented: Binding(
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
    .task(id: query) {
      if searching { try? await Task.sleep(nanoseconds: 250_000_000) }
      if !Task.isCancelled { await model.refresh(session, query: query.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }
    .task(id: "\(session.generation):\(projectId ?? "")") {
      guard let projectId else { return }
      while !Task.isCancelled {
        await model.refreshRuns(session, projectId: projectId)
        try? await Task.sleep(nanoseconds: 5_000_000_000)
      }
    }
  }

  private func edit(_ item: BackendQuickInput) { editorTarget = EditorTarget(item: item) }
}
