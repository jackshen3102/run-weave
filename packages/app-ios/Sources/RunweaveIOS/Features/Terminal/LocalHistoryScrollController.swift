import Foundation
import RunweaveBrowser
import SwiftTerm
import UIKit

/// Manages a pre-warmed read-only SwiftTermSurface for 0-RTT local tmux scrollback on iOS.
@MainActor
public final class LocalHistoryScrollController: NSObject, ObservableObject {
  @Published public private(set) var surface: SwiftTermSurface?
  @Published public private(set) var isShowingLocalHistory = false
  @Published public private(set) var isReady = false

  private(set) var cachedPaneId: String?
  private(set) var currentPaneId: String?
  private(set) var cachedLineCount = 0
  private(set) var cachedSourceCols = 0
  private(set) var dirty = false
  private(set) var ansiScrollbackUnsupported = false
  private(set) var lastKnownOwner = "history"
  private(set) var lastKnownCopyMode = false

  var isViewportActive = true {
    didSet {
      if isViewportActive, !oldValue, dirty, !isShowingLocalHistory { scheduleRefresh(immediate: false) }
    }
  }
  var onStateChanged: (() -> Void)?
  var onVisibilityChanged: ((SwiftTermSurface?, Bool) -> Void)?
  var openFileRequested: ((TerminalFileTap) -> Void)?
  var openLinkRequested: ((BrowserOpenIntent) -> Void)?

  private weak var liveSurface: SwiftTermSurface?
  private let fetchScrollback: () async throws -> TerminalAnsiScrollbackResponse
  private let record: (String, [String: Any]) -> Void
  private var isDarkTheme = DevicePreferences.theme != "light"

  private var generation = 0
  private var paneEpoch = 0
  private var debounceTask: Task<Void, Never>?
  private var refreshTask: Task<Void, Never>?
  private var stagingSurface: SwiftTermSurface?
  private var pendingSnapshot: (surface: SwiftTermSurface, paneId: String, sourceCols: Int, lineCount: Int)?
  private var lastSyncCompletedAt: TimeInterval = 0
  private var firstDirtyAt: TimeInterval?

  private var currentOffsetY: CGFloat = 0
  private var hasScrolledAwayFromBottom = false
  private var handoffActive = false
  private var ApplyingProgrammaticOffset = false
  private var momentum: CADisplayLink?
  private var momentumVelocity: CGFloat = 0
  private var lastMomentumTime: CFTimeInterval = 0

  private static let debounceNanoseconds: UInt64 = 600_000_000
  private static let maxStreamingDirtyInterval: TimeInterval = 3.0
  private static let feedChunkBytes = 16_384

  init(
    liveSurface: SwiftTermSurface,
    fetchScrollback: @escaping () async throws -> TerminalAnsiScrollbackResponse,
    record: @escaping (String, [String: Any]) -> Void
  ) {
    self.liveSurface = liveSurface
    self.fetchScrollback = fetchScrollback
    self.record = record
    super.init()
  }

  func applyTheme(dark: Bool) {
    isDarkTheme = dark
    surface?.applyTheme(dark: dark)
    stagingSurface?.applyTheme(dark: dark)
    pendingSnapshot?.surface.applyTheme(dark: dark)
  }

  func handleConnected(runtimeKind: String?) {
    if runtimeKind != "tmux" { resetAll() }
  }

  func handleInitialSnapshot(runtimeKind: String?) {
    guard runtimeKind == "tmux", !ansiScrollbackUnsupported else { return }
    dirty = true
    scheduleRefresh(immediate: true)
  }

  func markDirty(runtimeKind: String?) {
    guard runtimeKind == "tmux", !ansiScrollbackUnsupported else { return }
    let now = ProcessInfo.processInfo.systemUptime
    if !dirty {
      dirty = true
      firstDirtyAt = now
    }
    guard !isShowingLocalHistory else { return }
    let elapsedSinceSync = lastSyncCompletedAt > 0
      ? (now - lastSyncCompletedAt)
      : (now - (firstDirtyAt ?? now))
    if isViewportActive, isReady, elapsedSinceSync >= Self.maxStreamingDirtyInterval, refreshTask == nil {
      scheduleRefresh(immediate: true)
    } else {
      scheduleRefresh(immediate: false)
    }
  }

