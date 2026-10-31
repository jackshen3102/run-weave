// Build only as ScreenJournalFixture. Synthetic media, never a screen capture.
import Foundation
import CoreGraphics
import CryptoKit
import AppKit
import CoreText

@main struct ValidationFixture {
    static func main() async {
        do {
            #if DEBUG
            umask(0o077)
            let args = Array(CommandLine.arguments.dropFirst())
            guard args.count == 4, args[0] == "--data-dir", args[2] == "--scenario",
                  ["retention", "quota", "recovery", "deleting", "availability", "newer-schema", "playback"].contains(args[3]) else {
                throw journalError("usage: ScreenJournalFixture --data-dir NEW_EMPTY_DIRECTORY --scenario retention|quota|recovery|deleting|availability|newer-schema|playback")
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
            if args[3] == "playback" {
                try await playback(paths: paths, db: db, store: store)
                return
            }
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
    // A deterministic, visibly numbered sequence. No screen content is read.
    static func playback(paths: StorePaths, db: RecordStore, store: FrameStore) async throws {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "Europe/Berlin")!
        let base = floor(Date().addingTimeInterval(-2 * 86400).timeIntervalSince1970 / 900) * 900
        var records: [[String: Any]] = []
        let session = UUID().uuidString
        try db.execute("INSERT INTO sessions(id,started,ended,clean) VALUES (?,?,?,1)", [session, base, base + 1300])
        let offsets: [Double] = [0, 10, 20, 30, 40, 50, 60, 70, 70, 80, 170, 180, 190, 200, 150, 160, 170, 180]
        for number in 0..<138 {
            let time = number < offsets.count ? base + offsets[number] : base + 300 + Double(number - offsets.count) * 5
            let display: UInt32 = number < offsets.count ? 999 : UInt32(1000 + number % 2)
            let privateFrame = number == 3 || number == 4
            let context = CGContext(data: nil, width: 960, height: 540, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
            context.setFillColor(CGColor(red: 0.08, green: CGFloat(number % 8) / 12, blue: 0.3, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: 960, height: 540))
            context.setStrokeColor(CGColor(gray: 1, alpha: 1)); context.setLineWidth(5)
            context.stroke(CGRect(x: 5, y: 5, width: 950, height: 530))
            for (text, x, y) in [("TL", 20.0, 490.0), ("TR", 865.0, 490.0), ("BL", 20.0, 20.0), ("BR", 865.0, 20.0),
                (privateFrame ? "PRIVATE" : String(format: "FRAME %03d", number), 270.0, 270.0)] {
                let string = NSAttributedString(string: text, attributes: [.font: NSFont.monospacedSystemFont(ofSize: 48, weight: .bold), .foregroundColor: NSColor.white])
                context.textPosition = CGPoint(x: x, y: y); CTLineDraw(CTLineCreateWithAttributedString(string), context)
            }
            let id = UUID().uuidString
            let metadata = CaptureMetadata(id: id, sessionID: session, sequence: number, capturedAt: Date(timeIntervalSince1970: time),
                timezoneOffset: calendar.timeZone.secondsFromGMT(for: Date(timeIntervalSince1970: time)), displayID: display,
                applicationID: privateFrame ? nil : "com.runweave.synthetic-fixture", idleSeconds: 0, privacyPlaceholder: privateFrame)
            let image = context.makeImage()!
            try await store.prepareAppend(image, displayID: display)
            var accepted = false
            for _ in 0..<100 {
                if try store.append(image, metadata: metadata) != nil { accepted = true; break }
                try await Task.sleep(for: .milliseconds(20))
            }
            guard accepted else { throw journalError("fixture_encoder_busy") }
            records.append(["id": id, "sequence": number, "capturedAtMs": Int64(time * 1000), "displayID": display,
                            "privacyPlaceholder": privateFrame, "label": privateFrame ? "PRIVATE" : String(format: "FRAME %03d", number)])
            if number % 6 == 5 { try await store.finalize() }
        }
        try await store.finalize()
        try db.execute("INSERT INTO state_events(state,reason,started,ended,affected) VALUES ('stopped','synthetic pause',?,?,0)", [base + 100, base + 120])
        var transition = calendar.timeZone.nextDaylightSavingTimeTransition(after: Date().addingTimeInterval(-366 * 86400))
        var latest: Date?
        while let value = transition, value < Date() {
            latest = value; transition = calendar.timeZone.nextDaylightSavingTimeTransition(after: value.addingTimeInterval(1))
        }
        var dstExpectedSeconds: Int?
        if let transition = latest, Date().timeIntervalSince(transition) < 7 * 86400,
           let day = calendar.dateInterval(of: .day, for: transition), Date().timeIntervalSince(day.start) < 7 * 86400 - 60 {
            dstExpectedSeconds = Int(day.duration)
            let dstSession = UUID().uuidString
            let times = [day.start.addingTimeInterval(-10), day.start.addingTimeInterval(10), transition.addingTimeInterval(-10), transition.addingTimeInterval(10), day.end.addingTimeInterval(-10), day.end.addingTimeInterval(10)]
            try db.execute("INSERT INTO sessions(id,started,ended,clean) VALUES (?,?,?,1)", [dstSession, times.first!.timeIntervalSince1970, times.last!.timeIntervalSince1970])
            for (index, date) in times.enumerated() {
                let context = CGContext(data: nil, width: 960, height: 540, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
                context.setFillColor(CGColor(gray: 0.2, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 960, height: 540))
                let label = "DST FRAME \(index)"
                let text = NSAttributedString(string: label, attributes: [.font: NSFont.monospacedSystemFont(ofSize: 48, weight: .bold), .foregroundColor: NSColor.white])
                context.textPosition = CGPoint(x: 200, y: 250); CTLineDraw(CTLineCreateWithAttributedString(text), context)
                let image = context.makeImage()!, id = UUID().uuidString
                let metadata = CaptureMetadata(id: id, sessionID: dstSession, sequence: index, capturedAt: date,
                    timezoneOffset: calendar.timeZone.secondsFromGMT(for: date), displayID: 9998,
                    applicationID: "com.runweave.synthetic-fixture", idleSeconds: 0, privacyPlaceholder: false)
                try await store.prepareAppend(image, displayID: 9998)
                var accepted = false
                for _ in 0..<100 {
                    if try store.append(image, metadata: metadata) != nil { accepted = true; break }
                    try await Task.sleep(for: .milliseconds(20))
                }
                guard accepted else { throw journalError("fixture_encoder_busy") }
                records.append(["id": id, "sequence": index, "capturedAtMs": Int64(date.timeIntervalSince1970 * 1000), "displayID": 9998,
                    "privacyPlaceholder": false, "label": label])
            }
            try await store.finalize()
        }
        let catalog = try JournalReadCatalog.load(db, settings: RecordingSettings(), zone: calendar.timeZone)
        if let seconds = dstExpectedSeconds {
            guard catalog.days.contains(where: { $0.endMs - $0.startMs == Int64(seconds) * 1000 }), seconds != 86400 else { throw journalError("fixture_dst_boundary_mismatch") }
        }
        let localCatalog = try JournalReadCatalog.load(db, settings: RecordingSettings())
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let manifest: [String: Any] = ["scenario": "playback", "synthetic": true, "captures": records,
            "timeZone": calendar.timeZone.identifier,
            "expectedRanges": try JSONSerialization.jsonObject(with: encoder.encode(catalog.ranges)),
            "expectedDays": try JSONSerialization.jsonObject(with: encoder.encode(catalog.days)),
            "localTimeZone": TimeZone.current.identifier,
            "localRanges": try JSONSerialization.jsonObject(with: encoder.encode(localCatalog.ranges)),
            "localDays": try JSONSerialization.jsonObject(with: encoder.encode(localCatalog.days)),
            "dstDaySeconds": dstExpectedSeconds ?? 0,
            "limitations": dstExpectedSeconds == nil ? ["No recent DST transition within retention", "Not a real capture"] : ["Not a real capture"]]
        try db.checkpoint()
        let data = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: paths.file("fixture-manifest.json"), options: .withoutOverwriting)
        print(String(decoding: data, as: UTF8.self))
    }

}
