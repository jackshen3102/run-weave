// Gesture structure adapted from Mirador InputCaptureView.swift,
// backing-layer hosting from its VideoSurface.swift,
// 4cc5c0faddcf4ed87599fbd7cba96e5d9bd4285d, Copyright (c) 2026 Arnab Saha.
// MIT license: ThirdParty/Mirador-LICENSE.txt.
import SwiftUI
import UIKit
import AVFoundation
import GameController

struct RemoteNativeSurface: UIViewRepresentable {
    @ObservedObject var session: RemoteDesktopSession
    func makeUIView(context: Context) -> RemoteSurfaceUIView { RemoteSurfaceUIView(session: session) }
    func updateUIView(_ view: RemoteSurfaceUIView, context: Context) { view.update(session) }
    static func dismantleUIView(_ view: RemoteSurfaceUIView, coordinator: ()) { view.detach() }
}

@MainActor
private final class RemoteVideoUIView: UIView {
    override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }
    var displayLayer: AVSampleBufferDisplayLayer { layer as! AVSampleBufferDisplayLayer }
}

/// Owns the display layer. All attachments, enqueues and removal occur on MainActor.
@MainActor
final class RemoteSurfaceUIView: UIView, UIGestureRecognizerDelegate {
    private weak var session: RemoteDesktopSession?
    private let ownerID = UUID()
    private let videoView = RemoteVideoUIView()
    private var videoLayer: AVSampleBufferDisplayLayer { videoView.displayLayer }
    private let cursorLayer = CAShapeLayer()
    private var geometry: RemoteDisplayGeometry?
    private var inputMode: RemoteInputMode = .trackpad
    private var zoom: CGFloat = 1
    private var offset: CGPoint = .zero
    private var cursor = CGPoint(x: 0.5, y: 0.5)
    private var dragging = false
    private var pinch: UIPinchGestureRecognizer!
    private var pan: UIPanGestureRecognizer!
    private var hold: UILongPressGestureRecognizer!
    private var scroll: UIPanGestureRecognizer!
    private var viewportPan: UIPanGestureRecognizer!
    private var viewportReset: UInt64 = 0
    private var previousViewportSize: CGSize = .zero
    private var inputContext: RemoteSessionContext?
    private var heldHardwareKeys: [Int: UInt16] = [:]
    private var displayReadyObserver: NSObjectProtocol?