  func updateScrollState(_ state: TerminalScrollState, runtimeKind: String?) {
    lastKnownOwner = state.owner
    lastKnownCopyMode = state.copyMode
    if let nextPaneId = state.paneId, !nextPaneId.isEmpty {
      let previousPaneId = currentPaneId
      currentPaneId = nextPaneId
      if (previousPaneId != nil && previousPaneId != nextPaneId)
        || (cachedPaneId != nil && cachedPaneId != nextPaneId)
      {
        invalidateForPaneSwitch(nextPaneId: nextPaneId, runtimeKind: runtimeKind)
      }
    }
  }

  private func invalidateForPaneSwitch(nextPaneId: String, runtimeKind: String?) {
    paneEpoch += 1
    debounceTask?.cancel()
    debounceTask = nil
    refreshTask?.cancel()
    refreshTask = nil
    stagingSurface?.dispose()
    stagingSurface = nil
    pendingSnapshot?.surface.dispose()
    pendingSnapshot = nil
    if isShowingLocalHistory {
      exitLocalHistory(reason: "pane_switched")
    }
    surface?.dispose()
    surface = nil
    cachedPaneId = nil
    cachedLineCount = 0
    cachedSourceCols = 0
    isReady = false
    dirty = true
    onVisibilityChanged?(nil, false)
    onStateChanged?()
    record("scroll.local_pane_invalidated", ["paneId": nextPaneId])
    if runtimeKind == "tmux", !ansiScrollbackUnsupported {
      scheduleRefresh(immediate: true)
    }
  }

  func canUseLocalHistoryScroll(runtimeKind: String?) -> Bool {
    guard runtimeKind == "tmux", !ansiScrollbackUnsupported, isReady, let surface else {
      return false
    }
    guard lastKnownOwner == "history", !lastKnownCopyMode else {
      return false
    }
    if let currentPaneId, let cachedPaneId, currentPaneId != cachedPaneId {
      return false
    }
    syncSurfaceFrame(surface)
    return Self.maxOffsetY(for: surface.terminalView) > 0 || cachedLineCount > 0
  }

  func beginGesture(deltaY: CGFloat, runtimeKind: String?) -> Bool {
    guard deltaY > 0, canUseLocalHistoryScroll(runtimeKind: runtimeKind), let surface else {
      return false
    }
    cancelMomentum()
    syncSurfaceFrame(surface)
    let maxOffset = Self.maxOffsetY(for: surface.terminalView)
    if !isShowingLocalHistory {
      currentOffsetY = maxOffset
      hasScrolledAwayFromBottom = false
      applyOffsetY(maxOffset, to: surface.terminalView, maxOffset: maxOffset)
      isShowingLocalHistory = true
      onVisibilityChanged?(surface, true)
      onStateChanged?()
      record(
        "scroll.local_enter",
        [
          "paneId": cachedPaneId ?? "",
          "lineCount": cachedLineCount,
          "sourceCols": cachedSourceCols,
          "dirty": dirty,
        ])
      if debounceTask != nil {
        debounceTask?.cancel()
        debounceTask = nil
      }
      if refreshTask != nil {
        refreshTask?.cancel()
        refreshTask = nil
        stagingSurface?.dispose()
        stagingSurface = nil
        dirty = true
      }
    }
    handoffActive = true
    updateGesture(deltaY: deltaY)
    return true
  }

  func updateGesture(deltaY: CGFloat) {
    guard isShowingLocalHistory, let surface else { return }
    let maxOffset = Self.maxOffsetY(for: surface.terminalView)
    let targetY = min(max(0, currentOffsetY - deltaY), maxOffset)
    applyOffsetY(targetY, to: surface.terminalView, maxOffset: maxOffset)
    if targetY < maxOffset - 2 {
      hasScrolledAwayFromBottom = true
    }
    if hasScrolledAwayFromBottom, deltaY < 0, targetY >= maxOffset - 2 {
      handoffActive = false
      exitLocalHistory(reason: "bottom_reached")
    }
  }

  func endGesture(velocityY: CGFloat) {
    handoffActive = false
    guard isShowingLocalHistory, let surface else { return }
    let maxOffset = Self.maxOffsetY(for: surface.terminalView)
    if currentOffsetY >= maxOffset - 2, velocityY <= 0 {
      exitLocalHistory(reason: "bottom_reached")
      return
    }
    if abs(velocityY) >= 80 {
      let maxVelocity = max(surface.terminalView.bounds.height * 4, 2400)
      momentumVelocity = min(max(velocityY, -maxVelocity), maxVelocity)
      lastMomentumTime = 0
      let link = CADisplayLink(target: self, selector: #selector(stepMomentum(_:)))
      if #available(iOS 15.0, *) {
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
      }
      momentum = link
      link.add(to: .main, forMode: .common)
    }
  }

