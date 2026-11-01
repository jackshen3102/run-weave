import AVFoundation
import CryptoKit
import ImageIO
import UniformTypeIdentifiers

struct ScreenRecordingPackageManifest: Codable {
    struct Asset: Codable { let id: String; let byteLength: Int; let sha256: String; let width: Int; let height: Int }
    struct Frame: Codable { let captureID: String; let assetID: String; let frameIndex: Int }
    let version: Int
    let viewID: String
    let serverEpoch: String
    let deviceID: String
    let expiresAt: Int64
    let assets: [Asset]
    let frames: [Frame]
}

// One temporary download owns its files. In-flight local decodes retain it until
// they actually finish, even if the view is invalidated while awaiting AVFoundation.
final class ScreenRecordingPackage: Decodable {
    let manifest: ScreenRecordingPackageManifest
    private static let downloads: URL = {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("screen-recording-packages", isDirectory: true)
        // Static initialization runs once per process; remove interrupted downloads
        // from the previous run without touching another live package in this run.
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
        return root
    }()
    private let root: URL
    private let frames: [String: ScreenRecordingPackageManifest.Frame]
    private let assets: [String: ScreenRecordingPackageManifest.Asset]
    init(from decoder: Decoder) throws { throw ScreenRecordingReadError("INVALID_PROTOCOL") }
    init(download: URL) throws {
        let file = try FileHandle(forReadingFrom: download)
        defer { try? file.close() }
        let size = try file.seekToEnd()
        guard size <= 129 * 1024 * 1024 else { throw ScreenRecordingReadError("PACKAGE_TOO_LARGE") }
        try file.seek(toOffset: 0)
        guard let prefix = try file.read(upToCount: 4), prefix.count == 4 else { throw ScreenRecordingReadError("INVALID_PROTOCOL") }
        let length = prefix.reduce(0) { ($0 << 8) | Int($1) }
        guard length > 0, length <= 1024 * 1024,
              let json = try file.read(upToCount: length), json.count == length else { throw ScreenRecordingReadError("INVALID_PROTOCOL") }
        manifest = try JSONDecoder().decode(ScreenRecordingPackageManifest.self, from: json)
        guard manifest.version == 1, manifest.expiresAt > screenRecordingNowMs(), manifest.assets.count <= 900, manifest.frames.count <= 900,
              Set(manifest.assets.map(\.id)).count == manifest.assets.count, Set(manifest.frames.map(\.captureID)).count == manifest.frames.count else { throw ScreenRecordingReadError("INVALID_PROTOCOL") }
        var total = 0
        for asset in manifest.assets {
            guard UUID(uuidString: asset.id) != nil, asset.byteLength > 0, asset.byteLength <= 128 * 1024 * 1024,
                  asset.width > 0, asset.height > 0, asset.width <= 16384, asset.height <= 16384,
                  asset.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw ScreenRecordingReadError("INVALID_PROTOCOL") }
            total += asset.byteLength
        }
        guard total <= 128 * 1024 * 1024, UInt64(4 + length + total) == size else { throw ScreenRecordingReadError("INVALID_PROTOCOL") }
        frames = Dictionary(uniqueKeysWithValues: manifest.frames.map { ($0.captureID, $0) })
        assets = Dictionary(uniqueKeysWithValues: manifest.assets.map { ($0.id, $0) })
        let knownAssets = Set(manifest.assets.map(\.id))
        guard manifest.frames.allSatisfy({ knownAssets.contains($0.assetID) && (0..<600).contains($0.frameIndex) }) else { throw ScreenRecordingReadError("INVALID_PROTOCOL") }
        root = Self.downloads.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
        do {
            for asset in manifest.assets {
                let target = root.appendingPathComponent(asset.id + ".mp4")
                guard FileManager.default.createFile(atPath: target.path, contents: nil, attributes: [.posixPermissions: 0o600, .protectionKey: FileProtectionType.complete]) else { throw ScreenRecordingReadError("MEDIA_UNAVAILABLE") }
                let output = try FileHandle(forWritingTo: target)
                defer { try? output.close() }
                var remaining = asset.byteLength, hash = SHA256()
                while remaining > 0 {
                    try Task.checkCancellation()
                    guard let bytes = try file.read(upToCount: min(65536, remaining)), !bytes.isEmpty else { throw ScreenRecordingReadError("INVALID_PROTOCOL") }
                    remaining -= bytes.count; hash.update(data: bytes); try output.write(contentsOf: bytes)
                }
                guard hash.finalize().map({ String(format: "%02x", $0) }).joined() == asset.sha256 else { throw ScreenRecordingReadError("INVALID_PROTOCOL") }
            }
        } catch { try? FileManager.default.removeItem(at: root); throw error }
    }
    deinit { try? FileManager.default.removeItem(at: root) }
    func validate(_ view: ScreenRecordingView) throws {
        guard manifest.viewID == view.viewID, manifest.serverEpoch == view.serverEpoch, manifest.deviceID == view.deviceID, manifest.expiresAt == view.expiresAt,
              Set(manifest.frames.map(\.assetID)) == Set(manifest.assets.map(\.id)),
              Set(manifest.frames.map(\.captureID)) == Set(view.captures.filter { !$0.privacyPlaceholder }.map(\.id)) else { throw ScreenRecordingReadError("INVALID_PROTOCOL") }
    }
    @available(iOS 16.0, *)
    func jpeg(captureID: String, variant: ScreenRecordingVariant) async throws -> Data {
        guard let frame = frames[captureID], let asset = assets[frame.assetID] else { throw ScreenRecordingReadError("NOT_FOUND") }
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: root.appendingPathComponent(asset.id + ".mp4")))
        generator.requestedTimeToleranceBefore = .zero; generator.requestedTimeToleranceAfter = .zero
        if let height = variant.height { generator.maximumSize = CGSize(width: Double(asset.width) * min(1, Double(height) / Double(asset.height)), height: Double(height)) }
        let result = try await generator.image(at: CMTime(value: Int64(frame.frameIndex), timescale: 1))
        defer { withExtendedLifetime(self) {} }
        try Task.checkCancellation()
        guard abs(result.actualTime.seconds - Double(frame.frameIndex)) < 0.001 else { throw ScreenRecordingReadError("MEDIA_UNAVAILABLE") }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { throw ScreenRecordingReadError("MEDIA_UNAVAILABLE") }
        CGImageDestinationAddImage(destination, result.image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw ScreenRecordingReadError("MEDIA_UNAVAILABLE") }
        return data as Data
    }
}
