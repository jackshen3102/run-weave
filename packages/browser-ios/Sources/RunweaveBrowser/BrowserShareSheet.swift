import SwiftUI
import UIKit

struct BrowserShareSheet: UIViewControllerRepresentable {
  let url: URL
  let onComplete: () -> Void

  func makeUIViewController(context: Context) -> UIActivityViewController {
    let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
    controller.completionWithItemsHandler = { _, _, _, _ in onComplete() }
    return controller
  }

  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
