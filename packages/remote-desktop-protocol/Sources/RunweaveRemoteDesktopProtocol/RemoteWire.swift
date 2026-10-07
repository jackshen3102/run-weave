import Foundation

public struct RemoteRelayEndpoint: Codable, Hashable, Sendable {
    public var host: String
    public var port: UInt16
    public init(host: String, port: UInt16) { self.host = host; self.port = port }
    public var isValid: Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard port >= 1024, parts.count == 4 else { return false }
        let numbers = parts.compactMap { part -> Int? in
            guard let value = Int(part), (0...255).contains(value), String(value) == part else { return nil }
            return value
        }
        guard numbers.count == 4 else { return false }
        return numbers[0] == 10 || (numbers[0] == 172 && (16...31).contains(numbers[1])) ||
            (numbers[0] == 192 && numbers[1] == 168)
    }
}

public struct RemoteTarget: Codable, Hashable, Sendable, Identifiable {
    public var id: UUID
    public var name: String
    public var host: String
    public var port: UInt16
    public var certificateFingerprint: String
    public var credentialsReference: String?
    /// Saved relay endpoint, retained while LAN is selected.
    public var relay: RemoteRelayEndpoint?
    /// Missing in legacy metadata: a saved relay selected relay, otherwise LAN.
    public var relayEnabled: Bool?
    public var usesRelay: Bool { relayEnabled ?? (relay != nil) }

    public init(id: UUID, name: String, host: String, port: UInt16 = RemoteTarget.computerPort, certificateFingerprint: String, credentialsReference: String? = nil) {
        self.id = id; self.name = name; self.host = host; self.port = port
        self.certificateFingerprint = certificateFingerprint; self.credentialsReference = credentialsReference
    }
    public static let computerPort: UInt16 = 48571
}

public struct RemoteRect: Codable, Hashable, Sendable {
    public var x: Double; public var y: Double; public var width: Double; public var height: Double
    public init(x: Double = 0, y: Double = 0, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }
}

public struct RemoteDisplay: Codable, Hashable, Sendable {
    public var displayID: UInt32
    public var revision: UInt64
    public var logicalBounds: RemoteRect
    public var pixelWidth: Int
    public var pixelHeight: Int
    public var contentRect: RemoteRect
    public var fps: Int
    public var bitrate: Int
    public init(displayID: UInt32, revision: UInt64, logicalBounds: RemoteRect, pixelWidth: Int, pixelHeight: Int, contentRect: RemoteRect, fps: Int = 30, bitrate: Int = 8_000_000) {
        self.displayID = displayID; self.revision = revision; self.logicalBounds = logicalBounds
        self.pixelWidth = pixelWidth; self.pixelHeight = pixelHeight; self.contentRect = contentRect
        self.fps = fps; self.bitrate = bitrate
    }
}

public struct RemoteInput: Codable, Sendable {
    public enum Kind: String, Codable, Sendable { case pointerMove, pointerDown, pointerUp, scroll, keyDown, keyUp, text }
    public var kind: Kind
    public var x: Double?
    public var y: Double?
    /// Left = 0, right = 1. Coordinates normalize the encoded content rectangle only.
    public var button: Int?
    public var clickCount: Int?
    public var deltaX: Double?
    public var deltaY: Double?
    public var keyCode: UInt16?
    /// Shift=1, control=2, option=4, command=8. Modifiers are also explicit keyDown/keyUp events.
    public var modifiers: UInt8
    public var text: String?
    public init(kind: Kind, x: Double? = nil, y: Double? = nil, button: Int? = nil, clickCount: Int? = nil, deltaX: Double? = nil, deltaY: Double? = nil, keyCode: UInt16? = nil, modifiers: UInt8 = 0, text: String? = nil) {
        self.kind = kind; self.x = x; self.y = y; self.button = button; self.clickCount = clickCount
        self.deltaX = deltaX; self.deltaY = deltaY; self.keyCode = keyCode; self.modifiers = modifiers; self.text = text
    }
    public var isValid: Bool {
        guard modifiers <= 15, text?.utf8.count ?? 0 <= 4096 else { return false }
        if let keyCode, keyCode > 126 { return false }
        if let button, !(0...1).contains(button) { return false }
        if let clickCount, !(1...3).contains(clickCount) { return false }
        for value in [x, y].compactMap({ $0 }) { if !value.isFinite || !(0...1).contains(value) { return false } }
        for value in [deltaX, deltaY].compactMap({ $0 }) { if !value.isFinite || abs(value) > 2000 { return false } }
        switch kind {
        case .pointerMove, .pointerDown, .pointerUp, .scroll: return x != nil && y != nil
        case .keyDown, .keyUp: return keyCode != nil
        case .text: return text != nil && !text!.isEmpty
        }
    }
}

