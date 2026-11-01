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
                let bytes = try await service.frame(viewID: viewID, captureID: capture.id, variant: .thumb)
                guard !Task.isCancelled else { return }; image = UIImage(data: bytes)
            } catch { image = nil }
        }.onDisappear { image = nil }
    }
}
