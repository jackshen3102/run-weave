import SwiftUI

struct ChangesView: View {
  @ObservedObject var session: AppSession
  let projectID: String
  let active: Bool
  @Binding var requested: SelectedFile?
  @ObservedObject var model: ProjectChangesModel
  @State private var filter = "all"
  @State private var selected: SelectedFile?
  @State private var viewed = Set<String>()

  var body: some View {
    VStack {
      Picker("变更范围", selection: $filter) {
        Text("All").tag("all")
        Text("Staged").tag("staged")
        Text("Working").tag("working")
      }.pickerStyle(.segmented).padding(.horizontal)
      if model.loading && model.changes == nil { ProgressView() }
      if let failure = model.failure {
        Text(model.changes == nil ? failure : "更新失败，显示上次结果：\(failure)")
          .foregroundColor(.red)
      }
      List {
        ForEach(["staged", "working"], id: \.self) { kind in
          if filter == "all" || filter == kind {
            Section(header: Text(kind == "staged" ? "Staged" : "Working")) {
              ForEach(kind == "staged" ? model.changes?.staged ?? [] : model.changes?.working ?? []) { item in
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
        if model.count == 0, model.failure == nil { Text("暂无变更") }
      }.refreshable { await model.refresh(force: true) }
    }
    .task(id: active) {
      if active {
        await model.refresh()
        guard !Task.isCancelled else { return }
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
}
