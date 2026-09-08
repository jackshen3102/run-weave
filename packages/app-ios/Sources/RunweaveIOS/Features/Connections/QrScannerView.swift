import AVFoundation
import SwiftUI
import UIKit

struct QrScannerView: UIViewControllerRepresentable {
  let onCode: (String) -> Bool
  let onFailure: (String) -> Void

  func makeUIViewController(context: Context) -> CameraController {
    CameraController(onCode: onCode, onFailure: onFailure)
  }
  func updateUIViewController(_ uiViewController: CameraController, context: Context) {}
  static func dismantleUIViewController(_ uiViewController: CameraController, coordinator: ()) {
    uiViewController.shutdown()
  }
}

final class CameraController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  private let capture = AVCaptureSession()
  private let queue = DispatchQueue(label: "runweave.mobile-login.camera")
  private var preview: AVCaptureVideoPreviewLayer?
  private var stopped = false
  private var accepted = false
  private let onCode: (String) -> Bool
  private let onFailure: (String) -> Void

  init(onCode: @escaping (String) -> Bool, onFailure: @escaping (String) -> Void) {
    self.onCode = onCode
    self.onFailure = onFailure
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { nil }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    let layer = AVCaptureVideoPreviewLayer(session: capture)
    layer.videoGravity = .resizeAspectFill
    view.layer.addSublayer(layer)
    preview = layer
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: configure()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
        DispatchQueue.main.async {
          guard let self, !self.stopped else { return }
          if allowed { self.configure() } else { self.permissionDenied() }
        }
      }
    default: permissionDenied()
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    preview?.frame = view.bounds
    if let orientation = view.window?.windowScene?.interfaceOrientation,
      let connection = preview?.connection, connection.isVideoOrientationSupported {
      switch orientation {
      case .landscapeLeft: connection.videoOrientation = .landscapeLeft
      case .landscapeRight: connection.videoOrientation = .landscapeRight
      case .portraitUpsideDown: connection.videoOrientation = .portraitUpsideDown
      default: connection.videoOrientation = .portrait
      }
    }
  }

  private func permissionDenied() {
    onFailure("相机权限未开启。可在系统设置中允许 Runweave 使用相机，或返回手动连接。")
  }

  private func configure() {
    guard !stopped else { return }
    queue.async { [self] in
      capture.beginConfiguration()
      do {
        guard let camera = AVCaptureDevice.default(for: .video) else { throw APIError.invalidResponse }
        let input = try AVCaptureDeviceInput(device: camera)
        let output = AVCaptureMetadataOutput()
        guard capture.canAddInput(input), capture.canAddOutput(output) else { throw APIError.invalidResponse }
        capture.addInput(input)
        capture.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        capture.commitConfiguration()
        capture.startRunning()
      } catch {
        capture.commitConfiguration()
        DispatchQueue.main.async { [weak self] in
          guard let self, !self.stopped else { return }
          self.onFailure("无法启动相机，请检查权限或使用手动连接。")
        }
      }
    }
  }

  func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection) {
    guard !stopped, !accepted else { return }
    for case let object as AVMetadataMachineReadableCodeObject in metadataObjects {
      if let text = object.stringValue, onCode(text) {
        accepted = true
        shutdown()
        return
      }
    }
  }

  func shutdown() {
    guard !stopped else { return }
    stopped = true
    let capture = self.capture
    queue.async {
      capture.stopRunning()
      capture.beginConfiguration()
      capture.inputs.forEach { capture.removeInput($0) }
      capture.outputs.forEach { capture.removeOutput($0) }
      capture.commitConfiguration()
    }
  }
}
