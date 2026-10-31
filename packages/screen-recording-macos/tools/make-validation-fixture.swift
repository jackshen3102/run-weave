// Build only as ScreenJournalFixture. Synthetic media, never a screen capture.
import Foundation
import CoreGraphics
import CryptoKit

@main struct ValidationFixture {
    static func main() async {
        do {
            #if DEBUG
            umask(0o077)
            let args = Array(CommandLine.arguments.dropFirst())
            guard args.count == 4, args[0] == "--data-dir", args[2] == "--scenario",
                  ["retention", "quota", "recovery", "deleting", "availability", "newer-schema"].contains(args[3]) else {
                throw journalError("usage: ScreenJournalFixture --data-dir NEW_EMPTY_DIRECTORY --scenario retention|quota|recovery|deleting|availability|newer-schema")
            }
            let paths = try StorePaths(root: URL(fileURLWithPath: args[1]), validation: true)
            if FileManager.default.fileExists(atPath: paths.root.path) {
                guard try FileManager.default.contentsOfDirectory(atPath: paths.root.path).isEmpty else { throw journalError("fixture_requires_empty_directory") }
            }
            try paths.prepare()
            let lock = try InstanceLock(paths: paths)
            defer { withExtendedLifetime(lock) {} }
            let db = try RecordStore(paths: paths)
            try paths.write(RecordingSettings(), to: "settings.json")
            let store = FrameStore(database: db)
            let session = UUID().uuidString
            try db.execute("INSERT INTO sessions(id,started,ended,clean) VALUES (?,?,?,1)", [session, Date().timeIntervalSince1970 - 8 * 86400, Date().timeIntervalSince1970])
            var resources: [[String: Any]] = []
            for number in 0..<4 {
                let age: Double = args[3] == "retention" || args[3] == "availability" ? [8 * 86400, 7 * 86400 + 10, 3600, 60][number] : Double(3600 - number * 60)
                let start = Date().addingTimeInterval(-age)
                let context = CGContext(data: nil, width: 320, height: 180, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
                var captureIDs: [String] = []
                for frame in 0..<3 {
                    context.setFillColor(CGColor(red: CGFloat(number + 1) / 4, green: CGFloat(frame) / 3, blue: 0.35, alpha: 1))
                    context.fill(CGRect(x: 0, y: 0, width: 320, height: 180))
                    context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(CGRect(x: 20 + frame * 50, y: 20, width: 25, height: 100))
                    let id = UUID().uuidString
                    let metadata = CaptureMetadata(id: id, sessionID: session, sequence: number * 3 + frame,
                        capturedAt: start.addingTimeInterval(Double(frame * 10)), timezoneOffset: 0, displayID: 999,
                        applicationID: "com.runweave.synthetic-fixture", idleSeconds: Double(frame * 10), privacyPlaceholder: false)
                    var accepted = false
                    for _ in 0..<100 {
                        if try store.append(context.makeImage()!, metadata: metadata) != nil { accepted = true; break }
                        try await Task.sleep(for: .milliseconds(20))
                    }
                    guard accepted else { throw journalError("fixture_encoder_busy") }
                    captureIDs.append(id)
                }
                try await store.finalize()
                guard let segment = try db.segments().first(where: { abs($0.start - start.timeIntervalSince1970) < 0.01 }) else { throw journalError("fixture_segment_missing") }
                let file = try paths.file(segment.path)
                let digest = SHA256.hash(data: try Data(contentsOf: file)).map { String(format: "%02x", $0) }.joined()
                if args[3] == "deleting" && number < 2 {
                    try db.execute("UPDATE segments SET state='deleting' WHERE id=?", [segment.id])
                    if number == 1 { try FileManager.default.removeItem(at: file) }
                }
                if (args[3] == "recovery" || args[3] == "availability") && number == 3 {
                    let pending = try paths.file("pending/\(segment.id).mp4")
                    try FileManager.default.moveItem(at: file, to: pending)
                    try db.execute("UPDATE segments SET state='writing',path=? WHERE id=?", ["pending/\(segment.id).mp4", segment.id])
                    if args[3] == "recovery" { try Data("interrupted synthetic segment".utf8).write(to: pending) }
                }
                resources.append(["segmentID": segment.id, "captureIDs": captureIDs, "started": start.timeIntervalSince1970,
                    "sha256BeforeFault": digest, "synthetic": true, "frameDescription": "RGB background, moving white bar; three frames"])
            }
            if args[3] == "newer-schema" { try db.execute("PRAGMA user_version=2") }
            try db.checkpoint()
            let manifest: [String: Any] = ["scenario": args[3], "synthetic": true, "resources": resources]
            let data = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: paths.file("fixture-manifest.json"), options: .withoutOverwriting)
            print(String(decoding: data, as: UTF8.self))
            #else
            throw journalError("fixture_disabled_in_release")
            #endif
        } catch { fputs("\(error.localizedDescription)\n", stderr); exit(1) }
    }
}
