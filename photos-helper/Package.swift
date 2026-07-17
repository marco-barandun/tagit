// swift-tools-version:5.9
// No external dependencies on purpose — keeps `swift build` fully offline and
// avoids trusting any third-party package for something that touches Photos.
import PackageDescription

let package = Package(
    name: "PhotosHelper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "PhotosHelper",
            path: "Sources/PhotosHelper"
        )
    ]
)
