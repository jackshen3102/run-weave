import SwiftUI

struct JournalFilmstripFrame: View {
    let service: JournalReadService
    let viewID: String
    let capture: JournalCapture
    @State private var image: NSImage?
    var body: some View {
        Group {
            if capture.privacyPlaceholder { Image(systemName: "lock.fill").frame(width: 80, height: 45) }
            else if let image { Image(nsImage: image).resizable().scaledToFit().frame(width: 80, height: 45) }
            else { Rectangle().fill(.gray.opacity(0.15)).frame(width: 80, height: 45) }
        }.task(id: capture.id) {
            guard !capture.privacyPlaceholder else { return }
            do {
                let deadline = ContinuousClock.now.advanced(by: .seconds(5))
                var bytes: Data?
                while bytes == nil {
                    try Task.checkCancellation()
                    do { bytes = try await service.frame(viewID: viewID, captureID: capture.id, variant: .thumb) }
                    catch let error as JournalReadError where error.code == "BUSY" && ContinuousClock.now < deadline {
                        try await Task.sleep(for: .milliseconds(100))
                    }
                }
                guard let bytes else { return }
                guard !Task.isCancelled else { return }; image = NSImage(data: bytes)
            } catch { image = nil }
        }.onDisappear { image = nil }
    }
}

struct JournalRangeThumbnail: View {
    let service: JournalReadService
    let range: JournalRange
    let revision: String
    @State private var image: NSImage?
    var body: some View {
        Group {
            if let image { Image(nsImage: image).resizable().scaledToFit() }
            else { Image(systemName: range.previewCaptureID == nil ? "lock.fill" : "photo").foregroundStyle(.secondary) }
        }.frame(width: 96, height: 54).task(id: revision + range.rangeID) {
            guard range.previewCaptureID != nil else { return }
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            do {
                while !Task.isCancelled {
                    do {
                        let bytes = try await service.thumbnail(rangeID: range.rangeID, catalogRevision: revision)
                        guard !Task.isCancelled else { return }; image = NSImage(data: bytes); return
                    } catch let error as JournalReadError where error.code == "BUSY" && ContinuousClock.now < deadline {
                        try await Task.sleep(for: .milliseconds(100))
                    }
                }
            } catch { image = nil }
        }.onDisappear { image = nil }
    }
}
