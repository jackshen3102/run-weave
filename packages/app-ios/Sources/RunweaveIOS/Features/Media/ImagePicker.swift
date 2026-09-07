import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ImagePicker: UIViewControllerRepresentable {
  let selected: (Result<(Data, String)?, Error>) -> Void

  func makeUIViewController(context: Context) -> PHPickerViewController {
    var configuration = PHPickerConfiguration()
    configuration.filter = .images
    configuration.selectionLimit = 1
    let picker = PHPickerViewController(configuration: configuration)
    picker.delegate = context.coordinator
    return picker
  }
  func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}
  func makeCoordinator() -> Coordinator { Coordinator(selected: selected) }

  final class Coordinator: NSObject, PHPickerViewControllerDelegate {
    let selected: (Result<(Data, String)?, Error>) -> Void
    init(selected: @escaping (Result<(Data, String)?, Error>) -> Void) { self.selected = selected }
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
      guard let provider = results.first?.itemProvider else {
        selected(.success(nil))
        return
      }
      let formats: [(UTType, String)] = [
        (.png, "image/png"), (.jpeg, "image/jpeg"), (.gif, "image/gif"), (.webP, "image/webp"),
      ]
      if let format = formats.first(where: {
        provider.hasItemConformingToTypeIdentifier($0.0.identifier)
      }) {
        provider.loadDataRepresentation(forTypeIdentifier: format.0.identifier) { data, error in
          DispatchQueue.main.async {
            if let data {
              self.selected(.success((data, format.1)))
            } else {
              self.selected(.failure(error ?? APIError.invalidResponse))
            }
          }
        }
      } else {
        // HEIC and other picker formats are converted to PNG, which the Backend accepts.
        provider.loadObject(ofClass: UIImage.self) { object, error in
          let data = (object as? UIImage)?.pngData()
          DispatchQueue.main.async {
            if let data {
              self.selected(.success((data, "image/png")))
            } else {
              self.selected(.failure(error ?? APIError.invalidResponse))
            }
          }
        }
      }
    }
  }
}
