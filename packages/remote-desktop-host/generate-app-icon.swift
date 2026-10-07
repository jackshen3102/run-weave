#!/usr/bin/env swift
import AppKit
import ImageIO
import UniformTypeIdentifiers

let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let icons = package.appendingPathComponent("Resources/icons")
let artwork = icons.appendingPathComponent("raw/icon.png")
let source = CGImageSourceCreateWithURL(artwork as CFURL, nil)!
let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

func render(size: Int) -> CGImage {
    let context = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8,
        bytesPerRow: 0, space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    context.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
    // Match Runweave's macOS icon inset and mask.
    let bounds = CGRect(x: 72, y: 72, width: 880, height: 880)
    context.addPath(CGPath(roundedRect: bounds, cornerWidth: 214, cornerHeight: 214, transform: nil))
    context.clip()
    context.interpolationQuality = .high
    context.draw(image, in: bounds)
    return context.makeImage()!
}

func writePNG(_ image: CGImage, to url: URL) {
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("Could not write \(url.path)") }
}

let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("RemoteDesk-\(UUID().uuidString).iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: iconset) }
for size in [16, 32, 128, 256, 512] {
    writePNG(render(size: size), to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    writePNG(render(size: size * 2), to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
writePNG(render(size: 1024), to: icons.appendingPathComponent("icon-preview.png"))
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset.path, "-o", icons.appendingPathComponent("AppIcon.icns").path]
try process.run()
process.waitUntilExit()
guard process.terminationStatus == 0 else { fatalError("iconutil failed") }
