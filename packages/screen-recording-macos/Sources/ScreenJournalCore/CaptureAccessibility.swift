import AppKit
import ApplicationServices
import CryptoKit

struct CaptureAXText: Codable, Equatable {
    let key: String
    let role: String
    let text: String
}
struct CaptureAXDelta: Codable, Equatable {
    let kind: String
    let baseCaptureID: String?
    let baseHash: String?
    let contentHash: String
    let texts: [CaptureAXText]
    let removed: [String]
    let truncated: Bool
}
struct CaptureAXSnapshot: Codable {
    let texts: [CaptureAXText]
    let truncated: Bool
    var contentHash: String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return captureAXHash(String(decoding: (try? encoder.encode(texts)) ?? Data(), as: UTF8.self))
    }
}

/// Checkpoints never cross a session, window/document, privacy or unavailable boundary.
struct CaptureAXCheckpoint {
    let identity: String
    let captureID: String
    let snapshot: CaptureAXSnapshot
    static func delta(_ next: CaptureAXSnapshot, identity: String, previous: Self?) -> CaptureAXDelta {
        if let previous, previous.identity == identity, previous.snapshot.truncated == next.truncated,
           previous.snapshot.contentHash == next.contentHash {
            // Identical observed subsets can be reused even when incomplete.
            // truncated still forbids inferring anything about unread controls.
            return CaptureAXDelta(kind: "unchanged", baseCaptureID: previous.captureID,
                baseHash: previous.snapshot.contentHash, contentHash: next.contentHash, texts: [], removed: [], truncated: next.truncated)
        }
        guard let previous, previous.identity == identity, !previous.snapshot.truncated, !next.truncated else {
            return CaptureAXDelta(kind: "baseline", baseCaptureID: nil, baseHash: nil, contentHash: next.contentHash,
                texts: next.texts, removed: [], truncated: next.truncated)
        }
        let old = Dictionary(uniqueKeysWithValues: previous.snapshot.texts.map { ($0.key, $0) })
        let keys = Set(next.texts.map(\.key))
        let changed = next.texts.filter { old[$0.key] != $0 }
        let removed = old.keys.filter { !keys.contains($0) }.sorted()
        return CaptureAXDelta(kind: changed.isEmpty && removed.isEmpty ? "unchanged" : "changed",
            baseCaptureID: previous.captureID, baseHash: previous.snapshot.contentHash, contentHash: next.contentHash,
            texts: changed, removed: removed, truncated: false)
    }
}

