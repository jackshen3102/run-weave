import SwiftUI

struct ChangesView: View {
  @ObservedObject var session: AppSession
  let projectID: String
  let active: Bool
  @ObservedObject var model: ProjectChangesModel
  @State private var filter = "all"
  @State private var selected: SelectedFile?
  @State private var showingPreview = false
  @State private var previewID = UUID()
  @State private var viewed = Set<String>()
  @State private var mutation: PreviewMutation?

  private var branchLabel: String {
    if let baseRef = model.branchChanges?.baseRef ?? model.branchCommits?.baseRef {
      return "相对 \(baseRef)"
    }
    return "相对主分支"
  }

  var body: some View {
    VStack(spacing: 6) {
      Picker(
        "变更模式",
        selection: Binding(
          get: { model.scope },
          set: { model.selectScope($0) }
        )
      ) {
        Text("未提交").tag("working")
        Text(branchLabel).tag("branch")
        Text("本分支提交").tag("commits")
      }
      .pickerStyle(.segmented)
      .padding(.horizontal)
      .accessibilityIdentifier("changes-scope-picker")

      if model.scope == "working" {
        Picker("未提交分组", selection: $filter) {
          Text("All").tag("all")
          Text("Staged").tag("staged")
          Text("Working").tag("working")
        }
        .pickerStyle(.segmented)
        .padding(.horizontal)

        if model.loading && model.changes == nil { ProgressView() }
        if let failure = model.failure {
          Text(model.changes == nil ? failure : "更新失败，显示上次结果：\(failure)")
            .foregroundColor(.red)
            .font(.caption)
            .padding(.horizontal)
        }
      } else if model.scope == "branch" {
        if model.branchLoading && model.branchChanges == nil { ProgressView() }
        if let failure = model.branchFailure {
          Text(model.branchChanges == nil ? failure : "更新失败，显示上次结果：\(failure)")
            .foregroundColor(.red)
            .font(.caption)
            .padding(.horizontal)
        }
      } else if model.scope == "commits" {
        if model.commitsLoading && model.branchCommits == nil { ProgressView() }
        if let failure = model.commitsFailure {
          Text(model.branchCommits == nil ? failure : "更新失败，显示上次结果：\(failure)")
            .foregroundColor(.red)
            .font(.caption)
            .padding(.horizontal)
        }
      }

      List {
        if model.scope == "working" {
          ForEach(["staged", "working"], id: \.self) { kind in
            if filter == "all" || filter == kind {
              let items = kind == "staged" ? model.changes?.staged ?? [] : model.changes?.working ?? []
              if !items.isEmpty {
                Section(header: Text(kind == "staged" ? "Staged" : "Working")) {
                  ForEach(items) { item in
                    let file = SelectedFile(path: item.path, changeKind: kind, changeStatus: item.status)
                    Button {
                      open(file)
                    } label: {
                      HStack {
                        Text(item.path).foregroundColor(.primary)
                        Spacer()
                        Text(item.status).font(.caption)
                        if viewed.contains(file.id) { Image(systemName: "checkmark") }
                      }
                    }
                    .contextMenu {
                      Button(kind == "staged" ? "Reset · 取消暂存" : "Reset · 丢弃修改", role: .destructive) {
                        mutation = .reset(path: item.path, kind: kind, status: item.status)
                      }.disabled(model.mutating)
                      if item.status != "deleted" {
                        Button("删除文件", role: .destructive) { mutation = .delete(path: item.path) }
                          .disabled(model.mutating)
                      }
                    }
                  }
                }
              }
            }
          }
          if model.count == 0, model.failure == nil {
            VStack(alignment: .leading, spacing: 6) {
              Text("当前工作区暂无未提交变更")
              Text("若 Agent 已提交修改，可切换到上方「\(branchLabel)」或「本分支提交」只读审阅本分支改动。")
                .font(.caption)
                .foregroundColor(.secondary)
            }
            .padding(.vertical, 4)
          }
        } else if model.scope == "branch" {
          if let unavailable = model.branchChanges?.unavailableDescription {
            Section {
              Text(unavailable)
                .foregroundColor(.orange)
                .accessibilityIdentifier("changes-branch-unavailable")
            }
          } else if let branchChanges = model.branchChanges {
            Section(
              header: Text(
                "相对 \(branchChanges.baseRef ?? "主分支")"
                  + (branchChanges.mergeBaseOid.map { " · @\($0.prefix(7))" } ?? "")
                  + " · 只读"
              )
            ) {
              if branchChanges.files.isEmpty {
                Text("相对 \(branchChanges.baseRef ?? "主分支") 暂无变更")
                  .foregroundColor(.secondary)
              } else {
                ForEach(branchChanges.files) { item in
                  let file = SelectedFile(
                    path: item.path,
                    changeKind: "branch",
                    changeStatus: item.status,
                    baseOid: branchChanges.mergeBaseOid,
                    readonly: true
                  )
                  Button {
                    open(file)
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
        } else if model.scope == "commits" {
          if let unavailable = model.branchCommits?.unavailableDescription {
            Section {
              Text(unavailable)
                .foregroundColor(.orange)
                .accessibilityIdentifier("changes-commits-unavailable")
            }
          } else if let branchCommits = model.branchCommits {
            Section(
              header: Text(
                "本分支提交 (\(branchCommits.commits.count)\(branchCommits.truncated ? "+" : ""))"
                  + (branchCommits.truncated ? " · 仅展示最近 50 个提交" : "")
              )
            ) {
              if branchCommits.commits.isEmpty {
                Text("相对 \(branchCommits.baseRef ?? "主分支") 暂无本分支独占提交")
                  .foregroundColor(.secondary)
              } else {
                ForEach(branchCommits.commits) { commit in
                  let isSelected = commit.oid == branchCommits.selectedCommitOid
                  Button {
                    model.selectCommit(commit.oid)
                  } label: {
                    VStack(alignment: .leading, spacing: 3) {
                      HStack {
                        Text(commit.shortOid)
                          .font(.system(.caption, design: .monospaced))
                          .foregroundColor(.accentColor)
                        Text(commit.subject)
                          .font(.subheadline.weight(isSelected ? .semibold : .regular))
                          .foregroundColor(.primary)
                          .lineLimit(1)
                        Spacer()
                        if isSelected {
                          Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.accentColor)
                        }
                      }
                      HStack {
                        Text(commit.authorName)
                        Spacer()
                        Text(String(commit.committedAt.prefix(10)))
                      }
                      .font(.caption2)
                      .foregroundColor(.secondary)
                    }
                  }
                  .accessibilityIdentifier("branch-commit-\(commit.shortOid)")
                }
              }
            }
            if let selectedCommitOid = branchCommits.selectedCommitOid {
              Section(header: Text("提交 \(selectedCommitOid.prefix(7)) 变更文件 · 只读")) {
                if branchCommits.files.isEmpty {
                  Text("此提交在当前项目目录下无文件变更")
                    .foregroundColor(.secondary)
                } else {
                  ForEach(branchCommits.files) { item in
                    let file = SelectedFile(
                      path: item.path,
                      changeKind: "commit",
                      changeStatus: item.status,
                      commitOid: selectedCommitOid,
                      readonly: true
                    )
                    Button {
                      open(file)
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
          }
        }
      }
      .refreshable { await model.refreshActiveScope(force: true) }
    }
    .modifier(PreviewMutationConfirmation(model: model, target: $mutation))
    .onChange(of: model.mutationRevision) { _ in viewed.removeAll() }
    .task(id: "\(active):\(model.scope)") {
      if active {
        await model.refreshActiveScope()
      }
    }
    .background {
      NavigationLink(isActive: $showingPreview) {
        if let selected {
          FilePreview(
            session: session, projectID: projectID, file: selected, model: model,
            didLoad: { viewed.insert(selected.id) }
          ).id(previewID)
        }
      } label: {
        EmptyView()
      }
      .hidden()
    }
  }
  private func open(_ file: SelectedFile) {
    selected = file
    previewID = UUID()
    showingPreview = true
  }
}
