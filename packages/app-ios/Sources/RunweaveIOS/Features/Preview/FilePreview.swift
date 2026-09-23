import SwiftUI
import UIKit

struct FilePreview: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  let projectID: String
  let file: SelectedFile
  @ObservedObject var model: ProjectChangesModel
  var relatedChange: SelectedFile?
  var didLoad: (() -> Void)?
  var targetLine: Int?
  var targetColumn: Int?
  var onClose: (() -> Void)?
  @State private var payload: PreviewFile?
  @State private var diff: PreviewDiff?
  @State private var lines: [DiffLine] = []
  @State private var image: UIImage?
  @State private var failure: String?
  @State private var loading = true
  @State private var mode = "preview"
  @State private var copied = false
  @State private var fullImage = false
  @State private var showingChange = false
  @State private var loadedMode: String?
  @State private var loadRevision = 0
  @State private var mutation: PreviewMutation?

  init(
    session: AppSession, projectID: String, file: SelectedFile, model: ProjectChangesModel,
    relatedChange: SelectedFile? = nil,
    didLoad: (() -> Void)? = nil, targetLine: Int? = nil, targetColumn: Int? = nil, onClose: (() -> Void)? = nil
  ) {
    self.session = session
    self.projectID = projectID
    self.file = file
    self.model = model
    self.relatedChange = relatedChange
    self.didLoad = didLoad
    self.targetLine = targetLine
    self.targetColumn = targetColumn
    self.onClose = onClose
    _mode = State(initialValue: (file.changeKind == nil && targetLine == nil) || isPreviewImage(file.path) ? "preview" : "source")
  }

  private var content: String { diff?.previewContent ?? payload?.content ?? "" }
  private var suffix: String { (file.path as NSString).pathExtension.lowercased() }
  private var isImage: Bool {
    diff?.contentKind == "image" || (diff?.contentKind == nil && isPreviewImage(file.path))
  }
  private var canSwitch: Bool {
    ["md", "markdown", "svg"].contains(suffix) && !isImage && diff?.problem == nil
  }
  private var versionLabel: String? {
    guard file.changeKind != nil, let diff else { return nil }
    if diff.newSide == nil, isImage { return "工作区版本（服务器尚不支持 Git 图片版本）" }
    return diff.versionLabel
  }
  var body: some View {
    VStack(spacing: 4) {
      Text(file.path).font(.caption).foregroundColor(.secondary).lineLimit(2)
        .padding(.horizontal).padding(.top, 8)
      if let versionLabel { Text(versionLabel).font(.caption).foregroundColor(.secondary) }
      if let oldPath = diff?.oldPath, oldPath != file.path {
        Text("重命名自：\(oldPath)").font(.caption).foregroundColor(.secondary)
      }
      if canSwitch {
        Picker("查看方式", selection: $mode) {
          Text(file.changeKind == nil ? "Source" : "Diff").tag("source")
          Text("Preview").tag("preview")
        }.pickerStyle(.segmented).padding(.horizontal)
      }
      if loading { ProgressView() }
      if let failure {
        Text(failure).foregroundColor(.red)
        Button("重新加载") { loadedMode = nil; loadRevision += 1 }
      }
      if !loading, failure == nil {
        if let problem = diff?.problem {
          Text(problem).foregroundColor(.secondary).padding()
          if let size = diff?.previewSide?.sizeBytes {
            Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
              .font(.caption).foregroundColor(.secondary)
          }
          Button("重新加载") { loadedMode = nil; loadRevision += 1 }
        } else if !isImage, mode == "source", file.changeKind != nil {
          if diff?.diffState == "unchanged" || lines.isEmpty {
            Text(content.isEmpty ? "文件为空" : "无文本内容变化").foregroundColor(.secondary).padding()
          } else { DiffView(lines: lines) }
        } else if let image {
          ImagePreview(image: image).onTapGesture { fullImage = true }
          Button("全屏查看") { fullImage = true }
        } else if content.isEmpty {
          Text("文件为空").foregroundColor(.secondary).padding()
        } else if mode == "preview", suffix == "svg" {
          SVGPreview(content: content)
        } else if mode == "preview", ["md", "markdown"].contains(suffix) {
          MarkdownPreview(content: content)
        } else {
          if let targetLine {
            FileSourceLocation(content: content, line: targetLine, column: targetColumn ?? 1)
          } else {
            GeometryReader { geometry in
              ScrollView([.horizontal, .vertical]) {
                Text(verbatim: content).font(.system(size: 13, design: .monospaced))
                  .textSelection(.enabled).padding()
                  .frame(
                    minWidth: geometry.size.width, minHeight: geometry.size.height,
                    alignment: .topLeading)
              }
            }
          }
        }
      }
    }
    .background(Color(uiColor: .systemBackground).ignoresSafeArea())
    .navigationTitle((file.path as NSString).lastPathComponent)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .navigationBarTrailing) {
        Menu {
          Button(copied ? "已复制" : "复制路径") {
            UIPasteboard.general.string = file.path
            copied = true
          }
          if relatedChange != nil {
            Button("查看变更") { showingChange = true }
          }
          if let kind = file.changeKind {
            Button(kind == "staged" ? "Reset · 取消暂存" : "Reset · 丢弃修改", role: .destructive) {
              mutation = .reset(path: file.path, kind: kind, status: file.changeStatus)
            }.disabled(model.mutating)
          }
          if file.changeStatus != "deleted", payload?.base != "filesystem", payload?.readonly != true, !file.readonly, !loading, failure == nil {
            Button("删除文件", role: .destructive) {
              mutation = .delete(path: file.path, mtimeMs: payload?.mtimeMs)
            }.disabled(model.mutating)
          }
          Button("关闭预览") { if let onClose { onClose() } else { dismiss() } }
        } label: {
          Image(systemName: "ellipsis")
        }
        .accessibilityLabel("预览操作")
      }
    }
    .modifier(PreviewMutationConfirmation(model: model, target: $mutation))
    // Each presented level dismisses through its own native navigation binding.
    // Clearing only the root link does not pop a nested preview on iOS.
    .onChange(of: model.mutationRevision) { _ in dismiss() }
    .background {
      NavigationLink(isActive: $fullImage) {
        if let image {
          ImagePreview(image: image)
            .background(Color(uiColor: .systemBackground).ignoresSafeArea())
            .navigationTitle("图片预览").navigationBarTitleDisplayMode(.inline)
        }
      } label: {
        EmptyView()
      }
      .hidden()
      NavigationLink(isActive: $showingChange) {
        if let relatedChange {
          FilePreview(session: session, projectID: projectID, file: relatedChange, model: model)
        }
      } label: {
        EmptyView()
      }
      .hidden()
    }
    .task(id: "\(mode):\(loadRevision)") {
      // A child navigation pop must not replace the retained content with a spinner.
      guard loadedMode != mode else { return }
      await load(mode: mode)
    }
  }
  private func load(mode: String) async {
    loading = true
    failure = nil
    image = nil
    diff = nil
    lines = []
    if file.changeKind == nil, let api = session.api {
      if isPreviewImage(file.path), mode == "preview" {
        let saved: Data? = await api.previewSnapshot(
          projectID: projectID, resource: "asset",
          query: ["path": file.path], decode: { $0 })
        guard !Task.isCancelled else { return }
        if let saved, let decoded = UIImage(data: saved) {
          image = decoded
          loading = false
        }
      } else if file.changeKind == nil {
        let saved: PreviewFile? = await api.previewSnapshot(
          projectID: projectID, resource: "file",
          query: ["path": file.path])
        guard !Task.isCancelled else { return }
        if let saved {
          payload = saved
          loading = false
        }
      }
    }
    do {
      if let kind = file.changeKind {
        let value = try await session.withConnection {
          try await $0.diff(projectID: projectID, path: file.path, kind: kind, force: true)
        }
        guard !Task.isCancelled else { return }
        diff = value
        if value.problem == nil {
          if isImage {
            if let side = value.previewSide, let version = side.version {
              let data = try await session.withConnection {
                try await $0.changeAsset(projectID: projectID, path: file.path, kind: kind,
                  side: value.status == "deleted" ? "old" : "new", version: version)
              }
              guard !Task.isCancelled else { return }
              guard let decoded = UIImage(data: data) else {
                failure = "图片无法解码，请重新加载或检查文件格式"
                loading = false
                return
              }
              image = decoded
            } else if file.changeStatus == "deleted" {
              failure = "服务器尚不支持已删除图片的版本预览"
              loading = false
              return
            } else {
              await loadImage()
            }
          } else {
            let built = await Task.detached(priority: .userInitiated) {
              DiffBuilder.build(old: value.oldContent, new: value.newContent)
            }.value
            guard !Task.isCancelled else { return }
            lines = built
          }
          guard !Task.isCancelled else { return }
          if failure == nil { didLoad?() }
        }
      } else if isPreviewImage(file.path) {
        await loadImage()
      } else {
        let value = try await session.withConnection {
          try await $0.file(projectID: projectID, path: file.path)
        }
        guard !Task.isCancelled else { return }
        payload = value
      }
    } catch {
      if !Task.isCancelled {
        if file.changeKind != nil, case APIError.http(409) = error {
          failure = "文件或变更版本已变化，请重新加载；若变更已消失，请返回刷新列表。"
        } else { failure = previewError(error) }
      }
    }
    if !Task.isCancelled {
      loading = false
      if failure == nil { loadedMode = mode }
    }
  }
  private func loadImage() async {
    do {
      let data = try await session.withConnection {
        try await $0.asset(projectID: projectID, path: file.path)
      }
      guard !Task.isCancelled else { return }
      guard let decoded = UIImage(data: data) else {
        failure = "图片无法解码，请重新加载或检查文件格式"
        return
      }
      image = decoded
    } catch { if !Task.isCancelled { failure = previewError(error) } }
  }
}

