import AppKit
import CoreImage
import SwiftUI
import RunweaveRemoteDesktopProtocol

struct PairingQRCodeView: View {
    let invitation: RemotePairingQR
    @State private var image: NSImage?
    @State private var loaded = false

    static func makeImage(invitation: RemotePairingQR) -> NSImage? {
        var allowLoopback = false
        #if DEBUG
        allowLoopback = HostRuntime.simulatorLoopback
        #endif
        if let text = try? invitation.encoded(allowSimulatorLoopback: allowLoopback),
           let filter = CIFilter(name: "CIQRCodeGenerator") {
            filter.setValue(Data(text.utf8), forKey: "inputMessage")
            filter.setValue("M", forKey: "inputCorrectionLevel")
            if let output = filter.outputImage {
                let bounds = output.extent.insetBy(dx: -4, dy: -4)
                let white = CIImage(color: CIColor.white).cropped(to: bounds)
                let padded = output.composited(over: white).cropped(to: bounds)
                let scaled = padded.transformed(by: CGAffineTransform(scaleX: 6, y: 6))
                if let bitmap = CIContext().createCGImage(scaled, from: scaled.extent) {
                    return NSImage(cgImage: bitmap, size: NSSize(width: bitmap.width, height: bitmap.height))
                }
            }
        }
        return nil
    }

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).interpolation(.none).resizable().scaledToFit()
                    .frame(width: 300, height: 300).padding(20).background(Color.white)
                    .accessibilityLabel("用 iPhone 的 Mac 桌面扫码配对")
            } else if loaded {
                Text("无法生成二维码，请使用手动配对信息。") .foregroundStyle(.orange)
            } else { ProgressView().frame(width: 340, height: 340) }
        }.onAppear {
            if !loaded { image = Self.makeImage(invitation: invitation); loaded = true }
        }
    }
}