/// JSON messages are length framed inside TLS. Secrets only occur in ephemeral pair/auth messages.
public struct RemoteControlMessage: Codable, Sendable {
    public enum ErrorCode: String, Codable, Sendable {
        case permissionScreenRecording, permissionAccessibility, displayUnavailable, authentication, hostStopped, sessionExpired, invalidInput, encoderUnavailable
    }
    public enum Kind: String, Codable, Sendable {
        case pair, pairingPending, paired, authenticate, ready, startViewing, display, input, releaseAll, requestKeyframe, ping, pong, stop, stopAck, error, stats
    }
    public var kind: Kind
    public var version: Int = 1
    public var hostID: UUID?
    public var deviceID: UUID?
    public var deviceName: String?
    public var code: String?
    public var pairingWindowID: UUID?
    public var token: Data?
    public var channel: String?
    public var sessionID: UUID?
    public var displayID: UInt32?
    public var displayRevision: UInt64?
    public var display: RemoteDisplay?
    public var input: RemoteInput?
    public var controlAllowed: Bool?
    public var reason: String?
    public var errorCode: ErrorCode?
    public var nonce: UInt64?
    public var frames: UInt64?
    public var droppedFrames: UInt64?
    public var encodeMilliseconds: Double?
    public init(kind: Kind, hostID: UUID? = nil, deviceID: UUID? = nil, deviceName: String? = nil, code: String? = nil, pairingWindowID: UUID? = nil, token: Data? = nil, channel: String? = nil, sessionID: UUID? = nil, displayID: UInt32? = nil, displayRevision: UInt64? = nil, display: RemoteDisplay? = nil, input: RemoteInput? = nil, controlAllowed: Bool? = nil, reason: String? = nil, errorCode: ErrorCode? = nil, nonce: UInt64? = nil) {
        self.kind = kind; self.hostID = hostID; self.deviceID = deviceID; self.deviceName = deviceName
        self.code = code; self.token = token; self.channel = channel; self.sessionID = sessionID
        self.pairingWindowID = pairingWindowID
        self.displayID = displayID; self.displayRevision = displayRevision; self.display = display
        self.input = input; self.controlAllowed = controlAllowed; self.reason = reason; self.errorCode = errorCode; self.nonce = nonce
    }
}

public struct RemoteVideoHeader: Codable, Sendable {
    public var sessionID: UUID
    public var displayID: UInt32
    public var displayRevision: UInt64
    public var sequence: UInt64
    public var keyframe: Bool
    public var encodeMilliseconds: Double
    public init(sessionID: UUID, displayID: UInt32, displayRevision: UInt64, sequence: UInt64, keyframe: Bool, encodeMilliseconds: Double) {
        self.sessionID = sessionID; self.displayID = displayID; self.displayRevision = displayRevision
        self.sequence = sequence; self.keyframe = keyframe; self.encodeMilliseconds = encodeMilliseconds
    }
}

public struct RemoteVideoPacket: Sendable {
    public var header: RemoteVideoHeader
    /// Annex-B; each IDR contains SPS/PPS. Maximum access unit is 4 MiB.
    public var annexB: Data
    public init(header: RemoteVideoHeader, annexB: Data) { self.header = header; self.annexB = annexB }
    public func encoded() throws -> Data {
        let metadata = try JSONEncoder().encode(header)
        guard metadata.count <= 4096, annexB.count <= 4 * 1024 * 1024 else { throw RemoteTransportError.oversizedMessage }
        var count = UInt32(metadata.count).bigEndian
        var data = withUnsafeBytes(of: &count) { Data($0) }; data.append(metadata); data.append(annexB); return data
    }
    public static func decode(_ data: Data) throws -> Self {
        guard data.count >= 5 else { throw RemoteTransportError.invalidMessage }
        let count = data.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
        guard count > 0, count <= 4096, data.count > count + 4 else { throw RemoteTransportError.invalidMessage }
        let header = try JSONDecoder().decode(RemoteVideoHeader.self, from: data.subdata(in: 4..<(4 + count)))
        return .init(header: header, annexB: data.subdata(in: (4 + count)..<data.count))
    }
}
