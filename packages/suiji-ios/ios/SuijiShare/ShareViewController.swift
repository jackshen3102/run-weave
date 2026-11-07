import UIKit
import SwiftUI
import UniformTypeIdentifiers
import SuijiCaptureCore

final class ShareViewController: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    let model = ShareModel(context: extensionContext)
    let host = UIHostingController(rootView: SharePanel(model: model))
    addChild(host); view.addSubview(host.view); host.view.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor), host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor), host.view.topAnchor.constraint(equalTo: view.topAnchor), host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)])
    host.didMove(toParent: self)
    Task { await model.load() }
  }
}
@MainActor final class ShareModel: ObservableObject {
  @Published var text = ""
  @Published var note = ""
  @Published var date = Date()
  @Published var image: Data?
  @Published var message = "正在读取分享内容…"
  @Published var ready = false
  @Published var busy = false
  @Published var queued: QueuedCapture?
  private let context: NSExtensionContext?
  private var connection: CaptureConnection?
  private var api: CaptureAPI?
  private var sourceURL: String?
  init(context: NSExtensionContext?) { self.context = context }
  func load() async {
    ready = false
    do {
      guard let connection = try SharedCaptureStore.connection(), (connection.browse == true || connection.materials) else { throw CaptureError("请先打开随记，登录支持浏览的服务") }
      self.connection = connection
      // A host-verified identity permits offline queueing. No login or business retry is implicit.
      api = try CaptureAPI(endpoint: URL(string: connection.identity.endpoint)!, environment: connection.identity.environment)
      let inputs = context?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
      let providers = inputs.flatMap { $0.attachments ?? [] }
      let images = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
      guard images.count <= 1 else { throw CaptureError("首版每次只能分享一张图片，请返回选择单张；没有保存任何内容") }
      var texts = inputs.compactMap { $0.attributedContentText?.string }.filter { !$0.isEmpty }
      for provider in providers {
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
          let data = try await imageData(provider)
          image = try await Task.detached(priority: .userInitiated) { try Self.compress(data) }.value
        } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
          let value = try await item(provider, type: UTType.url.identifier)
          guard let url = value as? URL, ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { throw CaptureError("只支持 HTTP(S) 链接") }
          sourceURL = url.absoluteString; texts.append(url.absoluteString)
        } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
          let value = try await item(provider, type: UTType.plainText.identifier)
          guard let string = value as? String else { throw CaptureError("文字读取失败") }; texts.append(string)
        } else { throw CaptureError("不支持该分享格式；请选择单张图片、文字或链接") }
      }
      var unique: [String] = []; for value in texts where !unique.contains(value) { unique.append(value) }; text = unique.joined(separator: "\n\n")
      if sourceURL == nil, let url = URL(string: text), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), !text.contains(where: { $0.isWhitespace }) { sourceURL = url.absoluteString }
      guard image != nil || !text.isEmpty else { throw CaptureError("没有可读取的分享内容") }
      message = ""; ready = true
    } catch { message = error.localizedDescription }
  }
  private func item(_ provider: NSItemProvider, type: String) async throws -> NSSecureCoding {
    try await withCheckedThrowingContinuation { continuation in
      provider.loadItem(forTypeIdentifier: type, options: nil) { value, error in
        if let error { continuation.resume(throwing: error) }
        else if let value { continuation.resume(returning: value) }
        else { continuation.resume(throwing: CaptureError("分享内容读取失败")) }
      }
    }
  }
  private func imageData(_ provider: NSItemProvider) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, error in
        do {
          if let error { throw error }; guard let url else { throw CaptureError("图片读取失败") }
          // Copy before the provider invalidates its temporary URL.
          let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
          guard size <= 40 * 1024 * 1024 else { throw CaptureError("原图过大，请先缩小后分享") }
          continuation.resume(returning: try Data(contentsOf: url))
        } catch { continuation.resume(throwing: error) }
      }
    }
  }
  nonisolated private static func compress(_ data: Data) throws -> Data {
    guard let image = UIImage(data: data) else { throw CaptureError("图片格式无法读取") }
    guard image.size.width * image.scale * image.size.height * image.scale <= 40_000_000 else { throw CaptureError("图片超过 4000 万像素") }
    if data.count <= 5 * 1024 * 1024, data.starts(with: [0xFF, 0xD8]) { return data }
    for quality in [0.9, 0.75, 0.55, 0.35] {
      if let value = image.jpegData(compressionQuality: quality), value.count <= 5 * 1024 * 1024 { return value }
    }
    throw CaptureError("图片压缩后仍超过 5 MiB，请缩小后再分享")
  }
  func save() async {
    guard ready, !busy, let connection, let api else { return }
    busy = true; defer { busy = false }
    do {
      if queued == nil {
        let body = text + (note.isEmpty ? "" : (text.isEmpty ? "" : "\n\n") + "用户备注：\n" + note)
        let material = MaterialInput(inputType: image != nil ? "image" : sourceURL != nil ? "link" : "text", sourceUrl: sourceURL, date: date)
        queued = try await CaptureQueue.enqueue(connection: connection, body: body, material: material, image: image)
      }
      guard let queued else { return }
      try await CaptureQueue.send(queued, connection: connection, api: api)
      context?.completeRequest(returningItems: nil)
    } catch { message = (queued == nil ? "尚未保存：" : "素材已在本机排队，待发送或结果待确认；可在随记中手动重试。\n") + error.localizedDescription }
  }
  func close() { context?.completeRequest(returningItems: nil) }
}
struct SharePanel: View {
  @ObservedObject var model: ShareModel
  var body: some View {
    NavigationStack {
      Form {
        if let data = model.image, let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFit().accessibilityLabel("分享图片") }
        if !model.text.isEmpty { Text(model.text).textSelection(.enabled) }
        TextField("备注（可选）", text: $model.note, axis: .vertical).disabled(model.queued != nil || model.busy)
        DatePicker("归属日期", selection: $model.date, in: ...Date(), displayedComponents: .date)
          .environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!).disabled(model.queued != nil || model.busy)
        if !model.message.isEmpty { Text(model.message).foregroundStyle(.orange) }
        if !model.ready { Button("重新读取") { Task { await model.load() } } }
      }.navigationTitle("随记 · 素材").toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(model.queued == nil ? "取消" : "稍后处理") { model.close() }.disabled(model.busy) }
        ToolbarItem(placement: .confirmationAction) {
          Button(model.busy ? "保存中…" : model.queued != nil ? "重试确认" : MaterialInput.day(model.date) == MaterialInput.day(Date()) ? "记入今日" : "保存到浏览") { Task { await model.save() } }.disabled(!model.ready || model.busy)
        }
      }
    }
  }
}
