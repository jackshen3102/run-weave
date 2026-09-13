import SwiftUI

struct QuickReplyLibraryView: View {
  @EnvironmentObject private var store: LocalQuickReplyStore
  var onSelect: ((LocalQuickReply) -> Void)? = nil
  @State private var query = ""
  @State private var editing: LocalQuickReply?
  @State private var showingEditor = false
  @State private var deleting: LocalQuickReply?
  @State private var failure: String?
  @State private var editMode: EditMode = .inactive

  private var searching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  private var visible: [LocalQuickReply] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return store.items.filter {
      needle.isEmpty || $0.title.localizedCaseInsensitiveContains(needle)
        || $0.body.localizedCaseInsensitiveContains(needle)
    }
  }

  var body: some View {
    List {
      Section {
        Text("仅此设备保存，不上传或同步；卸载后不保证恢复。")
          .font(.caption).foregroundColor(.secondary)
      }
      if store.loading { ProgressView("正在读取…") }
      if let error = store.readError {
        Section {
          Text(error).foregroundColor(.red)
          Button("重试读取") { Task { await store.load() } }.disabled(store.loading || store.saving)
        }
      }
      if let failure { Text(failure).foregroundColor(.red) }
      if store.readError == nil && !store.loading {
        if visible.isEmpty {
          Text(searching ? "没有匹配的快捷回复" : "还没有快捷回复，点击新增保存常用段落。")
            .foregroundColor(.secondary)
        }
        ForEach(visible) { item in
          HStack(alignment: .top) {
            Button {
              if let onSelect { onSelect(item) } else { edit(item) }
            } label: {
              VStack(alignment: .leading, spacing: 6) {
                Text(item.title).font(.headline).foregroundColor(.primary)
                Text(item.body).font(.subheadline).foregroundColor(.secondary).lineLimit(3)
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
          .deleteDisabled(!store.canEdit)
          .moveDisabled(searching || !store.canEdit)
        }
        .onDelete { offsets in
          if let index = offsets.first { deleting = visible[index] }
        }
        .onMove { offsets, destination in
          guard !searching else { return }
          Task {
            do { try await store.move(from: offsets, to: destination) } catch {
              failure = error.localizedDescription
            }
          }
        }
        .disabled(!store.canEdit)
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
        }.disabled(searching || !store.canEdit || store.items.isEmpty)
        Button("新增") {
          editing = nil
          showingEditor = true
        }
        .disabled(!store.canEdit)
        .accessibilityIdentifier("quick-reply-add")
      }
    }
    .background {
      NavigationLink(isActive: $showingEditor) {
        QuickReplyEditorView(item: editing)
      } label: {
        EmptyView()
      }.hidden()
    }
    .confirmationDialog(
      "删除快捷回复？",
      isPresented: Binding(
        get: { deleting != nil }, set: { if !$0 { deleting = nil } }
      ), titleVisibility: .visible
    ) {
      if let item = deleting {
        Button("删除", role: .destructive) {
          Task {
            do { try await store.delete(item.id) } catch { failure = error.localizedDescription }
          }
          deleting = nil
        }
      }
      Button("取消", role: .cancel) { deleting = nil }
    }
    .task { await store.loadIfNeeded() }
  }

  private func edit(_ item: LocalQuickReply) {
    editing = item
    showingEditor = true
  }
}
