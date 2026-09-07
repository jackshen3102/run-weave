import AVFoundation
import Foundation

@MainActor
final class VoiceRecorder: NSObject, ObservableObject, AVAudioRecorderDelegate {
  @Published private(set) var recording = false
  @Published private(set) var requestingPermission = false
  @Published var failure: String?
  private var recorder: AVAudioRecorder?
  private var file: URL?
  private var generation = 0
  private var interruption: NSObjectProtocol?

  override init() {
    super.init()
    interruption = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
    ) { [weak self] note in
      guard
        (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt)
          == AVAudioSession.InterruptionType.began.rawValue
      else { return }
      Task { @MainActor in
        self?.cancel()
        self?.failure = "录音已中断，未上传或发送"
      }
    }
  }

  deinit { if let interruption { NotificationCenter.default.removeObserver(interruption) } }

  func start() async {
    guard !recording, !requestingPermission else { return }
    generation += 1
    let epoch = generation
    requestingPermission = true
    failure = nil
    let audio = AVAudioSession.sharedInstance()
    let granted = await withCheckedContinuation { continuation in
      audio.requestRecordPermission { continuation.resume(returning: $0) }
    }
    guard generation == epoch, !Task.isCancelled else { return }
    requestingPermission = false
    guard granted else {
      failure = "麦克风权限未允许，可在系统设置中开启"
      return
    }
    do {
      try audio.setCategory(.record, mode: .default)
      try audio.setActive(true)
      let url = FileManager.default.temporaryDirectory.appendingPathComponent(
        "runweave-voice-\(UUID().uuidString).wav")
      file = url
      let next = try AVAudioRecorder(
        url: url,
        settings: [
          AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 24000,
          AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
          AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
        ])
      next.delegate = self
      recorder = next
      guard next.record() else { throw APIError.invalidResponse }
      recording = true
    } catch {
      cancel()
      failure = displayError(error)
    }
  }

  func finish() throws -> VoiceClip {
    guard let recorder, let file, recording else { throw APIError.invalidResponse }
    let duration = recorder.currentTime
    recorder.stop()
    defer { cancel() }
    let audio = try AVAudioFile(forReading: file)
    guard audio.fileFormat.sampleRate == 24000, audio.fileFormat.channelCount == 1, audio.length > 0
    else {
      throw APIError.invalidResponse
    }
    return VoiceClip(
      data: try Data(contentsOf: file), durationMilliseconds: max(1, Int(duration * 1000)))
  }

  func cancel() {
    generation += 1
    recorder?.delegate = nil
    recorder?.stop()
    recorder = nil
    recording = false
    requestingPermission = false
    if let file { try? FileManager.default.removeItem(at: file) }
    file = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
    Task { @MainActor in
      self.cancel()
      self.failure = "录音失败，未上传或发送"
    }
  }
}
