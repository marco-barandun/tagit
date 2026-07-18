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

    /// Fast, PhotosKit-only listing (id, filename, date, GPS) — caption and
    /// keywords always come back empty here. Reading those from Photos.app
    /// via AppleScript is the slow part (seconds per photo on some
    /// libraries), so it's split into metaFor(ids:) below and fetched by the
    /// caller afterward, instead of blocking the whole album listing on it.
    func listPhotos() throws -> [PhotoInfo]
    func imageData(for photoID: String) throws -> Data
    /// Small (~240px) preview for the filmstrip — cheap to produce, never
    /// waits on iCloud.
    func thumbnailData(for photoID: String) throws -> Data
    /// Caption + keywords for a batch of ids — the AppleScript-backed part
    /// split out of listPhotos() so it can be fetched lazily, in priority
    /// order, after the fast list already appeared. Ids that fail lookup are
    /// simply absent from the result rather than failing the whole batch.
    func metaFor(ids: [String]) throws -> [String: (caption: String, keywords: [String])]
    func updateCaption(for photoID: String, caption: String, keywords: [String]) throws
    /// Writes real GPS coordinates onto the photo (the "estimate location"
    /// feature) — the one field PhotosKit's change API does support.
    func updateLocation(for photoID: String, lat: Double, lon: Double) throws
    /// Sets (or clears) the native Photos "favorite" heart — used so a 5-star
    /// rating in tagit is also a favorite in Photos itself.
    func setFavorite(for photoID: String, favorite: Bool) throws
}
