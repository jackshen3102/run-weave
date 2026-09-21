import SwiftUI
import UIKit

struct TerminalSnapshotShareSheet: UIViewControllerRepresentable {
  let url: URL

  func makeUIViewController(context: Context) -> UIActivityViewController {
    // Share the URL as text so Copy also works with plain-text paste targets.
    UIActivityViewController(activityItems: [url.absoluteString], applicationActivities: nil)
  }

  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
