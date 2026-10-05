import ImageIO
import SwiftUI

enum TerminalAttachmentLimits { static let maxBytes = 100 * 1024 * 1024 }

struct TerminalDraftAttachment: Identifiable {
  let id = UUID()
  let preview: UIImage?
  var fileName: String? = nil
  let mimeType: String
  var data: Data?
  var path: String?
  var failure: String?
}

/// Attachments belong to a connection's terminal drafts, not to the lifetime of a picker or screen.
@MainActor
final class TerminalAttachmentDrafts: ObservableObject {
  var onChange: (() -> Void)?
  @Published private(set) var attachments: [String: [TerminalDraftAttachment]] = [:] { didSet { onChange?() } }
  private var uploads: [UUID: Task<Void, Never>] = [:]

  func add(data: Data, mimeType: String, terminalID: String, session: AppSession) throws {
    guard session.canWrite else { throw APIError.offline }
    guard data.count <= TerminalAttachmentLimits.maxBytes else {
      throw AttachmentError("图片不能超过 100 MB")
    }
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let thumbnail = CGImageSourceCreateThumbnailAtIndex(
        source, 0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: 1600,
        ] as CFDictionary)
    else { throw AttachmentError("无法读取这张图片，请重新选择") }
    let image = TerminalDraftAttachment(
      preview: UIImage(cgImage: thumbnail), mimeType: mimeType, data: data)
    attachments[terminalID, default: []].append(image)
    upload(image.id, terminalID: terminalID, session: session)
  }

  func addFile(data: Data, fileName: String, terminalID: String, session: AppSession) throws {
    guard session.canWrite else { throw APIError.offline }
    guard data.count <= TerminalAttachmentLimits.maxBytes else { throw AttachmentError("文件不能超过 100 MB") }
    let file = TerminalDraftAttachment(preview: nil, fileName: fileName, mimeType: "application/octet-stream", data: data)
    attachments[terminalID, default: []].append(file)
    upload(file.id, terminalID: terminalID, session: session)
  }

  func upload(_ id: UUID, terminalID: String, session: AppSession) {
    guard session.canWrite, uploads[id] == nil,
      let image = attachments[terminalID]?.first(where: { $0.id == id }), let data = image.data
    else { return }
    update(id, terminalID: terminalID) { $0.failure = nil }
    uploads[id] = Task { [weak self] in
      defer { self?.uploads.removeValue(forKey: id) }
      do {
        let path = try await session.withConnection(reportFailure: false) {
          if let fileName = image.fileName {
            return try await $0.uploadFile(terminalID: terminalID, data: data, fileName: fileName)
          }
          return try await $0.uploadImage(terminalID: terminalID, data: data, mimeType: image.mimeType)
        }
        guard !Task.isCancelled else { return }
        self?.update(id, terminalID: terminalID) {
          $0.path = path
          $0.data = nil
        }
      } catch {
        guard !Task.isCancelled else { return }
        self?.update(id, terminalID: terminalID) { $0.failure = displayError(error) }
      }
    }
  }

  func remove(_ ids: Set<UUID>, terminalID: String) {
    for id in ids { uploads.removeValue(forKey: id)?.cancel() }
    attachments[terminalID]?.removeAll { ids.contains($0.id) }
    if attachments[terminalID]?.isEmpty == true { attachments.removeValue(forKey: terminalID) }
  }

  func clear(terminalID: String) {
    remove(Set((attachments[terminalID] ?? []).map(\.id)), terminalID: terminalID)
  }

  func restore(_ value: [String: [TerminalDraftAttachment]]) {
    clear()
    attachments = value.mapValues { images in
      images.map { image in
        var restored = image
        if restored.path == nil { restored.failure = restored.failure ?? "上传已暂停，请重试" }
        return restored
      }
    }
  }

  func clear() {
    for upload in uploads.values { upload.cancel() }
    uploads.removeAll()
    attachments.removeAll()
  }

  private func update(_ id: UUID, terminalID: String, change: (inout TerminalDraftAttachment) -> Void) {
    guard let index = attachments[terminalID]?.firstIndex(where: { $0.id == id }) else { return }
    change(&attachments[terminalID]![index])
  }
}

struct AttachmentError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}
