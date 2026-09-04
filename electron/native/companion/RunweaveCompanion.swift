import AppKit
import Foundation
import WebKit

private let minimumSize = NSSize(width: 86, height: 86)
private let maximumSize = NSSize(width: 410, height: 480)
private let initialInset: CGFloat = 16

private final class CompanionPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private struct PersistedWindowState: Codable {
    let version: Int
    let displayId: UInt32
    let right: Double
    let bottom: Double
}

private final class StandardOutputWriter {
    private let lock = NSLock()

    func send(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else {
            return
        }
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}

private final class FrontendSchemeHandler: NSObject, WKURLSchemeHandler {
    var root: URL?

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url,
              requestURL.host == "app",
              let root else {
            fail(urlSchemeTask, code: .fileNoSuchFile)
            return
        }
        let decodedPath = requestURL.path.removingPercentEncoding ?? requestURL.path
        let relativePath = decodedPath == "/" ? "companion.html" : String(decodedPath.dropFirst())
        let rootPath = root.standardizedFileURL.path
        let fileURL = root.appendingPathComponent(relativePath).standardizedFileURL
        guard fileURL.path == rootPath || fileURL.path.hasPrefix(rootPath + "/"),
              let data = try? Data(contentsOf: fileURL) else {
            fail(urlSchemeTask, code: .fileNoSuchFile)
            return
        }
        let response = URLResponse(
            url: requestURL,
            mimeType: mimeType(for: fileURL.pathExtension),
            expectedContentLength: data.count,
            textEncodingName: isTextExtension(fileURL.pathExtension) ? "utf-8" : nil
        )
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func fail(_ task: WKURLSchemeTask, code: CocoaError.Code) {
        task.didFailWithError(CocoaError(code))
    }

    private func isTextExtension(_ ext: String) -> Bool {
        ["css", "html", "js", "json", "map", "svg", "txt"].contains(ext.lowercased())
    }

    private func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "css": return "text/css"
        case "html": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "json", "map": return "application/json"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg": return "image/svg+xml"
        case "webp": return "image/webp"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        default: return "application/octet-stream"
        }
    }
}

