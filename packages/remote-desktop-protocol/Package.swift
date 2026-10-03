// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "RunweaveRemoteDesktopProtocol",
    platforms: [.iOS(.v15), .macOS("15.0")],
    products: [.library(name: "RunweaveRemoteDesktopProtocol", targets: ["RunweaveRemoteDesktopProtocol"])],
    targets: [.target(name: "RunweaveRemoteDesktopProtocol")],
    swiftLanguageVersions: [.v5]
)
