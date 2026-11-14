import Foundation
import Network
import RunweaveRemoteDesktopProtocol

enum RemotePairedConnection {
    /// Reuse the authenticated control endpoint; cancellation also closes an unfinished video handshake.
    static func connectVideo(target: RemoteTarget, control: RemoteTLSConnection, authentication: RemoteControlMessage) async throws -> RemoteTLSConnection {
        let video = try await RemoteTLSConnection.connect(target: target,
            endpoint: control.connection.currentPath?.remoteEndpoint ?? control.connection.endpoint, route: control.route)
        do {
            try await video.send(authentication)
            let ready = try await video.receiveMessage()
            guard ready.kind == .ready, ready.hostID == target.id, ready.sessionID == authentication.sessionID else {
                throw RemoteHostFailure(message: ready, fallback: "Mac 拒绝了视频订阅。")
            }
            return video
        } catch { video.close(); throw error }
    }

    static func connect(target: RemoteTarget) async throws -> RemoteTLSConnection {
        var failures: [String] = []
        // Simulator-only loopback Hosts do not advertise a LAN service.
        var discover = true
        #if DEBUG && targetEnvironment(simulator)
        discover = target.host != "127.0.0.1" && target.host != "localhost"
        #endif
        if discover {
            do {
                let endpoint = try await RemoteHostDiscovery.resolve(hostID: target.id)
                return try await RemoteTLSConnection.connect(target: target, endpoint: endpoint, timeout: 3)
            } catch {
                try Task.checkCancellation()
                // Every address must pass the original pin. Identity errors are terminal.
                guard canTryAnotherRoute(after: error) else { throw error }
                failures.append("局域网发现：\(error.localizedDescription)")
            }
        }
        var triedLocal = Set<RemoteHostEndpoint>()
        for (index, endpoint) in target.localEndpoints.enumerated() {
            try Task.checkCancellation()
            guard endpoint.isValid else { throw RemoteTransportError.invalidEndpoint }
            guard triedLocal.insert(endpoint).inserted else { continue }
            do {
                return try await RemoteTLSConnection.connect(target: target,
                    endpoint: .hostPort(host: .init(endpoint.host), port: .init(rawValue: endpoint.port)!), timeout: 3)
            } catch {
                try Task.checkCancellation()
                guard canTryAnotherRoute(after: error) else { throw error }
                // Preserve timeout/disconnection reporting for legacy LAN-only targets.
                if target.localEndpoints.count == 1, !target.allowsRelayFallback { throw error }
                failures.append("局域网地址 \(index + 1)：\(error.localizedDescription)")
            }
        }
        if target.allowsRelayFallback {
            guard !target.relayEndpoints.isEmpty else { throw RemoteTransportError.invalidEndpoint }
            var triedRelay = Set<RemoteRelayEndpoint>()
            for (index, endpoint) in target.relayEndpoints.enumerated() {
                try Task.checkCancellation()
                guard endpoint.isValid else { throw RemoteTransportError.invalidEndpoint }
                guard triedRelay.insert(endpoint).inserted else { continue }
                do {
                    return try await RemoteTLSConnection.connect(target: target,
                        endpoint: .hostPort(host: .init(endpoint.host), port: .init(rawValue: endpoint.port)!), route: .relay)
                } catch {
                    try Task.checkCancellation()
                    guard canTryAnotherRoute(after: error) else { throw error }
                    failures.append("隧道地址 \(index + 1)：\(error.localizedDescription)")
                }
            }
        }
        throw RemoteRouteFailure(failures: failures)
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
    let failures: [String]
    var errorDescription: String? {
        "所有桌面地址均无法连接。\n" + failures.joined(separator: "\n")
    }
}
