import CoreGraphics
import RunweaveRemoteDesktopProtocol

extension RemoteDesktopSession {
    public func resetViewport() { viewportReset &+= 1 }
    func setTextEntryActive(_ value: Bool) {
        textEntryActive = value
        releaseAllInputs(reason: "keyboard focus changed")
    }

    public func click(at point: CGPoint? = nil, button: Int = 0, count: Int = 1) {
        let position = point ?? cursor
        cursor = position
        for index in 1...max(1, min(count, 2)) {
            sendInput(.init(kind: .pointerDown, x: Double(position.x), y: Double(position.y), button: button == 0 ? 0 : 1, clickCount: index))
            sendInput(.init(kind: .pointerUp, x: Double(position.x), y: Double(position.y), button: button == 0 ? 0 : 1, clickCount: index))
        }
    }
    public func pointerButton(down: Bool, at point: CGPoint, button: Int) {
        cursor = point
        sendInput(.init(kind: down ? .pointerDown : .pointerUp, x: Double(point.x), y: Double(point.y), button: button == 0 ? 0 : 1))
    }
    public func movePointer(to point: CGPoint, dragging: Bool = false) {
        cursor = point
        sendInput(.init(kind: .pointerMove, x: Double(point.x), y: Double(point.y), button: dragging ? 0 : nil))
    }
    public func scroll(at point: CGPoint, deltaX: CGFloat, deltaY: CGFloat) {
        cursor = point
        sendInput(.init(kind: .scroll, x: Double(point.x), y: Double(point.y), deltaX: Double(deltaX), deltaY: Double(deltaY)))
    }
    public func sendText(_ text: String) {
        guard !text.isEmpty, text.utf8.count <= 4096 else { return }
        sendInput(.init(kind: .text, text: text))
    }
    public func sendKey(down: Bool, code: UInt16, modifiers: RemoteModifiers = []) {
        sendInput(.init(kind: down ? .keyDown : .keyUp, keyCode: code, modifiers: UInt8(modifiers.rawValue & 15)))
    }
    public func sendKeyChord(code: UInt16, modifiers: RemoteModifiers = []) {
        let keys: [(RemoteModifiers, UInt16)] = [(.shift, 56), (.control, 59), (.option, 58), (.command, 55)]
        for (flag, key) in keys where modifiers.contains(flag) { sendKey(down: true, code: key, modifiers: modifiers) }
        sendKey(down: true, code: code, modifiers: modifiers); sendKey(down: false, code: code, modifiers: modifiers)
        for (flag, key) in keys.reversed() where modifiers.contains(flag) { sendKey(down: false, code: key) }
    }

}
