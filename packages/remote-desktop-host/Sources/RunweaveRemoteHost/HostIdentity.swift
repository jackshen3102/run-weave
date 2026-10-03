import Foundation
import Security
import RunweaveRemoteDesktopProtocol

struct HostIdentity {
    struct Stored: Codable { var hostID: UUID; var archive: Data; var password: String }
    let hostID: UUID
    let identity: SecIdentity
    let fingerprint: String
    private static let store = RemoteKeychainStore(service: HostRuntime.identityService)

    static func loadOrCreate() throws -> Self {
        let record: Stored
        if let existing = try store.get(account: "tls-identity") {
            record = try JSONDecoder().decode(Stored.self, from: existing)
        } else {
            record = try generate()
            try store.set(JSONEncoder().encode(record), account: "tls-identity")
        }
        var items: CFArray?
        let status = SecPKCS12Import(record.archive as CFData, [kSecImportExportPassphrase as String: record.password] as CFDictionary, &items)
        guard status == errSecSuccess, let first = (items as? [[String: Any]])?.first,
              let value = first[kSecImportItemIdentity as String] else { throw HostError.identityFailure }
        let identity = value as! SecIdentity
        var certificate: SecCertificate?
        guard SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess, let certificate,
              RemoteTLS.certificateIsCurrent(certificate) else { throw HostError.expiredIdentity }
        return Self(hostID: record.hostID, identity: identity, fingerprint: RemoteTLS.fingerprint(certificate))
    }

    /// The OS-supplied openssl is used only to create a private identity once. No secrets are
    /// embedded in the app, printed, or passed as process arguments. Temporary files are 0600/0700.
    private static func generate() throws -> Stored {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("runweave-remote-identity-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: folder) }
        let hostID = UUID()
        var random = Data(count: 32)
        guard random.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }) == errSecSuccess else { throw HostError.identityFailure }
        let password = random.base64EncodedString()
        let passwordFile = folder.appendingPathComponent("password")
        try Data(password.utf8).write(to: passwordFile, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: passwordFile.path)
        func run(_ arguments: [String]) throws {
            let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
            process.arguments = arguments; process.currentDirectoryURL = folder
            process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
            try process.run(); process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw HostError.identityFailure }
        }
        try run(["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "3650", "-keyout", "key.pem", "-out", "cert.pem", "-subj", "/CN=Runweave-Remote-\(hostID.uuidString)"])
        for name in ["key.pem", "cert.pem"] {
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: folder.appendingPathComponent(name).path)
        }
        try run(["pkcs12", "-export", "-inkey", "key.pem", "-in", "cert.pem", "-out", "identity.p12", "-passout", "file:\(passwordFile.path)"])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: folder.appendingPathComponent("identity.p12").path)
        return Stored(hostID: hostID, archive: try Data(contentsOf: folder.appendingPathComponent("identity.p12")), password: password)
    }
}

enum HostError: Error, LocalizedError {
    case identityFailure, expiredIdentity, screenPermission, noDisplay, encoderUnavailable, consoleInactive, displayReconfigured, rejected(String)
    var wireCode: RemoteControlMessage.ErrorCode {
        switch self {
        case .screenPermission: return .permissionScreenRecording
        case .noDisplay: return .displayUnavailable
        case .encoderUnavailable: return .encoderUnavailable
        case .consoleInactive: return .hostStopped
        case .displayReconfigured: return .sessionExpired
        default: return .authentication
        }
    }
    var errorDescription: String? {
        switch self {
        case .identityFailure: return "无法创建或读取本机 TLS 身份。检查 Keychain 和 /usr/bin/openssl。"
        case .expiredIdentity: return "本机 TLS 证书已过期。停止服务后重新部署身份并重新配对。"
        case .screenPermission: return "Mac 尚未授予屏幕录制权限；请在本机系统设置中授权。"
        case .noDisplay: return "所选显示器已不可用。请在 Mac 本机重新选择。"
        case .encoderUnavailable: return "VideoToolbox 硬件 H.264 编码不可用。"
        case .consoleInactive: return "Mac 图形会话已锁定或切换用户，请在本机恢复后重新打开桌面。"
        case .displayReconfigured: return "所选显示器正在更新，请等待桌面会话重新建立。"
        case .rejected(let reason): return reason
        }
    }
}

struct PairedDevice: Codable, Identifiable {
    var id: UUID
    var name: String
    var token: Data
    var controlAllowed: Bool
    var pairedAt: Date
}

enum HostPeerStore {
    private static let store = RemoteKeychainStore(service: HostRuntime.pairedDevicesService)
    static func load() throws -> [PairedDevice] {
        guard let data = try store.get(account: "devices") else { return [] }
        return try JSONDecoder().decode([PairedDevice].self, from: data)
    }
    static func save(_ devices: [PairedDevice]) throws { try store.set(JSONEncoder().encode(devices), account: "devices") }
}
