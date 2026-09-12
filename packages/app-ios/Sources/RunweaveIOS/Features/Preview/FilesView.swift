import SwiftUI

struct FilesView: View {
  @ObservedObject var session: AppSession
  let projectID: String
  let active: Bool
  @ObservedObject var model: ProjectChangesModel
  @State private var path = ""
  @State private var query = ""
  @State private var directory: PreviewDirectory?
  @State private var search: PreviewSearch?
  @State private var selected: SelectedFile?
  @State private var showingPreview = false
  @State private var previewID = UUID()
  @FocusState private var searchFocused: Bool
  @State private var failure: String?
  @State private var loading = false
  @State private var loadID = UUID()

  private var requestID: String { "\(active):\(path):\(query)" }
  var body: some View {
    VStack(spacing: 4) {
      TextField("搜索文件", text: $query).textFieldStyle(.roundedBorder).padding(.horizontal)
        .autocapitalization(.none).disableAutocorrection(true).focused($searchFocused)
      ScrollView(.horizontal) {
        HStack {
          if loading { ProgressView().controlSize(.small) }
          Button("root") {
            path = ""
            query = ""
          }
          ForEach(Array(path.split(separator: "/").enumerated()), id: \.offset) { part in
            Text("/")
            Button(String(part.element)) {
              path = path.split(separator: "/").prefix(part.offset + 1).joined(separator: "/")
              query = ""
            }
          }
        }.padding(.horizontal)
      }
      if let failure { Text(failure).foregroundColor(.red) }
      List {
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          ForEach(
            (directory?.entries ?? []).sorted { left, right in
              left.kind != right.kind
                ? left.kind == "directory"
                : left.basename.localizedStandardCompare(right.basename) == .orderedAscending
            }
          ) { entry in
            Button {
              if entry.kind == "directory" {
                path = entry.path
              } else {
                open(SelectedFile(path: entry.path))
              }
            } label: {
              HStack {
                Image(systemName: entry.kind == "directory" ? "folder" : "doc")
                Text(entry.basename).foregroundColor(.primary)
                Spacer()
                if let change = change(entry.path) {
                  Text(change.1).font(.caption).foregroundColor(.orange)
                }
              }
            }
          }
          if directory?.entries.isEmpty == true { Text("此目录为空") }
          if directory?.truncated == true { Text("目录结果已截断（最多 400 项），可搜索文件缩小范围").font(.caption) }
        } else {
          ForEach(search?.items ?? []) { item in
            Button {
              open(SelectedFile(path: item.path))
            } label: {
              VStack(alignment: .leading) {
                Text(item.basename)
                Text(item.dirname).font(.caption).foregroundColor(.secondary)
              }
            }
          }
          if search?.items.isEmpty == true { Text("没有匹配文件") }
          if search?.truncated == true { Text("搜索结果已截断（最多 50 项）").font(.caption) }
        }
      }.refreshable { await load(force: true) }
    }
    .task(id: requestID) {
      guard active else { return }
      do { try await Task.sleep(nanoseconds: 200_000_000) } catch { return }
      await load()
    }
    .background {
      NavigationLink(isActive: $showingPreview) {
        if let selected {
          FilePreview(
            session: session, projectID: projectID, file: selected,
            relatedChange: change(selected.path).map {
              SelectedFile(path: selected.path, changeKind: $0.0)
            }
          ).id(previewID)
        }
      } label: {
        EmptyView()
      }
      .hidden()
    }
  }
  private func open(_ file: SelectedFile) {
    searchFocused = false
    // Retain the destination through the native pop animation; refresh on the next open.
    selected = file
    previewID = UUID()
    showingPreview = true
  }
  private func change(_ path: String) -> (String, String)? {
    if let item = model.changes?.working.first(where: { $0.path == path }) {
      return ("working", item.status)
    }
    if let item = model.changes?.staged.first(where: { $0.path == path }) {
      return ("staged", item.status)
    }
    return nil
  }
  private func load(force: Bool = false) async {
    let request = UUID()
    loadID = request
    loading = true
    failure = nil
    defer { if !Task.isCancelled, loadID == request { loading = false } }
    do {
      let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
      if let api = session.api {
        if trimmed.isEmpty {
          let saved: PreviewDirectory? = await api.previewSnapshot(
            projectID: projectID,
            resource: "directory", query: ["path": path, "limit": "400"])
          guard !Task.isCancelled, loadID == request else { return }
          if let saved { directory = saved }
        } else {
          let saved: PreviewSearch? = await api.previewSnapshot(
            projectID: projectID,
            resource: "files/search", query: ["q": trimmed, "limit": "50"])
          guard !Task.isCancelled, loadID == request else { return }
          search = saved
        }
      }
      if trimmed.isEmpty {
        let value = try await session.withConnection {
          try await $0.directory(projectID: projectID, path: path, force: force)
        }
        guard !Task.isCancelled, loadID == request else { return }
        directory = value
      } else {
        let value = try await session.withConnection {
          try await $0.searchFiles(projectID: projectID, query: trimmed, force: force)
        }
        guard !Task.isCancelled, loadID == request else { return }
        search = value
      }
      guard !Task.isCancelled, loadID == request else { return }
      await model.refresh(force: force)
    } catch { if !Task.isCancelled, loadID == request { failure = previewError(error) } }
  }
}
