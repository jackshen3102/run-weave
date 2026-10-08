import Foundation

extension AppSession {
  func updateConnection(_ value: BackendConnection?) async {
    guard connection?.id == value?.id else { return }
    connection = value
  }

  /// A transport change retains the terminal surface/navigation and the computer's draft scope.
  func reconnectRoutes() async {
    guard foreground, let resolver = routeResolver else { return }
    reconnectRequest += 1
    let request = reconnectRequest
    generation += 1
    let epoch = generation
    replacingTransport = true
    defer { if reconnectRequest == request { replacingTransport = false; checking = false } }
    saveDraftsNow()
    connection = resolver.computer
    health.status = .checking
    healthRevision += 1
    loading = false; writing = false
    metadataWrites.removeAll(); pendingOverviewEvents.removeAll()
    overviewTask?.cancel(); overviewTask = nil; overviewReloadRequested = false
    events?.dispose(); events = nil
    terminalController?.disconnect()
    deviceStatus.suspend()
    do {
      let next = try await resolver.resolve(force: true)
      guard foreground, reconnectRequest == request, generation == epoch, !Task.isCancelled else { return }
      api = next
      authenticated = await next.hasCredentials()
      health = DeviceHealthSnapshot(status: .online, latencyMilliseconds: resolver.latency, message: "电脑在线")
      error = nil
      knowledgeInbox.reset(api: authenticated ? next : nil)
      if let controller = terminalController { controller.replaceTransport(next) }
      if authenticated {
        await reload()
        guard generation == epoch, foreground else { return }
        if let terminal {
          do {
            let fresh = try await next.details(id: terminal.id)
            guard generation == epoch, foreground else { return }
            self.terminal = fresh
            terminalController?.connect()
          } catch {
            guard generation == epoch else { return }
            self.error = displayError(error)
            // A missing terminal cannot be replaced with a newly created session.
          }
        }
      }
    } catch {
      guard reconnectRequest == request, generation == epoch, foreground, !(error is CancellationError) else { return }
      health = DeviceHealthSnapshot(status: .offline, message: displayError(error))
      self.error = displayError(error)
      if case APIError.credentialsUnavailable = error { await prepareRelogin() }
      else if case APIError.refreshResultUnknown = error { await prepareRelogin() }
      else if probeTask == nil { scheduleProbe(epoch: generation) }
    }
  }

  func prepareRelogin(url: String? = nil) async {
    guard let connection else { return }
    routeLoginRequired = true
    probeTask?.cancel(); probeTask = nil
    routeResolver?.cancel()
    events?.stop(); terminalController?.disconnect(); deviceStatus.suspend()
    health.status = .offline
    authenticated = false
    // A new address is allowed here only after the user explicitly confirms reauthentication.
    api = try? connection.loginClient(url: url ?? routeResolver?.lastVerifiedURL)
    checking = false
  }

  func probe(epoch: Int) async {
    guard foreground, !replacingTransport, let resolver = routeResolver else { return }
    healthRevision += 1
    let revision = healthRevision
    let result: DeviceHealthSnapshot
    do { result = try await resolver.validateCurrent() }
    catch { result = DeviceHealthSnapshot(status: .offline, message: displayError(error)) }
    guard generation == epoch, healthRevision == revision, foreground, !Task.isCancelled else { return }
    applyHealth(result)
    if result.status == .offline {
      deviceStatus.disconnected()
      events?.stop(); terminalController?.disconnect()
      await reconnectRoutes()
      if health.status != .online, foreground { scheduleProbe(epoch: generation) }
    } else {
      probeTask?.cancel(); probeTask = nil
      startEvents()
    }
  }

  func applyHealth(_ result: DeviceHealthSnapshot) {
    if health.status != result.status {
      recordConnection("health.state.changed", ["previous": health.status.rawValue, "status": result.status.rawValue])
    }
    if let id = result.serviceInstanceID {
      if let previous = lastServiceInstanceID, previous != id {
        recordConnection("backend.instance.changed", ["previousServiceInstanceId": previous, "serviceInstanceId": id,
          "previousRuntimeReleaseId": lastRuntimeReleaseID ?? "unknown", "runtimeReleaseId": result.runtimeReleaseID ?? "unknown"])
      }
      lastServiceInstanceID = id
      lastRuntimeReleaseID = result.runtimeReleaseID
    }
    health = result
  }

}
