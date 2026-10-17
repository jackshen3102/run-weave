import AVKit
import SwiftUI

/// Use the system transport controls, including fullscreen and scrubbing.
struct VideoPreview: View {
  let url: URL
  let reload: () -> Void
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var model = VideoPreviewPlayer()

  var body: some View {
    VStack(spacing: 8) {
      if let failure = model.failure {
        Text(failure).foregroundColor(.red).padding()
        Button("重试") { model.stop(); reload() }
      } else {
        if model.loading { ProgressView("正在加载视频…") }
        if let player = model.player {
          SystemVideoPlayer(player: player)
            .accessibilityIdentifier("file-video-player")
        }
      }
    }
    .task(id: url) { model.open(url) }
    .onChange(of: scenePhase) { phase in
      if phase != .active { model.player?.pause() }
    }
  }
}

private struct SystemVideoPlayer: UIViewControllerRepresentable {
  let player: AVPlayer
  func makeUIViewController(context: Context) -> AVPlayerViewController {
    let controller = AVPlayerViewController()
    controller.player = player
    controller.showsPlaybackControls = true
    return controller
  }
  func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
    if controller.player !== player { controller.player = player }
  }
  static func dismantleUIViewController(_ controller: AVPlayerViewController, coordinator: ()) {
    // Fullscreen only hides the SwiftUI view; dismantling is the actual owner exit.
    controller.player?.pause()
    controller.player?.replaceCurrentItem(with: nil)
    controller.player = nil
  }
}

@MainActor
private final class VideoPreviewPlayer: ObservableObject {
  @Published var player: AVPlayer?
  @Published var failure: String?
  @Published var loading = true
  private var observation: NSKeyValueObservation?
  private var loadedURL: URL?
  func open(_ url: URL) {
    // SwiftUI restarts the task when AVKit returns from fullscreen.
    guard loadedURL != url || player?.currentItem == nil else { return }
    stop()
    loadedURL = url
    failure = nil
    loading = true
    let item = AVPlayerItem(url: url)
    player = AVPlayer(playerItem: item)
    observation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
      let status = item.status
      Task { @MainActor [weak self] in
        guard self?.player?.currentItem === item else { return }
        if status == .readyToPlay { self?.loading = false }
        if status == .failed {
          self?.loading = false
          self?.failure = "视频无法播放。文件可能已变化、播放链接已过期，或编码不受系统支持。"
        }
      }
    }
  }
  func stop() {
    loadedURL = nil
    observation = nil
    player?.pause()
    player?.replaceCurrentItem(with: nil)
    player = nil
  }
}
