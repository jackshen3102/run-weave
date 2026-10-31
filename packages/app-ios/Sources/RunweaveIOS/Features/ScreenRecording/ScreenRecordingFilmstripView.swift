import Clarity
import SwiftUI

@available(iOS 17.0, *)
struct ScreenRecordingFilmstripFrame: View {
    let service: ScreenRecordingSource
    let viewID: String
    let capture: ScreenRecordingCapture
    @State private var image: UIImage?
    var body: some View {
        Group {
            if capture.privacyPlaceholder { Image(systemName: "lock.fill").frame(width: 80, height: 45) }
            else if let image { Image(uiImage: image).resizable().scaledToFit().frame(width: 80, height: 45) }
            else { Rectangle().fill(.gray.opacity(0.15)).frame(width: 80, height: 45) }
        }.clarityMask().task(id: capture.id) {
            guard !capture.privacyPlaceholder else { return }
            do {
                let deadline = ContinuousClock.now.advanced(by: .seconds(5))
                var bytes: Data?
                while bytes == nil {
                    try Task.checkCancellation()
                    do { bytes = try await service.frame(viewID: viewID, captureID: capture.id, variant: .thumb) }
                    catch let error as ScreenRecordingReadError where error.code == "BUSY" && ContinuousClock.now < deadline {
                        try await Task.sleep(for: .milliseconds(100))
                    }
                }
                guard let bytes else { return }
                guard !Task.isCancelled else { return }; image = UIImage(data: bytes)
            } catch { image = nil }
        }.onDisappear { image = nil }
    }
}

@available(iOS 17.0, *)
struct ScreenRecordingRangeThumbnail: View {
    let api: APIClient
    let range: ScreenRecordingRange
    let revision: String
    @State private var image: UIImage?
    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFit() }
            else { Image(systemName: range.previewCaptureID == nil ? "lock.fill" : "photo").foregroundStyle(.secondary) }
        }.frame(width: 96, height: 54).clarityMask().task(id: revision + range.rangeID) {
            guard range.previewCaptureID != nil else { return }
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            do {
                while !Task.isCancelled {
                    do {
                        let bytes = try await api.screenThumbnail(rangeID: range.rangeID, catalogRevision: revision)
                        guard !Task.isCancelled else { return }; image = UIImage(data: bytes); return
                    } catch let error as ScreenRecordingReadError where error.code == "BUSY" && ContinuousClock.now < deadline {
                        try await Task.sleep(for: .milliseconds(100))
                    }
                }
            } catch { image = nil }
        }.onDisappear { image = nil }
    }
}
