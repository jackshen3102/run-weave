import Foundation
import Network

/// Discovery locates an already paired identity; it never establishes trust.
public enum RemoteHostDiscovery {
    public static let serviceType = "_runweave-rd._tcp"

    public static func serviceName(hostID: UUID) -> String { hostID.uuidString.lowercased() }

    public static func resolve(hostID: UUID) async throws -> NWEndpoint {
        let lookup = RemoteHostLookup(name: serviceName(hostID: hostID))
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { lookup.start($0) }
        }, onCancel: { lookup.cancel() })
    }
}

private final class RemoteHostLookup: @unchecked Sendable {
    private let name: String
    private let queue = DispatchQueue(label: "runweave.remote.discovery")
    private let browser: NWBrowser
    private var continuation: CheckedContinuation<NWEndpoint, Error>?
    private var result: Result<NWEndpoint, Error>?

    init(name: String) {
        self.name = name
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = false
        parameters.prohibitedInterfaceTypes = [.cellular, .other]
        browser = NWBrowser(for: .bonjour(type: RemoteHostDiscovery.serviceType, domain: "local."), using: parameters)
    }

    func start(_ continuation: CheckedContinuation<NWEndpoint, Error>) {
        queue.async {
            if let result = self.result { continuation.resume(with: result); return }
            self.continuation = continuation
            self.browser.browseResultsChangedHandler = { [weak self] results, _ in
                guard let self else { return }
                for result in results {
                    if case .service(let name, let type, let domain, let interface) = result.endpoint, name == self.name {
                        // Keep the discovered interface, including when a VPN is
                        // the default route. Never treat the service as identity proof.
                        let selected = interface ?? result.interfaces.sorted { $0.name < $1.name }.first
                        guard let selected else { continue }
                        self.finish(.success(.service(name: name, type: type, domain: domain, interface: selected))); return
                    }
                }
            }
            self.browser.stateUpdateHandler = { [weak self] state in
                if case .failed(let error) = state { self?.finish(.failure(error)) }
            }
            self.browser.start(queue: self.queue)
            self.queue.asyncAfter(deadline: .now() + 3) { self.finish(.failure(RemoteTransportError.closed)) }
        }
    }

    func cancel() { queue.async { self.finish(.failure(CancellationError())) } }

    private func finish(_ result: Result<NWEndpoint, Error>) {
        guard self.result == nil else { return }
        self.result = result
        browser.cancel()
        let continuation = self.continuation; self.continuation = nil
        continuation?.resume(with: result)
    }
}