private final class CompanionController: NSObject, NSApplicationDelegate,
    WKNavigationDelegate, WKScriptMessageHandler {
    private let output = StandardOutputWriter()
    private let schemeHandler = FrontendSchemeHandler()
    private var panel: CompanionPanel!
    private var webView: WKWebView!
    private var statePath: URL?
    private var pendingPresentation: [String: Any]?
    private var webContentReady = false
    private var dragStart: (pointer: NSPoint, origin: NSPoint)?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        createPanel()
        observeScreenChanges()
        startReadingCommands()
        output.send(["type": "ready", "pid": ProcessInfo.processInfo.processIdentifier])
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func createPanel() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(self, name: "runweave")
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: "runweave-companion")

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        let initialFrame = defaultFrame(size: maximumSize)
        panel = CompanionPanel(
            contentRect: initialFrame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.contentView = webView
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isExcludedFromWindowsMenu = true
        panel.acceptsMouseMovedEvents = true
        panel.animationBehavior = .none
        panel.level = .floating
        panel.collectionBehavior = [
            .canJoinAllApplications,
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .transient,
            .ignoresCycle,
        ]
    }

    private func startReadingCommands() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while let line = readLine() {
                guard let data = line.data(using: .utf8),
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    continue
                }
                DispatchQueue.main.async { self?.handleCommand(object) }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    private func handleCommand(_ command: [String: Any]) {
        switch command["type"] as? String {
        case "bootstrap":
            bootstrap(command)
        case "presentation":
            guard let presentation = command["presentation"] as? [String: Any] else { return }
            pendingPresentation = presentation
            deliverPresentationIfReady()
        case "openResult":
            guard let commandId = command["commandId"] as? String,
                  let result = command["result"] as? [String: Any] else { return }
            deliverToWeb(["type": "openResult", "commandId": commandId, "result": result])
        case "shutdown":
            NSApp.terminate(nil)
        default:
            break
        }
    }

    private func bootstrap(_ command: [String: Any]) {
        if let rawStatePath = command["statePath"] as? String {
            statePath = URL(fileURLWithPath: rawStatePath)
            restoreWindowState()
        }
        guard let frontend = command["frontend"] as? [String: Any],
              let kind = frontend["kind"] as? String else { return }
        if kind == "dev", let rawURL = frontend["url"] as? String,
           let url = URL(string: rawURL) {
            webView.load(URLRequest(url: url))
            return
        }
        if kind == "bundle", let root = frontend["root"] as? String {
            schemeHandler.root = URL(fileURLWithPath: root, isDirectory: true)
            let url = URL(string: "runweave-companion://app/companion.html")!
            webView.load(URLRequest(url: url))
        }
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "runweave",
              let command = message.body as? [String: Any],
              let type = command["type"] as? String else { return }
        switch type {
        case "ready":
            webContentReady = true
            deliverPresentationIfReady()
            panel.orderFrontRegardless()
            output.send(["type": "webReady"])
        case "resize":
            guard let width = number(command["width"]),
                  let height = number(command["height"]) else { return }
            resize(width: width, height: height)
        case "drag":
            guard let request = command["request"] as? [String: Any],
                  let phase = request["phase"] as? String else { return }
            drag(phase: phase)
        case "openSlot":
            guard let commandId = command["commandId"] as? String,
                  let intent = command["intent"] as? [String: Any] else { return }
            output.send(["type": "openSlot", "commandId": commandId, "intent": intent])
        default:
            break
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let allowed = url.scheme == "runweave-companion" ||
            url.host == "127.0.0.1" || url.host == "localhost"
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        output.send(["type": "navigationError", "message": error.localizedDescription])
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        output.send(["type": "navigationError", "message": error.localizedDescription])
    }

    private func deliverPresentationIfReady() {
        guard webContentReady, let presentation = pendingPresentation else { return }
        deliverToWeb(["type": "presentation", "presentation": presentation])
    }

    private func deliverToWeb(_ event: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(event),
              let data = try? JSONSerialization.data(withJSONObject: event) else { return }
        let encoded = data.base64EncodedString()
        let script = """
        window.runweaveCompanionReceive?.(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('\(encoded)'), c => c.charCodeAt(0)))))
        """
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                self.output.send(["type": "scriptError", "message": error.localizedDescription])
            }
        }
    }

    private func resize(width: CGFloat, height: CGFloat) {
        let size = NSSize(
            width: min(max(ceil(width), minimumSize.width), maximumSize.width),
            height: min(max(ceil(height), minimumSize.height), maximumSize.height)
        )
        let current = panel.frame
        let requested = NSRect(
            x: current.maxX - size.width,
            y: current.minY,
            width: size.width,
            height: size.height
        )
        panel.setFrame(fitToVisibleScreen(requested), display: false)
    }

    private func drag(phase: String) {
        if phase == "start" {
            dragStart = (NSEvent.mouseLocation, panel.frame.origin)
            return
        }
        guard let start = dragStart else { return }
        if phase == "end" {
            dragStart = nil
            saveWindowState()
            return
        }
        guard phase == "move" else { return }
        let pointer = NSEvent.mouseLocation
        let requested = NSRect(
            origin: NSPoint(
                x: start.origin.x + pointer.x - start.pointer.x,
                y: start.origin.y + pointer.y - start.pointer.y
            ),
            size: panel.frame.size
        )
        panel.setFrame(fitToVisibleScreen(requested, pointer: pointer), display: false)
    }

    private func observeScreenChanges() {
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.panel.setFrame(self.fitToVisibleScreen(self.panel.frame), display: false)
            self.saveWindowState()
            self.panel.orderFrontRegardless()
        }
    }

    private func defaultFrame(size: NSSize) -> NSRect {
        let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ??
            NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSRect(
            x: visible.maxX - size.width - initialInset,
            y: visible.minY + initialInset,
            width: size.width,
            height: size.height
        )
    }

    private func fitToVisibleScreen(_ frame: NSRect, pointer: NSPoint? = nil) -> NSRect {
        let screen = pointer.flatMap(screenContaining) ?? screenMatching(frame) ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return frame }
        let width = min(frame.width, visible.width)
        let height = min(frame.height, visible.height)
        return NSRect(
            x: min(max(frame.minX, visible.minX), visible.maxX - width),
            y: min(max(frame.minY, visible.minY), visible.maxY - height),
            width: width,
            height: height
        )
    }

    private func screenContaining(_ point: NSPoint) -> NSScreen? {
        NSScreen.screens.first { NSMouseInRect(point, $0.frame, false) }
    }

    private func screenMatching(_ frame: NSRect) -> NSScreen? {
        NSScreen.screens.max { lhs, rhs in
            lhs.frame.intersection(frame).area < rhs.frame.intersection(frame).area
        }
    }

    private func displayId(for screen: NSScreen) -> UInt32? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }

    private func restoreWindowState() {
        guard let statePath,
              let data = try? Data(contentsOf: statePath),
              let state = try? JSONDecoder().decode(PersistedWindowState.self, from: data),
              state.version == 2,
              let screen = NSScreen.screens.first(where: { displayId(for: $0) == state.displayId }) else {
            return
        }
        let size = panel.frame.size
        let requested = NSRect(
            x: CGFloat(state.right) - size.width,
            y: CGFloat(state.bottom),
            width: size.width,
            height: size.height
        )
        panel.setFrame(fitToVisibleScreen(requested, pointer: screen.frame.center), display: false)
    }

    private func saveWindowState() {
        guard let statePath,
              let screen = screenMatching(panel.frame),
              let displayId = displayId(for: screen) else { return }
        let state = PersistedWindowState(
            version: 2,
            displayId: displayId,
            right: Double(panel.frame.maxX),
            bottom: Double(panel.frame.minY)
        )
        guard let data = try? JSONEncoder().encode(state) else { return }
        do {
            try FileManager.default.createDirectory(
                at: statePath.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let temporary = statePath.appendingPathExtension("tmp")
            try data.write(to: temporary, options: .atomic)
            _ = try FileManager.default.replaceItemAt(statePath, withItemAt: temporary)
        } catch {
            try? data.write(to: statePath, options: .atomic)
        }
    }

    private func number(_ value: Any?) -> CGFloat? {
        (value as? NSNumber).map { CGFloat(truncating: $0) }
    }
}

private extension NSRect {
    var area: CGFloat { max(0, width) * max(0, height) }
    var center: NSPoint { NSPoint(x: midX, y: midY) }
}

@main
private struct RunweaveCompanionApplication {
    static func main() {
        let application = NSApplication.shared
        let delegate = CompanionController()
        application.delegate = delegate
        application.run()
        _ = delegate
    }
}
