import Foundation

/// Everything the HTTP layer needs from "wherever the photos actually come
/// from". Two implementations: MockPhotosProvider (fake, in-memory — used
/// for every bit of testing during development) and LivePhotosProvider
/// (real PhotosKit + AppleScript, only ever exercised by the person running
/// the tool themselves).
protocol PhotosProvider {
    /// Human-readable label for what this provider is backed by, shown in
    /// the CLI banner and the /health endpoint so it's always obvious
    /// whether you're looking at demo data or your real library.
    var modeDescription: String { get }
    var albumTitle: String { get }

    func listPhotos() throws -> [PhotoInfo]
    func imageData(for photoID: String) throws -> Data
    func updateCaption(for photoID: String, caption: String, keywords: [String]) throws
}
