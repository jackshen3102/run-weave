import Foundation

public struct QueuedCapture: Codable, Identifiable, Sendable {
  public var id: String { material.captureId }
  public let identity: CaptureIdentity
  public let body: String
  public let material: MaterialInput
  public let imageName: String?
  public let uploadKey: String
  public let recordKey: String
  public var attachmentId: String?
  public var payload: Data?
  public var state: String
  public var recordId: String?
}

public enum CaptureQueue {
  private static func directory(_ identity: CaptureIdentity) throws -> URL {
    let url = try SharedCaptureStore.root().appendingPathComponent(identity.key, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }
  private static func folder(_ identity: CaptureIdentity, id: String) throws -> URL {
    guard UUID(uuidString: id) != nil else { throw CaptureError("采集标识无效") }
    return try directory(identity).appendingPathComponent(id, isDirectory: true)
  }
  public static func list(_ identity: CaptureIdentity) throws -> [QueuedCapture] {
    try FileManager.default.contentsOfDirectory(at: directory(identity), includingPropertiesForKeys: nil)
      .filter { UUID(uuidString: $0.lastPathComponent) != nil }.compactMap { url in
        let manifest = url.appendingPathComponent("manifest.json")
        guard FileManager.default.fileExists(atPath: manifest.path) else { return nil }
        let item = try JSONDecoder().decode(QueuedCapture.self, from: Data(contentsOf: manifest))
        guard item.identity == identity else { throw CaptureError("素材身份不匹配") }; return item
      }.sorted { $0.material.capturedAt > $1.material.capturedAt }
  }
  public static func image(_ item: QueuedCapture) throws -> Data? {
    guard let name = item.imageName, name == "image.jpg" || name == "image.png" else { return nil }
    return try Data(contentsOf: folder(item.identity, id: item.id).appendingPathComponent(name))
  }
  public static func enqueue(connection: CaptureConnection, body: String, material: MaterialInput, image: Data?, png: Bool = false) async throws -> QueuedCapture {
    let lock = try await CaptureFileLock.acquire("connection")
    defer { withExtendedLifetime(lock) {} }
    try SharedCaptureStore.assertCurrent(connection)
    guard connection.materials, body.unicodeScalars.count <= 20000, !body.contains("\0"),
      !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || image != nil else { throw CaptureError("请输入素材；正文最多 20,000 个字符") }
    guard material.materialDate <= MaterialInput.day(Date()) else { throw CaptureError("不能选择未来日期") }
    if let image, image.isEmpty || image.count > 5 * 1024 * 1024 { throw CaptureError("图片为空或超过 5 MiB") }
    let path = try folder(connection.identity, id: material.captureId)
    guard !FileManager.default.fileExists(atPath: path.path) else { throw CaptureError("素材已入队，请确认原请求") }
    try FileManager.default.createDirectory(at: path, withIntermediateDirectories: false)
    let name = image == nil ? nil : png ? "image.png" : "image.jpg"
    if let image, let name { try image.write(to: path.appendingPathComponent(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
    let item = QueuedCapture(identity: connection.identity, body: body, material: material, imageName: name,
      uploadKey: UUID().uuidString, recordKey: UUID().uuidString, state: "queued")
    try SharedCaptureStore.write(item, to: path.appendingPathComponent("manifest.json")); return item
  }
  /// Only a user action calls this method. Sending/uncertain use the same frozen keys and bytes.
  public static func send(_ original: QueuedCapture, connection: CaptureConnection, api: CaptureAPI) async throws {
    guard original.identity == connection.identity else { throw CaptureError("请登录素材所属账号") }
    let lock = try await CaptureFileLock.acquire(connection.identity.key + ":" + original.id)
    defer { withExtendedLifetime(lock) {} }
    let path = try folder(original.identity, id: original.id), manifest = path.appendingPathComponent("manifest.json")
    var item = try JSONDecoder().decode(QueuedCapture.self, from: Data(contentsOf: manifest))
    guard item.identity == connection.identity, item.id == original.id else { throw CaptureError("素材身份不匹配") }
    if item.state == "confirmed" { try? FileManager.default.removeItem(at: path); return }
    try SharedCaptureStore.assertCurrent(connection)
    let info = try await api.info()
    guard info.features?.materials == true, info.ownerId == item.identity.ownerId, info.serverId == item.identity.serverId else { throw CaptureError("服务不支持素材或身份已改变") }
    try SharedCaptureStore.assertCurrent(connection)
    item.state = "sending"; try SharedCaptureStore.write(item, to: manifest)
    do {
      if item.attachmentId == nil, let bytes = try image(item), let name = item.imageName {
        let boundary = UUID().uuidString
        let mime = name.hasSuffix("png") ? "image/png" : "image/jpeg"
        var data = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8)
        data.append(bytes); data.append(Data("\r\n--\(boundary)--\r\n".utf8))
        struct Upload: Decodable { struct Attachment: Decodable { let id: String }; let attachment: Attachment }
        let uploaded = try await api.request(Upload.self, path: "api/suiji/v1/uploads", method: "POST", data: data, key: item.uploadKey, contentType: "multipart/form-data; boundary=\(boundary)")
        item.attachmentId = uploaded.attachment.id; try SharedCaptureStore.write(item, to: manifest)
      }
      if item.payload == nil {
        struct Payload: Encodable { let kind = "note"; let body: String; let material: MaterialInput; let attachmentIds: [String] }
        item.payload = try JSONEncoder().encode(Payload(body: item.body, material: item.material, attachmentIds: item.attachmentId.map { [$0] } ?? []))
        try SharedCaptureStore.write(item, to: manifest)
      }
      try SharedCaptureStore.assertCurrent(connection)
      struct Response: Decodable {
        struct Record: Decodable {
          struct Attachment: Decodable { let id: String }
          let id: String; let kind: String; let body: String; let material: MaterialMetadata?; let attachments: [Attachment]
        }
        let record: Record
      }
      let response = try await api.request(Response.self, path: "api/suiji/v1/records", method: "POST", data: item.payload, key: item.recordKey)
      guard response.record.material?.captureId.lowercased() == item.id.lowercased(), response.record.kind == "note",
        response.record.body == item.body, response.record.material?.materialDate == item.material.materialDate,
        response.record.material?.inputType == item.material.inputType, response.record.material?.sourceUrl == item.material.sourceUrl,
        response.record.attachments.map(\.id) == (item.attachmentId.map { [$0] } ?? []) else { throw CaptureError("响应与素材不匹配，请重试确认") }
      item.state = "confirmed"; item.recordId = response.record.id
      try SharedCaptureStore.write(item, to: manifest)
      try? FileManager.default.removeItem(at: path)
    } catch {
      item.state = (error as? APIError).map { $0.uncertain ? "uncertain" : "queued" } ?? "uncertain"
      try? SharedCaptureStore.write(item, to: manifest)
      throw error
    }
  }
}
