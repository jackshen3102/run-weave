import Foundation
import RunweaveRemoteDesktopProtocol

struct RemoteStoredCredential: Codable {
    let hostID: UUID
    let deviceID: UUID
    let certificateFingerprint: String
    let token: Data
}

/// Its service and device identity are separate from Backend authentication.
public struct RemoteCredentialStore {
    private let keychain = RemoteKeychainStore(service: "com.runweave.remote-desktop.credentials.v1")
    public init() {}

    func deviceID() throws -> UUID {
        if let bytes = try keychain.get(account: "local-device-id"),
           let string = String(data: bytes, encoding: .utf8), let id = UUID(uuidString: string) { return id }
        let id = UUID()
        try keychain.set(Data(id.uuidString.utf8), account: "local-device-id")
        return id
    }

    func load(target: RemoteTarget) throws -> RemoteStoredCredential {
        guard let reference = target.credentialsReference, let data = try keychain.get(account: "host:" + reference) else {
            throw RemotePairingError.notPaired
        }
        let credential = try JSONDecoder().decode(RemoteStoredCredential.self, from: data)
        guard credential.hostID == target.id,
              credential.certificateFingerprint == RemoteTLS.normalizedFingerprint(target.certificateFingerprint),
              credential.token.count == 32 else { throw RemotePairingError.identityChanged }
        return credential
    }

    func save(_ credential: RemoteStoredCredential) throws -> String {
        let reference = UUID().uuidString
        try keychain.set(JSONEncoder().encode(credential), account: "host:" + reference)
        return reference
    }

    public func forget(target: RemoteTarget) throws {
        if let reference = target.credentialsReference { try keychain.delete(account: "host:" + reference) }
    }
}

public enum RemotePairingError: Error, LocalizedError {
    case notPaired, identityChanged, invalidCode, declined(String), timedOut
    public var errorDescription: String? {
        switch self {
        case .notPaired: return "请先与这台 Mac 配对。"
        case .identityChanged: return "Mac 身份与保存的配对不同，请核对后重新配对。"
        case .invalidCode: return "输入 Mac 本地显示的 6 位配对码。"
        case .declined(let reason): return reason
        case .timedOut: return "配对已超时，请在 Mac 重新开启配对。"
        }
    }
}

public struct RemotePairingClient {
    private let credentials: RemoteCredentialStore
    public init(credentials: RemoteCredentialStore = .init()) { self.credentials = credentials }

    /// The supplied certificate pin must be explicitly verified by the user
    /// against the Mac's local display. TLS never performs trust-on-first-use.
    public func pair(target: RemoteTarget, code: String, deviceName: String,
                     onWaitingForConfirmation: (@MainActor () -> Void)? = nil) async throws -> RemoteTarget {
        guard code.utf8.count == 6, code.utf8.allSatisfy({ (48...57).contains($0) }),
              !deviceName.isEmpty, deviceName.count <= 80 else {
            throw RemotePairingError.invalidCode
        }
        let connection = try await RemoteTLSConnection.connect(target: target)
        defer { connection.close() }
        let deviceID = try credentials.deviceID()
        try await connection.send(.init(kind: .pair, hostID: target.id, deviceID: deviceID,
                                        deviceName: deviceName, code: code))
        let paired = try await withThrowingTaskGroup(of: RemoteControlMessage.self) { group in
            group.addTask {
                while !Task.isCancelled {
                    let message = try await connection.receiveMessage()
                    switch message.kind {
                    case .pairingPending: await onWaitingForConfirmation?()
                    case .paired: return message
                    case .error: throw RemotePairingError.declined(message.reason ?? "Mac 拒绝了配对。")
                    default: throw RemoteTransportError.invalidMessage
                    }
                }
                throw CancellationError()
            }
            group.addTask {
                try await Task.sleep(nanoseconds: 120_000_000_000)
                connection.close()
                throw RemotePairingError.timedOut
            }
            defer { group.cancelAll() }
            guard let result = try await group.next() else { throw RemotePairingError.timedOut }
            return result
        }
        try Task.checkCancellation()
        guard let hostID = paired.hostID, paired.deviceID == deviceID,
              let token = paired.token, token.count == 32 else { throw RemoteTransportError.invalidMessage }
        let reference = try credentials.save(.init(hostID: hostID, deviceID: deviceID,
            certificateFingerprint: RemoteTLS.normalizedFingerprint(target.certificateFingerprint), token: token))
        var result = target
        result.id = hostID; result.credentialsReference = reference
        if let name = paired.deviceName, !name.isEmpty { result.name = name }
        return result
    }
}