  @objc private func stepMomentum(_ link: CADisplayLink) {
    guard isShowingLocalHistory, let surface, surface.view.window != nil,
      !surface.terminalView.hasActiveSelection
    else {
      cancelMomentum()
      return
    }
    let elapsed =
      lastMomentumTime == 0 ? link.duration : min(0.05, link.timestamp - lastMomentumTime)
    lastMomentumTime = link.timestamp
    let decay = pow(Double(UIScrollView.DecelerationRate.normal.rawValue), elapsed * 1000)
    let previousVelocity = momentumVelocity
    momentumVelocity *= CGFloat(decay)
    let deltaY = (previousVelocity + momentumVelocity) * CGFloat(elapsed) / 2
    let maxOffset = Self.maxOffsetY(for: surface.terminalView)
    let targetY = min(max(0, currentOffsetY - deltaY), maxOffset)
    applyOffsetY(targetY, to: surface.terminalView, maxOffset: maxOffset)
    if targetY < maxOffset - 2 {
      hasScrolledAwayFromBottom = true
    }
    if targetY >= maxOffset - 2, momentumVelocity < 0 {
      cancelMomentum()
      exitLocalHistory(reason: "bottom_reached")
      return
    }
    if (targetY <= 0.5 && momentumVelocity > 0) || abs(momentumVelocity) < 20 {
      cancelMomentum()
    }
  }

  func cancelMomentum() {
    momentum?.invalidate()
    momentum = nil
    momentumVelocity = 0
    lastMomentumTime = 0
  }

  func exitLocalHistory(reason: String) {
    cancelMomentum()
    handoffActive = false
    hasScrolledAwayFromBottom = false
    guard isShowingLocalHistory else { return }
    surface?.terminalView.resignFirstResponder()
    isShowingLocalHistory = false
    if let pending = pendingSnapshot {
      pendingSnapshot = nil
      let previous = surface
      surface = pending.surface
      cachedPaneId = pending.paneId
      cachedSourceCols = pending.sourceCols
      cachedLineCount = pending.lineCount
      isReady = true
      previous?.dispose()
    }
    if let surface {
      syncSurfaceFrame(surface)
      scrollSurfaceToBottom(surface)
    }
    onVisibilityChanged?(surface, false)
    onStateChanged?()
    record("scroll.local_exit", ["reason": reason, "paneId": cachedPaneId ?? ""])
    if dirty {
      scheduleRefresh(immediate: false)
    }
  }

  func scheduleRefresh(immediate: Bool) {
    guard !ansiScrollbackUnsupported, !isShowingLocalHistory else { return }
    debounceTask?.cancel()
    debounceTask = nil
    if immediate {
      triggerRefresh()
      return
    }
    let epoch = generation
    let targetPaneEpoch = paneEpoch
    debounceTask = Task { [weak self] in
      do {
        try await Task.sleep(nanoseconds: Self.debounceNanoseconds)
      } catch {
        return
      }
      guard let self, !Task.isCancelled, self.generation == epoch,
        self.paneEpoch == targetPaneEpoch
      else { return }
      self.debounceTask = nil
      self.triggerRefresh()
    }
  }

