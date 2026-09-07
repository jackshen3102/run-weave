import SwiftUI
import UIKit

struct FilePreview: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var session: AppSession
  let projectID: String
  let file: SelectedFile
  var showChange: (() -> Void)?
  var didLoad: (() -> Void)?
  @State private var payload: PreviewFile?
  @State private var diff: PreviewDiff?
  @State private var lines: [DiffLine] = []
  @State private var image: UIImage?
  @State private var failure: String?
  @State private var loading = true
  @State private var mode = "preview"
  @State private var copied = false
  @State private var fullImage = false

  init(
    session: AppSession, projectID: String, file: SelectedFile, showChange: (() -> Void)? = nil,
    didLoad: (() -> Void)? = nil
  ) {
    self.session = session
    self.projectID = projectID
    self.file = file
    self.showChange = showChange
    self.didLoad = didLoad
    _mode = State(initialValue: file.changeKind == nil ? "preview" : "source")
  }

  private var content: String { diff?.newContent ?? payload?.content ?? "" }
  private var suffix: String { (file.path as NSString).pathExtension.lowercased() }
  var body: some View {
    NavigationView {
      VStack(spacing: 4) {
        Text(file.path).font(.caption).lineLimit(2).padding(.horizontal)
        if file.changeKind != nil || ["md", "markdown", "svg"].contains(suffix) {
          Picker("查看方式", selection: $mode) {
            Text(file.changeKind == nil ? "Source" : "Diff").tag("source")
            Text("Preview").tag("preview")
          }.pickerStyle(.segmented).padding(.horizontal)
        }
        if loading { ProgressView() }
        if let failure { Text(failure).foregroundColor(.red) }
        if !loading, failure == nil {
          if mode == "source", file.changeKind != nil {
            DiffView(lines: lines)
          } else if let image {
            ImagePreview(image: image).onTapGesture { fullImage = true }
            Button("全屏查看") { fullImage = true }
          } else if mode == "preview", suffix == "svg" {
            SVGPreview(content: content)
          } else if mode == "preview", ["md", "markdown"].contains(suffix) {
            MarkdownPreview(content: content)
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
      .navigationTitle((file.path as NSString).lastPathComponent).navigationBarTitleDisplayMode(
        .inline
      )
      .toolbar {
        ToolbarItem(placement: .navigationBarLeading) { Button("关闭") { dismiss() } }
        ToolbarItemGroup(placement: .navigationBarTrailing) {
          Button(copied ? "已复制" : "复制路径") {
            UIPasteboard.general.string = file.path
            copied = true
          }
          if let showChange { Button("查看变更", action: showChange) }
        }
      }
      .task(id: mode) { await load() }
      .fullScreenCover(isPresented: $fullImage) {
        VStack {
          Button("关闭图片") { fullImage = false }.padding()
          if let image { ImagePreview(image: image) }
        }
      }
    }.navigationViewStyle(.stack)
  }
  private func load() async {
    loading = true
    failure = nil
    if let api = session.api {
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
      if mode == "preview", isPreviewImage(file.path) {
        await loadImage()
      } else if let kind = file.changeKind {
        let value = try await session.withConnection {
          try await $0.diff(projectID: projectID, path: file.path, kind: kind)
        }
        diff = value
        let built = await Task.detached(priority: .userInitiated) {
          DiffBuilder.build(old: value.oldContent, new: value.newContent)
        }.value
        guard !Task.isCancelled else { return }
        lines = built
        didLoad?()
      } else if isPreviewImage(file.path) {
        await loadImage()
      } else {
        payload = try await session.withConnection {
          try await $0.file(projectID: projectID, path: file.path)
        }
      }
    } catch { if !Task.isCancelled { failure = previewError(error) } }
    if !Task.isCancelled { loading = false }
  }
  private func loadImage() async {
    do {
      let data = try await session.withConnection {
        try await $0.asset(projectID: projectID, path: file.path)
      }
      guard let decoded = UIImage(data: data) else { throw APIError.http(415) }
      if !Task.isCancelled { image = decoded }
    } catch { if !Task.isCancelled { failure = previewError(error) } }
  }
}
