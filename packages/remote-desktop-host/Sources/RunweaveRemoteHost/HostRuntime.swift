import Foundation
import RunweaveRemoteDesktopProtocol

/// A build-time gated fixture uses the same capture, input, protocol and TLS implementation.
/// It cannot be selected in Release or share that host's persistent identity/authorizations.
enum HostRuntime {
    static let simulatorLoopback: Bool = {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("--simulator-loopback")
        #else
        return false
        #endif
    }()
    static let port: UInt16 = simulatorLoopback ? 48572 : RemoteTarget.computerPort
    static let identityService = simulatorLoopback ? "com.runweave.remote-host.simulator.identity" : "com.runweave.remote-host.identity"
    static let pairedDevicesService = simulatorLoopback ? "com.runweave.remote-host.simulator.paired-devices" : "com.runweave.remote-host.paired-devices"
}