  private func triggerRefresh() {
    guard !ansiScrollbackUnsupported, refreshTask == nil else { return }
    let epoch = generation
    let targetPaneEpoch = paneEpoch
    let expectedPane = currentPaneId
    let wasDirtyBeforeFetch = dirty
    dirty = false
    firstDirtyAt = nil

    refreshTask = Task { [weak self] in
      guard let self else { return }
      defer {
        if self.generation == epoch, self.paneEpoch == targetPaneEpoch {
          self.refreshTask = nil
          if self.dirty, !self.isShowingLocalHistory, !self.ansiScrollbackUnsupported {
            self.scheduleRefresh(immediate: false)
          }
        }
      }
      do {
        let response = try await self.fetchScrollback()
        guard !Task.isCancelled, self.generation == epoch, self.paneEpoch == targetPaneEpoch else {
          return
        }
        if let currentPane = self.currentPaneId, currentPane != response.paneId {
          self.dirty = true
          return
        }
        if let expectedPane, expectedPane != response.paneId {
          self.dirty = true
          return
        }
        if let owner = response.owner, !owner.isEmpty {
          self.lastKnownOwner = owner
        }
        if let copyMode = response.copyMode {
          self.lastKnownCopyMode = copyMode
        }
        if self.currentPaneId == nil {
          self.currentPaneId = response.paneId
        }

        let lineCount = max(response.lineCount, response.data.filter { $0 == "\n" }.count + 1)
        let candidate = self.makeHistorySurface(
          scrollback: max(5000, lineCount + 100), paneId: response.paneId)
        self.stagingSurface?.dispose()
        self.stagingSurface = candidate
        self.syncSurfaceFrame(candidate)

        let normalized = response.data.replacingOccurrences(
          of: "\r?\n", with: "\r\n", options: .regularExpression)
        let bytes = Array(normalized.utf8)
        for offset in stride(from: 0, to: bytes.count, by: Self.feedChunkBytes) {
          guard !Task.isCancelled, self.generation == epoch, self.paneEpoch == targetPaneEpoch,
            self.currentPaneId == nil || self.currentPaneId == response.paneId
          else {
            if self.stagingSurface === candidate { self.stagingSurface = nil }
            candidate.dispose()
            return
          }
          candidate.feed(Array(bytes[offset..<min(offset + Self.feedChunkBytes, bytes.count)]))
          await Task.yield()
        }

        guard !Task.isCancelled, self.generation == epoch, self.paneEpoch == targetPaneEpoch,
          self.currentPaneId == nil || self.currentPaneId == response.paneId
        else {
          if self.stagingSurface === candidate { self.stagingSurface = nil }
          candidate.dispose()
          return
        }

        if self.stagingSurface === candidate { self.stagingSurface = nil }
        self.syncSurfaceFrame(candidate)
        self.scrollSurfaceToBottom(candidate)
        self.lastSyncCompletedAt = ProcessInfo.processInfo.systemUptime

        if self.isShowingLocalHistory {
          self.pendingSnapshot?.surface.dispose()
          self.pendingSnapshot = (
            surface: candidate,
            paneId: response.paneId,
            sourceCols: response.sourceCols,
            lineCount: response.lineCount
          )
        } else {
          let oldSurface = self.surface
          self.surface = candidate
          self.cachedPaneId = response.paneId
          self.cachedSourceCols = response.sourceCols
          self.cachedLineCount = response.lineCount
          self.isReady = true
          self.onVisibilityChanged?(candidate, false)
          oldSurface?.dispose()
        }
      } catch APIError.http(404) {
        guard self.generation == epoch else { return }
        self.ansiScrollbackUnsupported = true
        self.dirty = false
        self.record("scroll.local_unsupported", ["status": 404])
      } catch APIError.http(409) {
        guard self.generation == epoch else { return }
        self.dirty = false
      } catch {
        guard self.generation == epoch, self.paneEpoch == targetPaneEpoch else { return }
        if wasDirtyBeforeFetch {
          self.dirty = true
        }
      }
    }
  }

  private func makeHistorySurface(scrollback: Int, paneId: String) -> SwiftTermSurface {
    let historySurface = SwiftTermSurface(scrollback: scrollback)
    historySurface.applyTheme(dark: isDarkTheme)
    historySurface.isTmux = { false }
    historySurface.rawInput = nil
    historySurface.openFileRequested = { [weak self] tap in
      self?.openFileRequested?(tap.withSourcePaneId(paneId))
    }
    historySurface.openLinkRequested = { [weak self] intent in self?.openLinkRequested?(intent) }
    let terminalView = historySurface.terminalView
    terminalView.allowMouseReporting = false
    terminalView.inputView = UIView(frame: .zero)
    terminalView.inputAccessoryView = nil
    terminalView.accessibilityIdentifier = "native-terminal"
    if let nativeView = terminalView as? NativeTerminalView {
      nativeView.acceptsTerminalResponses = { false }
      nativeView.onTouchBegan = { [weak self] in
        self?.cancelMomentum()
      }
      nativeView.onScrollPositionChanged = { [weak self, weak nativeView] offsetY, maxOffsetY, isTracking, isDecelerating in
        guard let self, let nativeView, self.surface?.terminalView === nativeView else { return }
        self.handleNativeScrollPositionChanged(
          view: nativeView,
          offsetY: offsetY,
          maxOffsetY: maxOffsetY,
          isTracking: isTracking,
          isDecelerating: isDecelerating
        )
      }
    }
    return historySurface
  }

