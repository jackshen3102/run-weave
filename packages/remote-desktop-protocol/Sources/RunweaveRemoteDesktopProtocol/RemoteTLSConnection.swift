import Foundation
import Network
import Security
import CryptoKit

public enum RemoteTransportError: Error, LocalizedError, Equatable {
    case closed, invalidMessage, oversizedMessage, invalidEndpoint, invalidCertificate, keychain(OSStatus)
    public var errorDescription: String? {
        switch self {
        case .closed: return "Remote Host connection closed."
        case .invalidMessage: return "Remote Host sent an invalid message."
        case .oversizedMessage: return "Remote message exceeded its size limit."
        case .invalidEndpoint: return "Remote Host address or certificate fingerprint is invalid."
        case .invalidCertificate: return "Remote Host identity could not be verified. Check its fingerprint and certificate validity."
        case .keychain(let status): return "Remote credential storage failed (\(status))."
        }
    }
}

public struct RemoteKeychainStore {
    public var service: String
    public init(service: String) { self.service = service }
    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
         kSecAttrSynchronizable as String: false]
    }
    public func set(_ data: Data, account: String) throws {
        var item = query(account); item[kSecValueData as String] = data
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let updated = SecItemUpdate(query(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            guard updated == errSecSuccess else { throw RemoteTransportError.keychain(updated) }
        } else if status != errSecSuccess { throw RemoteTransportError.keychain(status) }
    }
    public func get(account: String) throws -> Data? {
        var item = query(account); item[kSecReturnData as String] = true; item[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(item as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw RemoteTransportError.keychain(status) }
        return result as? Data
    }
    public func delete(account: String) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw RemoteTransportError.keychain(status) }
    }
}

public enum RemoteTLS {
    public static func fingerprint(_ certificate: SecCertificate) -> String {
        SHA256.hash(data: SecCertificateCopyData(certificate) as Data).map { String(format: "%02x", $0) }.joined()
    }
    public static func normalizedFingerprint(_ raw: String) -> String {
        raw.lowercased().replacingOccurrences(of: ":", with: "").replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "\n", with: "")
    }
    public static func clientParameters(fingerprint expected: String, verificationRejected: (() -> Void)? = nil) throws -> NWParameters {
        let pin = normalizedFingerprint(expected)
        guard pin.count == 64, pin.allSatisfy({ $0.isHexDigit }) else { throw RemoteTransportError.invalidEndpoint }
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, securityTrust, complete in
            let trust = sec_trust_copy_ref(securityTrust).takeRetainedValue()
            guard let certificate = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first, Self.fingerprint(certificate) == pin,
                  Self.certificateIsCurrent(certificate) else { verificationRejected?(); complete(false); return }
            // Exact certificate identity, independent of a mutable IP/DNS name. Do not trust another self-signed leaf.
            SecTrustSetPolicies(trust, SecPolicyCreateBasicX509())
            SecTrustSetAnchorCertificates(trust, [certificate] as CFArray)
            SecTrustSetAnchorCertificatesOnly(trust, true)
            SecTrustSetVerifyDate(trust, Date() as CFDate)
            let valid = SecTrustEvaluateWithError(trust, nil)
            if !valid { verificationRejected?() }; complete(valid)
        }, DispatchQueue(label: "runweave.remote.tls.verify"))
        return NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
    }
    public static func serverParameters(identity: SecIdentity) throws -> NWParameters {
        guard let nativeIdentity = sec_identity_create(identity) else { throw RemoteTransportError.invalidCertificate }
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
        sec_protocol_options_set_local_identity(tls.securityProtocolOptions, nativeIdentity)
        let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
        parameters.includePeerToPeer = false
        parameters.prohibitedInterfaceTypes = [.cellular, .loopback, .other]
        return parameters
    }

    /// Self-signed anchors can be exempt from date checks in system trust. Parse only X.509's
    /// validity sequence for an additional explicit check; Security still validates the certificate.
    public static func certificateIsCurrent(_ certificate: SecCertificate, now: Date = Date()) -> Bool {
        struct DER {
            var bytes: [UInt8]; var index = 0
            mutating func next() -> (UInt8, [UInt8])? {
                guard index + 2 <= bytes.count else { return nil }
                let tag = bytes[index]; index += 1
                var length = Int(bytes[index]); index += 1
                if length & 128 != 0 {
                    let count = length & 127
                    guard count > 0, count <= 4, index + count <= bytes.count else { return nil }
                    length = 0
                    for _ in 0..<count { length = length * 256 + Int(bytes[index]); index += 1 }
                }
                guard length >= 0, index + length <= bytes.count else { return nil }
                let value = Array(bytes[index..<(index + length)]); index += length; return (tag, value)
            }
        }
        var root = DER(bytes: Array(SecCertificateCopyData(certificate) as Data))
        guard let outer = root.next(), outer.0 == 0x30 else { return false }
        var certificateSequence = DER(bytes: outer.1)
        guard let tbs = certificateSequence.next(), tbs.0 == 0x30 else { return false }
        var fields = DER(bytes: tbs.1)
        guard let first = fields.next() else { return false }
        if first.0 == 0xa0 { guard fields.next() != nil else { return false } }
        guard fields.next() != nil, fields.next() != nil,
              let validity = fields.next(), validity.0 == 0x30 else { return false }
        var dates = DER(bytes: validity.1)
        func parse(_ value: (UInt8, [UInt8])?) -> Date? {
            guard let value, let raw = String(bytes: value.1, encoding: .ascii), raw.hasSuffix("Z") else { return nil }
            let format: String
            switch value.0 { case 0x17: format = "yyMMddHHmmss'Z'"; case 0x18: format = "yyyyMMddHHmmss'Z'"; default: return nil }
            let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = format
            formatter.twoDigitStartDate = Date(timeIntervalSince1970: -631152000) // 1950, X.509 UTCTime boundary.
            return formatter.date(from: raw)
        }
        guard let before = parse(dates.next()), let after = parse(dates.next()) else { return false }
        return before <= now && now <= after
    }
}

