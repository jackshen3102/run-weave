// CGEvent input primitives informed by Mirador@4cc5c0faddcf4ed87599fbd7cba96e5d9bd4285d,
// Sources/Mirador/InputEvent.swift. Copyright (c) 2026 Arnab Saha. MIT license retained.
import AppKit
import ApplicationServices
import RunweaveRemoteDesktopProtocol

final class DesktopInput: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private var leaseUntil: TimeInterval = 0
    private let watchdog: DispatchSourceTimer
    private var keys: Set<UInt16> = []
    private var buttons: Set<Int> = []
    private var position = CGPoint.zero
    private var flags = CGEventFlags()
    init() {
        watchdog = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "runweave.remote.input-lease"))
        watchdog.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
        watchdog.setEventHandler { [weak self] in self?.expireLease() }; watchdog.resume()
    }
    deinit { watchdog.cancel() }
    var pressedCount: Int { lock.lock(); defer { lock.unlock() }; return keys.count + buttons.count }
    func renewLease() { lock.lock(); leaseUntil = ProcessInfo.processInfo.systemUptime + 3; lock.unlock() }
    private func expireLease() {
        lock.lock(); defer { lock.unlock() }
        if leaseUntil > 0, leaseUntil < ProcessInfo.processInfo.systemUptime { releaseAll(); leaseUntil = 0 }
    }
    func dispatch(_ input: RemoteInput, display: RemoteDisplay) throws {
        lock.lock(); defer { lock.unlock() }
        guard leaseUntil >= ProcessInfo.processInfo.systemUptime, AXIsProcessTrusted(), input.isValid else { throw HostError.rejected("输入权限缺失、租约过期或输入无效。") }
        var flags = CGEventFlags()
        if input.modifiers & 1 != 0 { flags.insert(.maskShift) }
        if input.modifiers & 2 != 0 { flags.insert(.maskControl) }
        if input.modifiers & 4 != 0 { flags.insert(.maskAlternate) }
        if input.modifiers & 8 != 0 { flags.insert(.maskCommand) }
        // Pointer messages need not repeat a modifier held by a prior explicit keyDown.
        let held = input.kind == .keyUp ? keys.subtracting([input.keyCode!]) : input.kind == .keyDown ? keys.union([input.keyCode!]) : keys
        if !held.isDisjoint(with: [56, 60]) { flags.insert(.maskShift) }
        if !held.isDisjoint(with: [59, 62]) { flags.insert(.maskControl) }
        if !held.isDisjoint(with: [58, 61]) { flags.insert(.maskAlternate) }
        if !held.isDisjoint(with: [54, 55]) { flags.insert(.maskCommand) }
        self.flags = flags
        if let x = input.x, let y = input.y {
            let bounds = display.logicalBounds
            position = CGPoint(x: bounds.x + min(bounds.width - 1, x * bounds.width), y: bounds.y + min(bounds.height - 1, y * bounds.height))
        }
        switch input.kind {
        case .pointerMove:
            let type: CGEventType = buttons.contains(0) ? .leftMouseDragged : buttons.contains(1) ? .rightMouseDragged : .mouseMoved
            postMouse(type: type, button: buttons.contains(1) ? 1 : 0, count: 1)
        case .pointerDown:
            let button = input.button ?? 0
            guard !buttons.contains(button) else { return }; buttons.insert(button)
            postMouse(type: button == 1 ? .rightMouseDown : .leftMouseDown, button: button, count: input.clickCount ?? 1)
        case .pointerUp:
            let button = input.button ?? 0
            guard buttons.remove(button) != nil else { return }
            postMouse(type: button == 1 ? .rightMouseUp : .leftMouseUp, button: button, count: input.clickCount ?? 1)
        case .scroll:
            let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(-(input.deltaY ?? 0)), wheel2: Int32(-(input.deltaX ?? 0)), wheel3: 0)
            event?.flags = flags; event?.post(tap: .cghidEventTap)
        case .keyDown, .keyUp:
            let code = input.keyCode!
            if input.kind == .keyDown { keys.insert(code) } else { guard keys.remove(code) != nil else { return } }
            let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: input.kind == .keyDown)
            event?.flags = flags; event?.post(tap: .cghidEventTap)
        case .text:
            let utf16 = Array(input.text!.utf16)
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
                utf16.withUnsafeBufferPointer { event?.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
                event?.post(tap: .cghidEventTap)
            }
        }
    }
    private func postMouse(type: CGEventType, button: Int, count: Int) {
        let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: position, mouseButton: button == 1 ? .right : .left)
        event?.flags = flags; event?.setIntegerValueField(.mouseEventClickState, value: Int64(count)); event?.post(tap: .cghidEventTap)
    }
    func releaseAll() {
        lock.lock(); defer { lock.unlock() }
        flags = []
        for code in keys {
            let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
            event?.flags = []; event?.post(tap: .cghidEventTap)
        }
        for button in buttons { postMouse(type: button == 1 ? .rightMouseUp : .leftMouseUp, button: button, count: 1) }
        keys.removeAll(); buttons.removeAll()
    }
}