@MainActor enum CaptureAccessibilityReader {
    // No AX tree is requested without the existing OS permission. Never prompt.
    static func focusedWindow(pid: pid_t, title: String, bounds: CGRect) -> AXUIElement? {
        guard AXIsProcessTrusted() else { return nil }
        let app = AXUIElementCreateApplication(pid)
        guard let window = element(attribute(app, kAXFocusedWindowAttribute)),
              AXUIElementSetMessagingTimeout(window, 0.02) == .success,
              (attribute(window, kAXTitleAttribute) as? String).map({ String($0.prefix(512)) }) == title,
              let rect = frame(window), abs(rect.minX - bounds.minX) <= 2, abs(rect.minY - bounds.minY) <= 2,
              abs(rect.width - bounds.width) <= 2, abs(rect.height - bounds.height) <= 2 else { return nil }
        return window
    }
    static func documentURL(_ window: AXUIElement) -> String? {
        let value = attribute(window, kAXDocumentAttribute) ?? attribute(window, kAXURLAttribute)
        let raw = (value as? URL)?.absoluteString ?? (value as? String)
        return sanitizedURL(raw)
    }
    static func snapshot(_ window: AXUIElement, bounds: CGRect) -> CaptureAXSnapshot {
        let deadline = ContinuousClock.now.advanced(by: .milliseconds(150))
        let textRoles: Set<String> = ["AXStaticText", "AXTextField", "AXTextArea", "AXButton", "AXLink", "AXHeading", "AXCell"]
        var pending: [(AXUIElement, String)] = [(window, "0")], visited: [AXUIElement] = []
        var texts: [CaptureAXText] = [], bytes = 0, count = 0, truncated = false
        while let (node, position) = pending.popLast() {
            guard count < 128, ContinuousClock.now < deadline else { truncated = true; break }
            guard !visited.contains(where: { CFEqual($0, node) }) else { continue }; visited.append(node); count += 1
            func read(_ key: String) -> CFTypeRef? {
                guard ContinuousClock.now < deadline else { truncated = true; return nil }
                _ = AXUIElementSetMessagingTimeout(node, 0.02)
                var value: CFTypeRef?
                let result = AXUIElementCopyAttributeValue(node, key as CFString, &value)
                if ![AXError.success, .attributeUnsupported, .noValue].contains(result) { truncated = true }
                return result == .success ? value : nil
            }
            if read("AXHidden") as? Bool == true { continue }
            guard let role = read(kAXRoleAttribute) as? String else { truncated = true; continue }
            let subrole = read(kAXSubroleAttribute) as? String ?? ""
            if subrole == "AXSecureTextField" || role == "AXSecureTextField" { continue }
            let nodeBounds = frame(node)
            if let nodeBounds, !nodeBounds.intersects(bounds) { continue }
            if textRoles.contains(role), nodeBounds == nil { truncated = true }
            let title = read(kAXTitleAttribute) as? String ?? ""
            let label = read(kAXDescriptionAttribute) as? String ?? ""
            let sensitive = (title + " " + label).lowercased()
            if ["password", "passcode", "secret", "api key", "access token", "密码", "口令", "密钥", "令牌"].contains(where: { sensitive.contains($0) }) { continue }
            if textRoles.contains(role), nodeBounds != nil {
                var value = ""
                if role == "AXTextArea" {
                    // Never request an entire editor/terminal buffer. Restrict AX
                    // text to a bounded portion of the currently visible range.
                    if let raw = read(kAXVisibleCharacterRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() {
                        var range = CFRange()
                        if AXValueGetValue(unsafeBitCast(raw, to: AXValue.self), .cfRange, &range), range.location >= 0, range.length >= 0 {
                            if range.length > 1024 { truncated = true }; range.length = min(range.length, 1024)
                            if let parameter = AXValueCreate(.cfRange, &range), ContinuousClock.now < deadline {
                                var result: CFTypeRef?
                                if AXUIElementCopyParameterizedAttributeValue(node, kAXStringForRangeParameterizedAttribute as CFString, parameter, &result) == .success {
                                    value = result as? String ?? ""
                                } else { truncated = true }
                            }
                        } else { truncated = true }
                    } else { truncated = true }
                } else { value = read(kAXValueAttribute) as? String ?? "" }
                let parts = [title, label, value].filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                let clean = redact(Array(NSOrderedSet(array: parts)) as? [String] ?? [])
                if clean.count > 1024 { truncated = true }
                let bounded = String(clean.prefix(1024))
                if !bounded.isEmpty {
                    guard bytes + bounded.utf8.count <= 8192 else { truncated = true; break }
                    bytes += bounded.utf8.count
                    texts.append(CaptureAXText(key: captureAXHash(position + ":" + role), role: role, text: bounded))
                }
            }
            var childValues: CFArray?
            if ContinuousClock.now < deadline {
                var childCount: CFIndex = 0
                var result = AXUIElementGetAttributeValueCount(node, kAXChildrenAttribute as CFString, &childCount)
                if result == .success, childCount > 0, ContinuousClock.now < deadline {
                    result = AXUIElementCopyAttributeValues(node, kAXChildrenAttribute as CFString, 0, min(129, childCount), &childValues)
                }
                if ![AXError.success, .attributeUnsupported, .noValue].contains(result) { truncated = true }
            }
            let children = childValues as? [AXUIElement] ?? []
            if children.count > 128 { truncated = true }
            for (index, child) in children.prefix(128).enumerated().reversed() { pending.append((child, position + "." + String(index))) }
        }
        return CaptureAXSnapshot(texts: texts, truncated: truncated || ContinuousClock.now >= deadline)
    }
    private static func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
        guard AXUIElementSetMessagingTimeout(element, 0.02) == .success else { return nil }
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success ? value : nil
    }
    private static func element(_ value: CFTypeRef?) -> AXUIElement? {
        guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }
    private static func frame(_ node: AXUIElement) -> CGRect? {
        guard let point = attribute(node, kAXPositionAttribute), let dimensions = attribute(node, kAXSizeAttribute),
              CFGetTypeID(point) == AXValueGetTypeID(), CFGetTypeID(dimensions) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(unsafeBitCast(point, to: AXValue.self), .cgPoint, &origin),
              AXValueGetValue(unsafeBitCast(dimensions, to: AXValue.self), .cgSize, &size) else { return nil }
        return CGRect(origin: origin, size: size)
    }
    private static func redact(_ parts: [String]) -> String {
        let clean = parts.joined(separator: "\n")
            .replacingOccurrences(of: "(?i)(Bearer\\s+)[A-Za-z0-9._~+/-]{16,}", with: "$1[REDACTED]", options: .regularExpression)
            .replacingOccurrences(of: "\\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\\b", with: "[REDACTED]", options: .regularExpression)
            .replacingOccurrences(of: "(?i)((?:token|password|secret|api_key)[\\\"']?\\s*[:=]\\s*)[\\\"']([^\\\"'\\r\\n]{8,})[\\\"']", with: "$1\"[REDACTED]\"", options: .regularExpression)
        // Apply the URL privacy rule to address/link text as well as context.url.
        let result = NSMutableString(string: clean)
        let expression = try? NSRegularExpression(pattern: "https?://[^\\s<>\\\"']+", options: [.caseInsensitive])
        for match in (expression?.matches(in: clean, range: NSRange(location: 0, length: result.length)) ?? []).reversed() {
            result.replaceCharacters(in: match.range, with: sanitizedURL(result.substring(with: match.range)) ?? "[URL]")
        }
        return result as String
    }
    private static func sanitizedURL(_ raw: String?) -> String? {
        guard let raw, raw.utf8.count <= 4096, var url = URLComponents(string: raw),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { return nil }
        url.user = nil; url.password = nil; url.query = nil; url.fragment = nil
        return url.string
    }
}

private func captureAXHash(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