  private func handleNativeScrollPositionChanged(
    view: NativeTerminalView,
    offsetY: CGFloat,
    maxOffsetY: CGFloat,
    isTracking: Bool,
    isDecelerating: Bool
  ) {
    guard isShowingLocalHistory, !ApplyingProgrammaticOffset, !handoffActive, momentum == nil else {
      return
    }
    currentOffsetY = offsetY
    if offsetY < maxOffsetY - 2 {
      hasScrolledAwayFromBottom = true
    }
    guard hasScrolledAwayFromBottom, offsetY >= maxOffsetY - 2 else { return }
    let panTranslationY = view.panGestureRecognizer.translation(in: view).y
    if !isTracking || (!isDecelerating && panTranslationY <= 0) || panTranslationY < -2 {
      exitLocalHistory(reason: "bottom_reached")
    }
  }

  private func syncSurfaceFrame(_ targetSurface: SwiftTermSurface) {
    guard let liveView = liveSurface?.terminalView else { return }
    let liveBounds = liveView.bounds
    if liveBounds.width > 0, liveBounds.height > 0 {
      if targetSurface.view.frame.size != liveBounds.size {
        targetSurface.view.frame = CGRect(origin: .zero, size: liveBounds.size)
      }
      targetSurface.terminalView.layoutIfNeeded()
    } else {
      let liveTerminal = liveView.getTerminal()
      if liveTerminal.cols > 0, liveTerminal.rows > 0 {
        targetSurface.terminalView.getTerminal().resize(
          cols: liveTerminal.cols, rows: liveTerminal.rows)
      }
    }
  }

  private func scrollSurfaceToBottom(_ targetSurface: SwiftTermSurface) {
    let view = targetSurface.terminalView
    let maxOffset = Self.maxOffsetY(for: view)
    applyOffsetY(maxOffset, to: view, maxOffset: maxOffset)
  }

  private func applyOffsetY(_ offsetY: CGFloat, to view: TerminalView, maxOffset: CGFloat) {
    let clampedY = min(max(0, offsetY), maxOffset)
    if surface?.terminalView === view {
      currentOffsetY = clampedY
    }
    let terminal = view.getTerminal()
    let rows = max(1, terminal.rows)
    let lineHeight = max(1, view.getOptimalFrameSize().height / CGFloat(rows))
    let maxRow = max(0, Int(ceil(maxOffset / lineHeight)))
    let targetRow = clampedY >= maxOffset - 1
      ? maxRow
      : max(0, min(maxRow, Int(floor(clampedY / lineHeight))))
    ApplyingProgrammaticOffset = true
    if terminal.displayTopVisibleRow != targetRow {
      view.scrollTo(row: targetRow, notifyAccessibility: false)
    }
    if abs(view.contentOffset.y - clampedY) > 0.25 {
      view.contentOffset = CGPoint(x: 0, y: clampedY)
      view.setNeedsDisplay(view.bounds)
    }
    ApplyingProgrammaticOffset = false
  }

  static func maxOffsetY(for view: UIScrollView) -> CGFloat {
    max(0, view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
  }

  func resetForDisconnect() {
    cancelMomentum()
    handoffActive = false
    debounceTask?.cancel(); debounceTask = nil
    refreshTask?.cancel(); refreshTask = nil
    stagingSurface?.dispose(); stagingSurface = nil
  }

  func resetAll() {
    generation += 1
    paneEpoch += 1
    resetForDisconnect()
    if isShowingLocalHistory { isShowingLocalHistory = false }
    pendingSnapshot?.surface.dispose(); pendingSnapshot = nil
    surface?.dispose(); surface = nil
    cachedPaneId = nil; currentPaneId = nil
    cachedLineCount = 0; cachedSourceCols = 0
    isReady = false; dirty = false
    lastKnownOwner = "history"; lastKnownCopyMode = false
    onVisibilityChanged?(nil, false)
    onStateChanged?()
  }

  func dispose() {
    resetAll()
    openFileRequested = nil
    openLinkRequested = nil
    onStateChanged = nil
    onVisibilityChanged = nil
  }
}
