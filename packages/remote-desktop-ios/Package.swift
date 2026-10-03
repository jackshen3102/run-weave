// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "RunweaveRemoteDesktop",
    platforms: [.iOS(.v15)],
    products: [.library(name: "RunweaveRemoteDesktop", targets: ["RunweaveRemoteDesktop"])],
    dependencies: [.package(path: "../remote-desktop-protocol")],
    targets: [.target(name: "RunweaveRemoteDesktop", dependencies: [
        .product(name: "RunweaveRemoteDesktopProtocol", package: "remote-desktop-protocol")
    ], resources: [.copy("Resources/Mirador-LICENSE.txt")])],
    swiftLanguageModes: [.v5]
)
