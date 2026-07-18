import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Fake, in-memory "album" — used for every bit of my own testing and also
/// offered to the end user as a --demo mode so they can see exactly how the
/// whole thing behaves before ever pointing it at their real library.
/// Never touches Photos, PhotosKit, or Photos.app in any way.
final class MockPhotosProvider: PhotosProvider {
    let modeDescription = "demo (fake data — nothing here touches your real Photos library)"
    let albumTitle = "Demo Album"

    private struct Entry {
        var info: PhotoInfo
        let color: (r: UInt8, g: UInt8, b: UInt8)
    }
    private var entries: [Entry]
    private let lock = NSLock()

    init() {
        let seed: [(String, String, Double?, Double?, (UInt8, UInt8, UInt8))] = [
            ("demo-1", "IMG_0001.jpg", 47.3769, 8.5417, (60, 140, 90)),   // Zurich-ish, green
            ("demo-2", "IMG_0002.jpg", 47.3781, 8.5410, (170, 90, 60)),   // nearby, orange
            ("demo-3", "IMG_0003.jpg", nil, nil, (90, 100, 180)),        // no GPS, blue
        ]
        let fmt = ISO8601DateFormatter()
        entries = seed.enumerated().map { i, s in
            let date = Date(timeIntervalSinceNow: Double(-i) * 3600)
            return Entry(
                info: PhotoInfo(
                    id: s.0, filename: s.1, dateTaken: fmt.string(from: date),
                    lat: s.2, lon: s.3, caption: "", keywords: []
                ),
                color: s.4
            )
        }
    }

    func listPhotos() throws -> [PhotoInfo] {
        lock.lock(); defer { lock.unlock() }
        return entries.map { $0.info }
    }

    func imageData(for photoID: String) throws -> Data {
        lock.lock()
        guard let entry = entries.first(where: { $0.info.id == photoID }) else {
            lock.unlock()
            throw HelperError(message: "no such demo photo")
        }
        lock.unlock()
        return Self.renderJPEG(color: entry.color)
    }

    func thumbnailData(for photoID: String) throws -> Data {
        try imageData(for: photoID)   // demo images are tiny already
    }

    func updateCaption(for photoID: String, caption: String, keywords: [String]) throws {
        lock.lock(); defer { lock.unlock() }
        guard let idx = entries.firstIndex(where: { $0.info.id == photoID }) else {
            throw HelperError(message: "no such demo photo")
        }
        let old = entries[idx].info
        entries[idx].info = PhotoInfo(
            id: old.id, filename: old.filename, dateTaken: old.dateTaken,
            lat: old.lat, lon: old.lon, caption: caption, keywords: keywords
        )
    }

    func updateLocation(for photoID: String, lat: Double, lon: Double) throws {
        lock.lock(); defer { lock.unlock() }
        guard let idx = entries.firstIndex(where: { $0.info.id == photoID }) else {
            throw HelperError(message: "no such demo photo")
        }
        let old = entries[idx].info
        entries[idx].info = PhotoInfo(
            id: old.id, filename: old.filename, dateTaken: old.dateTaken,
            lat: lat, lon: lon, caption: old.caption, keywords: old.keywords
        )
    }

    private static func renderJPEG(color: (r: UInt8, g: UInt8, b: UInt8)) -> Data {
        let width = 320, height = 240
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return Data() }
        ctx.setFillColor(red: CGFloat(color.r) / 255, green: CGFloat(color.g) / 255, blue: CGFloat(color.b) / 255, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let cgImage = ctx.makeImage() else { return Data() }

        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return Data() }
        CGImageDestinationAddImage(dest, cgImage, nil)
        CGImageDestinationFinalize(dest)
        return data as Data
    }
}
