import Foundation
import RunweaveRemoteDesktopProtocol

enum RemotePairedConnection {
    static func connect(target: RemoteTarget) async throws -> RemoteTLSConnection {
        if target.usesRelay {
            guard let relay = target.relay, relay.isValid else { throw RemoteTransportError.invalidEndpoint }
            return try await RemoteTLSConnection.connect(target: target,
                endpoint: .hostPort(host: .init(relay.host), port: .init(rawValue: relay.port)!))
        }
        // Simulator-only loopback Hosts do not advertise a LAN service.
        #if DEBUG && targetEnvironment(simulator)
        if target.host == "127.0.0.1" || target.host == "localhost" {
            return try await RemoteTLSConnection.connect(target: target)
        }
        #endif
        do {
            let endpoint = try await RemoteHostDiscovery.resolve(hostID: target.id)
            return try await RemoteTLSConnection.connect(target: target, endpoint: endpoint)
        } catch {
            try Task.checkCancellation()
            // A discovered service must pass the original pin. Never replace it
            // or fall back after observing a different identity.
            if let error = error as? RemoteTransportError, error == .invalidCertificate { throw error }
            // Older Hosts and networks without mDNS retain explicit-address access.
            return try await RemoteTLSConnection.connect(target: target)
        }
    }
}
