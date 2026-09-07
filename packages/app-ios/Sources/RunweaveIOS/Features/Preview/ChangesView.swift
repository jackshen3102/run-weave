import SwiftUI

struct ChangesView: View {
  @ObservedObject var session: AppSession
  let projectID: String
  let active: Bool
  @Binding var requested: SelectedFile?
  @Binding var count: Int
  @State private var changes: PreviewChanges?
  @State private var filter = "all"
  @State private var selected: SelectedFile?
  @State private var viewed = Set<String>()
  @State private var failure: String?
  @State private var loading = false
  @State private var loadID = UUID()

  var body: some View {
    VStack {
      Picker("变更范围", selection: $filter) {
        Text("All").tag("all")
        Text("Staged").tag("staged")
        Text("Working").tag("working")
      }.pickerStyle(.segmented).padding(.horizontal)
      if loading { ProgressView() }
      if let failure { Text(failure).foregroundColor(.red) }
      List {
        ForEach(["staged", "working"], id: \.self) { kind in
          if filter == "all" || filter == kind {
            Section(header: Text(kind == "staged" ? "Staged" : "Working")) {
              ForEach(kind == "staged" ? changes?.staged ?? [] : changes?.working ?? []) { item in
                let file = SelectedFile(path: item.path, changeKind: kind)
                Button {
                  selected = file
                } label: {
                  HStack {
                    Text(item.path).foregroundColor(.primary)
                    Spacer()
                    Text(item.status).font(.caption)
                    if viewed.contains(file.id) { Image(systemName: "checkmark") }
                  }
                }
              }
            }
          }
        }
        if count == 0, !loading, failure == nil { Text("暂无变更") }
      }.refreshable { await load(force: true) }
    }
    .task(id: active) {
      if active {
        await load()
        openRequested()
      }
    }
    .onChange(of: requested) { _ in if active { openRequested() } }
    .sheet(item: $selected) { file in
      FilePreview(
        session: session, projectID: projectID, file: file,
        didLoad: { viewed.insert(file.id) })
    }
  }
  private func openRequested() {
    if let requested {
      selected = requested
      self.requested = nil
    }
  }
  private func load(force: Bool = false) async {
    let request = UUID()
    loadID = request
    loading = true
    failure = nil
    defer { if !Task.isCancelled, loadID == request { loading = false } }
    do {
      if let api = session.api {
        let saved: PreviewChanges? = await api.previewSnapshot(
          projectID: projectID, resource: "git-changes")
        guard !Task.isCancelled, loadID == request else { return }
        if let saved {
          changes = saved
          count = saved.staged.count + saved.working.count
        }
      }
      let value = try await session.withConnection {
        try await $0.changes(projectID: projectID, force: force)
      }
      guard !Task.isCancelled, loadID == request else { return }
      changes = value
      count = value.staged.count + value.working.count
    } catch { if !Task.isCancelled, loadID == request { failure = previewError(error) } }
  }
}