private struct FileSourceLocation: View {
  let content: String
  let line: Int
  let column: Int
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("第 \(line) 行 · 第 \(column) 列").font(.caption).padding(.horizontal)
        .accessibilityIdentifier("preview-file-location")
      FileSourceText(content: content, line: line, column: column)
    }
  }
}

private struct FileSourceText: UIViewRepresentable {
  let content: String
  let line: Int
  let column: Int

  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.isEditable = false
    view.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
    view.backgroundColor = .systemBackground
    view.textColor = .label
    view.accessibilityIdentifier = "preview-file-source"
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    guard view.text != content else { return }
    view.text = content
    let lines = content.components(separatedBy: "\n")
    let index = min(max(0, line - 1), lines.count - 1)
    let start = lines.prefix(index).reduce(0) { $0 + $1.utf16.count + 1 }
    let offset = min(max(0, column - 1), lines[index].utf16.count)
    let range = NSRange(location: start + offset, length: offset < lines[index].utf16.count ? 1 : 0)
    let highlighted = NSMutableAttributedString(string: content, attributes: [
      .font: UIFont.monospacedSystemFont(ofSize: 13, weight: .regular), .foregroundColor: UIColor.label])
    if range.length > 0 {
      highlighted.addAttribute(.backgroundColor, value: UIColor.systemYellow.withAlphaComponent(0.35), range: range)
    }
    view.attributedText = highlighted
    view.selectedRange = range
    DispatchQueue.main.async { view.scrollRangeToVisible(range) }
  }
}
