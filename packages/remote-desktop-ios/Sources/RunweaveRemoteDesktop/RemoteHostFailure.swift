import Foundation
import RunweaveRemoteDesktopProtocol

struct RemoteHostFailure: Error, LocalizedError {
    let code: RemoteControlMessage.ErrorCode?
    let reason: String
    let terminal: Bool
    init(message: RemoteControlMessage, fallback: String) {
        code = message.errorCode; reason = message.reason ?? fallback
        terminal = !(message.kind == .error && (code == nil || code == .sessionExpired))
    }
    var errorDescription: String? { reason }
}
