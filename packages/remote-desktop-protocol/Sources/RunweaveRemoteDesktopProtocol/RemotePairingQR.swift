import Foundation

/// Short-lived material read from the Mac's local display, never persisted or logged.
public struct RemotePairingQR: Codable, Sendable {
    public let kind: String
    public let version: Int
    public let hostID: UUID
    public let name: String
    public let host: String
    public let port: UInt16
    public let certificateFingerprint: String
    public let pairingWindowID: UUID
    public let code: String
    public let expiresAt: String

    public init(hostID: UUID, name: String, host: String, port: UInt16,
                certificateFingerprint: String, pairingWindowID: UUID, code: String, expiresAt: Date) {
        kind = "runweave.remote-desktop-pairing"; version = 1
        self.hostID = hostID; self.name = name; self.host = host; self.port = port
        self.certificateFingerprint = RemoteTLS.normalizedFingerprint(certificateFingerprint)
        self.pairingWindowID = pairingWindowID; self.code = code
        self.expiresAt = ISO8601DateFormatter().string(from: expiresAt)
    }

    public var target: RemoteTarget {
        RemoteTarget(id: hostID, name: name, host: host, port: port,
                     certificateFingerprint: certificateFingerprint)
    }

    public func encoded(allowSimulatorLoopback: Bool = false) throws -> String {
        try validate(allowSimulatorLoopback: allowSimulatorLoopback)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(self)
        guard data.count <= 4096, let text = String(data: data, encoding: .utf8) else {
            throw RemotePairingQRError.invalid
        }
        return text
    }

    public static func parse(_ text: String, allowSimulatorLoopback: Bool = false) throws -> Self {
        guard text.utf8.count <= 4096, let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = object["kind"] as? String else { throw RemotePairingQRError.invalid }
        if kind == "runweave.mobile-login" { throw RemotePairingQRError.loginCode }
        guard kind == "runweave.remote-desktop-pairing" else { throw RemotePairingQRError.invalid }
        guard let version = object["version"] as? Int, version == 1 else { throw RemotePairingQRError.version }
        guard let invitation = try? JSONDecoder().decode(Self.self, from: data) else {
            throw RemotePairingQRError.invalid
        }
        try invitation.validate(allowSimulatorLoopback: allowSimulatorLoopback)
        return invitation
    }

    public func validate(allowSimulatorLoopback: Bool = false) throws {
        guard kind == "runweave.remote-desktop-pairing", version == 1,
              !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.utf8.count <= 128,
              port > 0, certificateFingerprint.utf8.count == 64,
              certificateFingerprint.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              code.utf8.count == 6, code.utf8.allSatisfy({ (48...57).contains($0) }),
              expiresAt.utf8.count <= 64, ISO8601DateFormatter().date(from: expiresAt) != nil else {
            throw RemotePairingQRError.invalid
        }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts.allSatisfy({ part in
            guard let value = UInt8(part) else { return false }
            return String(value) == part
        }) else { throw RemotePairingQRError.invalid }
        let octets = parts.compactMap { UInt8($0) }
        #if DEBUG
        if allowSimulatorLoopback, host == "127.0.0.1" { return }
        #endif
        guard octets[0] > 0, octets[0] != 127, octets[0] < 224 else {
            throw RemotePairingQRError.invalid
        }
        // Host's monotonic clock decides expiry; the phone clock is display-only.
    }
}

public enum RemotePairingQRError: LocalizedError {
    case invalid, version, loginCode
    public var errorDescription: String? {
        switch self {
        case .invalid: return "这不是有效的 Mac 桌面配对二维码，请扫描 Mac Host 窗口中的二维码。"
        case .version: return "二维码版本不支持，请更新 Runweave App。"
        case .loginCode: return "这是登录二维码，请到连接管理中扫码。"
        }
    }
}