    init(session: RemoteDesktopSession) {
        super.init(frame: .zero)
        backgroundColor = .black; clipsToBounds = true
        videoView.backgroundColor = .black
        videoView.isUserInteractionEnabled = false // Gestures remain on the outer surface.
        videoLayer.videoGravity = .resize
        // This prevents ordinary capture of the layer; the host must also mask
        // the full presentation in its analytics SDK, including text and pairing.
        videoLayer.preventsCapture = true
        addSubview(videoView)
        if #available(iOS 17.4, *) {
            displayReadyObserver = NotificationCenter.default.addObserver(
                forName: .AVSampleBufferDisplayLayerReadyForDisplayDidChange, object: videoLayer, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.session?.displayReadinessChanged(ownerID: self.ownerID)
                }
            }
        }
        cursorLayer.strokeColor = UIColor.white.cgColor
        cursorLayer.fillColor = UIColor.black.cgColor
        cursorLayer.lineWidth = 1.5
        cursorLayer.path = UIBezierPath(ovalIn: CGRect(x: -5, y: -5, width: 10, height: 10)).cgPath
        layer.addSublayer(cursorLayer)
        installGestures()
        update(session)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    deinit { if let displayReadyObserver { NotificationCenter.default.removeObserver(displayReadyObserver) } }
    override var canBecomeFirstResponder: Bool { true }
    override var inputView: UIView? { UIView(frame: .zero) }

    func update(_ newSession: RemoteDesktopSession) {
        if session !== newSession {
            session?.detachDisplayLayer(ownerID: ownerID)
            session = newSession
            newSession.attachDisplayLayer(videoLayer, ownerID: ownerID)
        }
        if geometry != newSession.geometry || inputMode != newSession.inputMode || inputContext != newSession.context {
            cancelDrag()
            releaseHardwareKeys()
            // Cancel a tap/hold that began on the previous target or geometry;
            // its eventual completion must not become an input for a new Mac.
            for recognizer in gestureRecognizers ?? [] { recognizer.isEnabled = false; recognizer.isEnabled = true }
            inputContext = newSession.context
            geometry = newSession.geometry; inputMode = newSession.inputMode
            zoom = 1; offset = .zero; cursor = CGPoint(x: 0.5, y: 0.5)
        }
        if viewportReset != newSession.viewportReset {
            viewportReset = newSession.viewportReset; zoom = 1; offset = .zero
        }
        if newSession.state != .controllable || newSession.textEntryActive { cancelDrag(); resignFirstResponder() }
        else if GCKeyboard.coalesced != nil, !isFirstResponder { becomeFirstResponder() }
        setNeedsLayout()
    }

    func detach() {
        cancelDrag(); resignFirstResponder()
        session?.detachDisplayLayer(ownerID: ownerID)
        videoLayer.flushRemoteVideo(); session = nil
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        reportSurface()
    }

    private func reportSurface() {
        session?.updateDisplaySurface(ownerID: ownerID, inWindow: window != nil && !isHidden && alpha > 0,
                                      viewportSize: bounds.size)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if previousViewportSize != bounds.size {
            cancelDrag(); zoom = 1; offset = .zero; previousViewportSize = bounds.size
        }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        videoView.frame = videoRect
        let content = contentRect
        cursorLayer.position = CGPoint(x: content.minX + cursor.x * content.width,
                                       y: content.minY + cursor.y * content.height)
        cursorLayer.isHidden = session?.state != .controllable || inputMode != .trackpad
        CATransaction.commit()
        reportSurface()
    }

    private var videoRect: CGRect {
        guard let geometry, geometry.isValid, bounds.width > 0, bounds.height > 0 else { return bounds }
        let fit = AVMakeRect(aspectRatio: geometry.pixelSize, insideRect: bounds)
        let width = fit.width * zoom, height = fit.height * zoom
        let maxX = max(0, (width - bounds.width) / 2), maxY = max(0, (height - bounds.height) / 2)
        offset.x = min(max(offset.x, -maxX), maxX); offset.y = min(max(offset.y, -maxY), maxY)
        return CGRect(x: bounds.midX - width / 2 + offset.x, y: bounds.midY - height / 2 + offset.y,
                      width: width, height: height)
    }

    private var contentRect: CGRect {
        guard let geometry, geometry.isValid else { return .zero }
        let video = videoRect
        return CGRect(x: video.minX + geometry.contentRect.minX / geometry.pixelSize.width * video.width,
                      y: video.minY + geometry.contentRect.minY / geometry.pixelSize.height * video.height,
                      width: geometry.contentRect.width / geometry.pixelSize.width * video.width,
                      height: geometry.contentRect.height / geometry.pixelSize.height * video.height)
    }

    private func normalized(_ point: CGPoint, clamped: Bool = false) -> CGPoint? {
        let rect = contentRect
        guard rect.width > 0, rect.height > 0 else { return nil }
        let x = (point.x - rect.minX) / rect.width, y = (point.y - rect.minY) / rect.height
        guard clamped || (x >= 0 && x <= 1 && y >= 0 && y <= 1) else { return nil }
        return CGPoint(x: min(max(x, 0), 1), y: min(max(y, 0), 1))
    }

    private func installGestures() {
        let tap = UITapGestureRecognizer(target: self, action: #selector(singleTap(_:)))
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        tap.require(toFail: doubleTap)
        pan = UIPanGestureRecognizer(target: self, action: #selector(movePointerGesture(_:)))
        pan.maximumNumberOfTouches = 1; pan.delegate = self
        hold = UILongPressGestureRecognizer(target: self, action: #selector(drag(_:)))
        hold.minimumPressDuration = 0.4; hold.delegate = self
        tap.require(toFail: pan); tap.require(toFail: hold)
        doubleTap.require(toFail: pan); doubleTap.require(toFail: hold)
        scroll = UIPanGestureRecognizer(target: self, action: #selector(scrollRemote(_:)))
        scroll.minimumNumberOfTouches = 2; scroll.maximumNumberOfTouches = 2
        scroll.allowedScrollTypesMask = .all; scroll.delegate = self
        let right = UITapGestureRecognizer(target: self, action: #selector(rightTap(_:)))
        right.numberOfTouchesRequired = 2; right.require(toFail: scroll)
        pinch = UIPinchGestureRecognizer(target: self, action: #selector(zoomViewport(_:)))
        pinch.delegate = self; right.require(toFail: pinch)
        viewportPan = UIPanGestureRecognizer(target: self, action: #selector(panViewport(_:)))
        viewportPan.minimumNumberOfTouches = 3; viewportPan.maximumNumberOfTouches = 3
        for recognizer in [tap, doubleTap, pan, hold, scroll, right, pinch, viewportPan] {
            addGestureRecognizer(recognizer!)
        }
    }

    private func tapPoint(_ gesture: UIGestureRecognizer) -> CGPoint? {
        guard session?.state == .controllable, let direct = normalized(gesture.location(in: self)) else { return nil }
        return inputMode == .direct ? direct : cursor
    }
    @objc private func singleTap(_ gesture: UITapGestureRecognizer) {
        guard let point = tapPoint(gesture) else { return }
        cursor = point; session?.click(at: point, button: 0)
    }
    @objc private func doubleTap(_ gesture: UITapGestureRecognizer) {
        guard let point = tapPoint(gesture) else { return }
        cursor = point; session?.click(at: point, button: 0, count: 2)
    }
    @objc private func rightTap(_ gesture: UITapGestureRecognizer) {
        guard let point = tapPoint(gesture) else { return }
        cursor = point; session?.click(at: point, button: 2)
    }
    @objc private func movePointerGesture(_ gesture: UIPanGestureRecognizer) {
        guard session?.state == .controllable else { return }
        if gesture.state == .changed {
            if inputMode == .trackpad {
                moveCursor(gesture.translation(in: self))
            } else if let point = normalized(gesture.location(in: self), clamped: dragging) {
                cursor = point
            } else { return }
            session?.movePointer(to: cursor, dragging: dragging)
            gesture.setTranslation(.zero, in: self); setNeedsLayout()
        } else if gesture.state == .ended || gesture.state == .cancelled || gesture.state == .failed {
            cancelDrag()
        }
    }
    @objc private func drag(_ gesture: UILongPressGestureRecognizer) {
        switch gesture.state {
        case .began:
            guard let point = tapPoint(gesture) else { return }
            cursor = point; dragging = true; session?.pointerButton(down: true, at: cursor, button: 0)
        case .changed:
            if inputMode == .direct, dragging, let point = normalized(gesture.location(in: self), clamped: true) {
                cursor = point; session?.movePointer(to: cursor, dragging: true); setNeedsLayout()
            }
        case .ended, .cancelled, .failed: cancelDrag()
        default: break
        }
    }
    private func cancelDrag() {
        if dragging { session?.pointerButton(down: false, at: cursor, button: 0) }
        dragging = false
    }
    private func moveCursor(_ translation: CGPoint) {
        let rect = contentRect
        guard rect.width > 0, rect.height > 0 else { return }
        cursor.x = min(max(cursor.x + translation.x * 1.4 / rect.width, 0), 1)
        cursor.y = min(max(cursor.y + translation.y * 1.4 / rect.height, 0), 1)
        // Follow the virtual cursor so every logical corner remains reachable when zoomed.
        let position = CGPoint(x: rect.minX + cursor.x * rect.width, y: rect.minY + cursor.y * rect.height)
        let margin: CGFloat = 24
        if position.x < margin { offset.x += margin - position.x }
        if position.x > bounds.width - margin { offset.x -= position.x - bounds.width + margin }
        if position.y < margin { offset.y += margin - position.y }
        if position.y > bounds.height - margin { offset.y -= position.y - bounds.height + margin }
    }
    @objc private func scrollRemote(_ gesture: UIPanGestureRecognizer) {
        defer { gesture.setTranslation(.zero, in: self) }
        guard gesture.state == .changed, session?.state == .controllable,
              let point = normalized(gesture.location(in: self)), pinch.state != .changed else { return }
        let translation = gesture.translation(in: self)
        session?.scroll(at: inputMode == .direct ? point : cursor, deltaX: -translation.x, deltaY: -translation.y)
    }
    @objc private func zoomViewport(_ gesture: UIPinchGestureRecognizer) {
        guard gesture.state == .changed else { return }
        zoom = min(max(zoom * gesture.scale, 1), 3); gesture.scale = 1; setNeedsLayout()
    }
    @objc private func panViewport(_ gesture: UIPanGestureRecognizer) {
        guard gesture.state == .changed else { return }
        let translation = gesture.translation(in: self)
        offset.x += translation.x; offset.y += translation.y
        gesture.setTranslation(.zero, in: self); setNeedsLayout()
    }
    func gestureRecognizer(_ gesture: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        (gesture === pan && other === hold) || (gesture === hold && other === pan) ||
        (gesture === scroll && other === pinch) || (gesture === pinch && other === scroll)
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) { handle(presses, down: true) }
    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) { handle(presses, down: false) }
    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        heldHardwareKeys.removeAll()
        session?.releaseAllInputs(reason: "keyboard cancelled")
    }
    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        if result || !isFirstResponder { releaseHardwareKeys() }
        return result
    }
    private func releaseHardwareKeys() {
        guard !heldHardwareKeys.isEmpty else { return }
        heldHardwareKeys.removeAll()
        session?.releaseAllInputs(reason: "hardware keyboard focus changed")
    }
    private func handle(_ presses: Set<UIPress>, down: Bool) {
        guard session?.state == .controllable else { releaseHardwareKeys(); return }
        for press in presses {
            guard let key = press.key else { continue }
            let flags = key.modifierFlags
            var modifiers: RemoteModifiers = []
            if flags.contains(.command) { modifiers.insert(.command) }
            if flags.contains(.control) { modifiers.insert(.control) }
            if flags.contains(.alternate) { modifiers.insert(.option) }
            if flags.contains(.shift) { modifiers.insert(.shift) }
            let usage = key.keyCode.rawValue
            if !down {
                // Key-up flags may no longer contain the modifier that made
                // key-down a shortcut (e.g. release Command before C).
                if let code = heldHardwareKeys.removeValue(forKey: usage) {
                    session?.sendKey(down: false, code: code, modifiers: modifiers)
                }
                continue
            }
            if let code = RemoteHardwareKeyMap.code(key.keyCode.rawValue),
               !modifiers.subtracting(.shift).isEmpty || RemoteHardwareKeyMap.isSpecial(key.keyCode.rawValue) {
                heldHardwareKeys[usage] = code
                session?.sendKey(down: true, code: code, modifiers: modifiers)
            } else if !key.characters.isEmpty {
                session?.sendText(key.characters)
            }
        }
    }
}

enum RemoteHardwareKeyMap {
    // HID usages map to positional Mac keys only for shortcuts. Submitted text
    // is resolved by iOS and never translated with a US keyboard table.
    private static let letters: [UInt16] = [0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6]
    private static let fixed: [Int: UInt16] = [40:36, 41:53, 42:51, 43:48, 44:49, 79:124, 80:123, 81:125, 82:126,
                                            224:59, 225:56, 226:58, 227:55, 228:62, 229:60, 230:61, 231:54]
    static func code(_ usage: Int) -> UInt16? {
        if (4...29).contains(usage) { return letters[usage - 4] }
        return fixed[usage]
    }
    static func isSpecial(_ usage: Int) -> Bool { fixed[usage] != nil && usage != 44 }
    static func asciiShortcut(_ string: String) -> UInt16? {
        guard let value = string.uppercased().utf8.first, (65...90).contains(value), string.count == 1 else { return nil }
        return letters[Int(value - 65)]
    }
}