/// One bounded length-framed TLS stream. Control and video always use different instances.
public final class RemoteTLSConnection: @unchecked Sendable {
    public static let maximumMessageSize = 4 * 1024 * 1024 + 4096
    public let connection: NWConnection
    private let queue = DispatchQueue(label: "runweave.remote.tcp")
    private let lock = NSLock()
    private var pendingBytes = 0
    public init(connection: NWConnection) { self.connection = connection }
    public static func connect(target: RemoteTarget, endpoint: NWEndpoint? = nil) async throws -> RemoteTLSConnection {
        guard !target.host.isEmpty, let port = NWEndpoint.Port(rawValue: target.port) else { throw RemoteTransportError.invalidEndpoint }
        let verification = TLSVerificationState()
        let parameters = try RemoteTLS.clientParameters(fingerprint: target.certificateFingerprint, verificationRejected: { verification.reject() })
        parameters.includePeerToPeer = false
        // Only an explicitly configured relay permits cellular/VPN routing.
        // TLS pinning and device authentication are identical on both routes.
        if let relay = target.relay {
            guard relay.isValid else { throw RemoteTransportError.invalidEndpoint }
        } else {
            parameters.prohibitedInterfaceTypes = [.cellular, .other]
        }
        let destination = endpoint ?? .hostPort(host: NWEndpoint.Host(target.host), port: port)
        let channel = RemoteTLSConnection(connection: NWConnection(to: destination, using: parameters))
        do { try await channel.start(); return channel }
        catch { channel.close(); if verification.wasRejected { throw RemoteTransportError.invalidCertificate }; throw error }
    }
    public func start() async throws {
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let startState = StartState(continuation)
                connection.stateUpdateHandler = { state in
                    switch state {
                    case .ready: startState.finish(.success(()))
                    case .failed(let error): startState.finish(.failure(error))
                    case .cancelled: startState.finish(.failure(RemoteTransportError.closed))
                    default: break
                    }
                }
                connection.start(queue: queue)
                queue.asyncAfter(deadline: .now() + 10) { if !startState.isFinished { self.connection.cancel() } }
            }
        }, onCancel: { self.close() })
    }
    public func close() { connection.cancel() }
    public func send(_ message: RemoteControlMessage) async throws { try await sendData(JSONEncoder().encode(message)) }
    public func sendBestEffort(_ message: RemoteControlMessage) throws {
        let data = try JSONEncoder().encode(message)
        let framed = try reserveAndFrame(data)
        connection.send(content: framed, completion: .contentProcessed { _ in self.completeSend(data.count) })
    }
    public func receiveMessage() async throws -> RemoteControlMessage {
        let data = try await receiveData(maximumSize: 64 * 1024)
        let message = try JSONDecoder().decode(RemoteControlMessage.self, from: data)
        guard message.version == 1 else { throw RemoteTransportError.invalidMessage }; return message
    }
    public func sendData(_ data: Data) async throws {
        let framed = try reserveAndFrame(data)
        let timeout = Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if !Task.isCancelled { self.close() }
        }
        defer { timeout.cancel() }
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                connection.send(content: framed, completion: .contentProcessed { error in
                    self.completeSend(data.count)
                    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                })
            }
        }, onCancel: { self.close() })
    }
    private func reserveAndFrame(_ data: Data) throws -> Data {
        guard data.count > 0, data.count <= Self.maximumMessageSize else { throw RemoteTransportError.oversizedMessage }
        lock.lock(); defer { lock.unlock() }
        guard pendingBytes + data.count <= Self.maximumMessageSize * 2 else { throw RemoteTransportError.oversizedMessage }
        pendingBytes += data.count
        var count = UInt32(data.count).bigEndian
        var framed = withUnsafeBytes(of: &count) { Data($0) }; framed.append(data); return framed
    }
    private func completeSend(_ count: Int) { lock.lock(); pendingBytes -= count; lock.unlock() }
    public func receiveData(maximumSize: Int = RemoteTLSConnection.maximumMessageSize) async throws -> Data {
        let header = try await readExactly(4)
        let count = header.reduce(0) { ($0 << 8) | Int($1) }
        guard count > 0, count <= maximumSize, count <= Self.maximumMessageSize else { close(); throw RemoteTransportError.oversizedMessage }
        return try await readExactly(count)
    }
    private func readExactly(_ count: Int) async throws -> Data {
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                connection.receive(minimumIncompleteLength: count, maximumLength: count) { data, _, complete, error in
                    if let error { continuation.resume(throwing: error) }
                    else if let data, data.count == count { continuation.resume(returning: data) }
                    else { continuation.resume(throwing: RemoteTransportError.closed) }
                }
            }
        }, onCancel: { self.close() })
    }
}

private final class StartState: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?
    init(_ continuation: CheckedContinuation<Void, Error>) { self.continuation = continuation }
    var isFinished: Bool { lock.lock(); defer { lock.unlock() }; return continuation == nil }
    func finish(_ result: Result<Void, Error>) {
        lock.lock(); let continuation = self.continuation; self.continuation = nil; lock.unlock()
        continuation?.resume(with: result)
    }
}

private final class TLSVerificationState: @unchecked Sendable {
    private let lock = NSLock()
    private var rejected = false
    func reject() { lock.lock(); rejected = true; lock.unlock() }
    var wasRejected: Bool { lock.lock(); defer { lock.unlock() }; return rejected }
}
