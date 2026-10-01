import Foundation
import Network

extension AppSession {
  func reconnectTerminal() async {
    guard canReconnect, let controller = terminalController else { return }
    let epoch = generation
    reconnectingTerminal = true
    defer { if generation == epoch { reconnectingTerminal = false } }
    await refresh()
    guard generation == epoch, terminalController === controller,
      authenticated, foreground, health.status == .online else { return }
    controller.connect()
  }

  func startNetworkMonitoring() {
    networkMonitor.pathUpdateHandler = { [weak self] path in
      let interfaces = [
        NWInterface.InterfaceType.wifi, .cellular, .wiredEthernet, .loopback, .other,
      ]
      .filter { path.usesInterfaceType($0) }.map { String(describing: $0) }.joined(separator: ",")
      let signature = "\(path.status)-\(interfaces)-\(path.isExpensive)-\(path.isConstrained)"
      let reachable = path.status == .satisfied
      Task { @MainActor [weak self] in
        self?.networkChanged(path: path, signature: signature, reachable: reachable)
      }
    }
    networkMonitor.start(queue: DispatchQueue(label: "com.runweave.native.network"))
  }

  func networkChanged(path: NWPath, signature: String, reachable: Bool) {
    let previous = networkSignature
    guard networkPath != path else { return }
    networkPath = path
    networkSignature = signature
    recordConnection(
      "network.path.changed", ["path": signature, "previousPath": previous ?? "unknown"])
    // A system path is only a hint. Verify this Backend before changing connection state.
    guard reachable, foreground, api != nil, previous != nil || health.status == .offline else {
      return
    }
    let epoch = generation
    let wasOffline = health.status == .offline
    probeTask?.cancel()
    probeTask = nil
    resumeTask?.cancel()
    resumeTask = Task { [weak self] in
      guard let self else { return }
      await self.refresh()
      guard self.generation == epoch, self.foreground, self.authenticated,
        self.health.status == .online, !Task.isCancelled
      else { return }
      if wasOffline { self.terminalController?.connect() }
    }
  }

  func recordConnection(_ message: String, _ details: [String: String] = [:]) {
    guard let api else { return }
    var fields = details
    fields["generation"] = String(generation)
    fields["foreground"] = String(foreground)
    DiagnosticStore.shared.append(scope: api.connectionID, .connection(message, details: fields))
  }

  func scheduleProbe(epoch: Int) {
    probeTask?.cancel()
    probeTask = Task { [weak self] in
      guard let self else { return }
      let delays = [5, 15, 30]
      var attempt = 0
      while !Task.isCancelled {
        let delay = delays[min(attempt, delays.count - 1)]
        self.recordConnection(
          "health.retry.scheduled",
          ["retry": String(attempt + 1), "retryDelayMs": String(delay * 1000)])
        attempt = min(attempt + 1, delays.count - 1)
        do { try await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000_000) } catch { return }
        guard self.generation == epoch, self.foreground, let api = self.api else { return }
        self.healthRevision += 1
        let revision = self.healthRevision
        let result = await DeviceHealthService.check(
          base: api.baseURL, connectionID: api.connectionID)
        guard self.generation == epoch, self.healthRevision == revision, self.foreground,
          !Task.isCancelled
        else { return }
        self.applyHealth(result)
        if result.status == .online {
          self.probeTask = nil
          await self.reload()
          guard self.generation == epoch, self.foreground, self.authenticated,
            self.health.status == .online, !Task.isCancelled
          else { return }
          self.terminalController?.connect()
          return
        }
      }
    }
  }

}
