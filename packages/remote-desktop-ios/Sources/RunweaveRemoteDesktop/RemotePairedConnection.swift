import Foundation
import Network
import RunweaveRemoteDesktopProtocol

enum RemotePairedConnection {
    static func connect(target: RemoteTarget) async throws -> RemoteTLSConnection {
        do {
            return try await connectLocal(target: target)
        } catch {
            try Task.checkCancellation()
            guard target.allowsRelayFallback, canTryAnotherRoute(after: error) else { throw error }
            let localError = error
            guard let relay = target.relay, relay.isValid else { throw RemoteTransportError.invalidEndpoint }
            do {
                return try await RemoteTLSConnection.connect(target: target,
                    endpoint: .hostPort(host: .init(relay.host), port: .init(rawValue: relay.port)!), route: .relay)
            } catch {
                try Task.checkCancellation()
                // Identity and protocol errors must remain terminal, including on the fallback route.
                guard canTryAnotherRoute(after: error) else { throw error }
                throw RemoteRouteFailure(local: localError, relay: error)
            }
        }
    }

    private static func connectLocal(target: RemoteTarget) async throws -> RemoteTLSConnection {
        // Simulator-only loopback Hosts do not advertise a LAN service.
        #if DEBUG && targetEnvironment(simulator)
        if target.host == "127.0.0.1" || target.host == "localhost" {
            return try await RemoteTLSConnection.connect(target: target, timeout: 3)
        }
        #endif
        do {
            let endpoint = try await RemoteHostDiscovery.resolve(hostID: target.id)
            return try await RemoteTLSConnection.connect(target: target, endpoint: endpoint, timeout: 3)
        } catch {
            try Task.checkCancellation()
            // A discovered service must pass the original pin. Never replace it
            // or fall back after observing a different identity.
            guard canTryAnotherRoute(after: error) else { throw error }
            // Older Hosts and networks without mDNS retain explicit-address access.
            return try await RemoteTLSConnection.connect(target: target, timeout: 3)
        }
    }

    private static func canTryAnotherRoute(after error: Error) -> Bool {
        if let transport = error as? RemoteTransportError { return transport == .closed || transport == .connectionTimedOut }
        if let network = error as? NWError {
            switch network {
            case .posix, .dns: return true
            default: return false
            }
        }
        return false
    }
}

struct RemoteRouteFailure: LocalizedError {
    let local: Error
    let relay: Error
    var errorDescription: String? {
        "局域网与隧道均无法连接。\n局域网：\(local.localizedDescription)\n隧道：\(relay.localizedDescription)"
    }
}
