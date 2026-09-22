#if canImport(UIKit)
import SwiftUI
import UIKit

public struct BuildIdentityView: View {
  @Environment(\.dismiss) private var dismiss
  @State private var export: ExportFile?
  @State private var failure: String?
  public init() {}

  public var body: some View {
    NavigationView {
      Form {
        Section {
          Text("导出当前安装包的构建信息，供排查版本问题。无需联网。")
            .foregroundStyle(.secondary)
          Button("导出构建信息") {
            failure = nil
            do {
              let value = try AppBuildIdentity.read()
              let url = FileManager.default.temporaryDirectory.appendingPathComponent(
                "build-identity-\(value.identity.buildId)-\(UUID().uuidString).json")
              try value.data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
              export = ExportFile(url: url)
            } catch { failure = error.localizedDescription }
          }
        }
        if let failure { Section { Text(failure).foregroundStyle(.orange) } }
      }
      .navigationTitle("构建信息")
      .toolbar { Button("关闭") { dismiss() } }
      .sheet(item: $export) { file in
        BuildIdentityShare(url: file.url).onDisappear {
          try? FileManager.default.removeItem(at: file.url)
        }
      }
    }.navigationViewStyle(.stack)
  }
}

private struct ExportFile: Identifiable {
  let url: URL
  var id: URL { url }
}
private struct BuildIdentityShare: UIViewControllerRepresentable {
  let url: URL
  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: [url], applicationActivities: nil)
  }
  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
#endif
