import ImageIO
import SwiftUI

struct TerminalDraftImage: Identifiable {
  let id = UUID()
  let preview: UIImage
  let mimeType: String
  var data: Data?
  var path: String?
  var failure: String?
}

/// Attachments belong to a connection's terminal drafts, not to the lifetime of a picker or screen.
@MainActor
final class TerminalImageDrafts: ObservableObject {
  @Published private(set) var images: [String: [TerminalDraftImage]] = [:]
  private var uploads: [UUID: Task<Void, Never>] = [:]

  func add(data: Data, mimeType: String, terminalID: String, session: AppSession) throws {
    guard session.canWrite else { throw APIError.offline }
    guard data.count <= 100 * 1024 * 1024 else {
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
    let image = TerminalDraftImage(
      preview: UIImage(cgImage: thumbnail), mimeType: mimeType, data: data)
    images[terminalID, default: []].append(image)
    upload(image.id, terminalID: terminalID, session: session)
  }

  func upload(_ id: UUID, terminalID: String, session: AppSession) {
    guard session.canWrite, uploads[id] == nil,
      let image = images[terminalID]?.first(where: { $0.id == id }), let data = image.data
    else { return }
    update(id, terminalID: terminalID) { $0.failure = nil }
    uploads[id] = Task { [weak self] in
      defer { self?.uploads.removeValue(forKey: id) }
      do {
        let path = try await session.withConnection(reportFailure: false) {
          try await $0.uploadImage(terminalID: terminalID, data: data, mimeType: image.mimeType)
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
    images[terminalID]?.removeAll { ids.contains($0.id) }
    if images[terminalID]?.isEmpty == true { images.removeValue(forKey: terminalID) }
  }

  func clear(terminalID: String) {
    remove(Set((images[terminalID] ?? []).map(\.id)), terminalID: terminalID)
  }

  func clear() {
    for upload in uploads.values { upload.cancel() }
    uploads.removeAll()
    images.removeAll()
  }

  private func update(_ id: UUID, terminalID: String, change: (inout TerminalDraftImage) -> Void) {
    guard let index = images[terminalID]?.firstIndex(where: { $0.id == id }) else { return }
    change(&images[terminalID]![index])
  }
}

struct AttachmentError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}
