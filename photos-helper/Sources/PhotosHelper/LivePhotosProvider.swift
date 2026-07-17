import Foundation
import AppKit
import Photos
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// The real thing — PhotosKit for browsing/reading GPS+date/serving image
/// bytes (all things its public API genuinely supports well), AppleScript
/// automation of Photos.app for caption/keywords (the one thing PhotosKit's
/// API doesn't cover — confirmed against the actual framework headers).
///
/// macOS's Photos permission alert only offers "Allow Access to All Photos"
/// or "Don't Allow" — `PHAuthorizationStatusLimited`, the scoped picker some
/// people expect from iOS, is annotated `API_AVAILABLE(ios(14))` only in the
/// real framework headers, not macOS. There is no OS-enforced scoped-access
/// mode here. So the safety boundary that matters is enforced in this class
/// instead: the app never fetches or exposes anything beyond the ONE album
/// chosen in the album picker (see AlbumPicker.swift) — `assets` below is
/// populated exclusively from that album, `asset(_:)` rejects any id that
/// isn't in it, and nothing here ever creates, deletes, or moves photos, or
/// touches any other album.
final class LivePhotosProvider: PhotosProvider {
    let modeDescription: String
    private(set) var albumTitle: String

    private var assets: [PHAsset] = []
    private let imageManager = PHImageManager.default()

    /// Requests the (all-or-nothing) system permission. Constructing this is
    /// what triggers the real "wants to access your Photos" prompt — nothing
    /// before this point in the program has touched Photos in any way. Does
    /// not fetch a single asset; that only happens once an album is chosen.
    static func requestAccess() throws {
        let sema = DispatchSemaphore(value: 0)
        var grantedStatus: PHAuthorizationStatus = .notDetermined
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
            grantedStatus = status
            sema.signal()
        }
        sema.wait()
        guard grantedStatus == .authorized else {
            throw HelperError(message: "Photos access was not granted (status: \(grantedStatus.rawValue)). Allow access in System Settings → Privacy & Security → Photos, then try again.")
        }
    }

    struct AlbumSummary {
        let id: String
        let title: String
        let count: Int?      // nil = not quickly knowable; never worth a slow query just to label a picker
        let folder: String   // "" = top level; nested folders join as "Trips / 2024"
    }

    /// Every regular, user-created album — served to tagit's own album
    /// picker, organised the way Photos' own sidebar is: walked from the
    /// top-level user collections down through folders, each album labelled
    /// with its folder path. Smart albums, shared albums, and system albums
    /// (e.g. Recently Deleted) are deliberately excluded; this should only
    /// ever list things you made yourself. Uses `estimatedAssetCount` rather
    /// than a real per-album asset fetch: with hundreds of albums the exact
    /// counts took long enough that the picker appeared to never show up at
    /// all. Albums whose estimate is 0 are skipped; unknown estimates are
    /// kept (better to show an album without a count than hide it).
    static func fetchAlbums() -> [AlbumSummary] {
        var out: [AlbumSummary] = []
        func walk(_ collections: PHFetchResult<PHCollection>, folder: String) {
            collections.enumerateObjects { collection, _, _ in
                if let album = collection as? PHAssetCollection {
                    guard album.assetCollectionType == .album else { return }
                    let estimated = album.estimatedAssetCount
                    if estimated == 0 { return }
                    out.append(AlbumSummary(id: album.localIdentifier,
                                            title: album.localizedTitle ?? "Untitled Album",
                                            count: estimated == NSNotFound ? nil : estimated,
                                            folder: folder))
                } else if let list = collection as? PHCollectionList {
                    let name = list.localizedTitle ?? "Folder"
                    walk(PHCollection.fetchCollections(in: list, options: nil),
                         folder: folder.isEmpty ? name : "\(folder) / \(name)")
                }
            }
        }
        walk(PHCollection.fetchTopLevelUserCollections(with: nil), folder: "")
        return out.sorted {
            if $0.folder != $1.folder {
                // Top-level albums first, then folders alphabetically.
                if $0.folder.isEmpty != $1.folder.isEmpty { return $0.folder.isEmpty }
                return $0.folder.localizedCaseInsensitiveCompare($1.folder) == .orderedAscending
            }
            return $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
        }
    }

    // Thumbnails are re-requested every time the picker opens — remember the
    // encoded bytes so only the first look at each album costs anything.
    // Only ever touched from the HTTP server's serial queue.
    private static var thumbnailCache: [String: Data] = [:]

    /// Cover thumbnail for one album, as JPEG bytes — the album's first photo
    /// (no sort: sorting a big album just to pick a cover was the main reason
    /// the picker felt slow), from the already-cached local thumbnail only,
    /// never waiting on an iCloud download just to draw a picker.
    static func albumThumbnail(id: String) -> Data? {
        if let cached = thumbnailCache[id] { return cached }
        let collections = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil)
        guard let collection = collections.firstObject else { return nil }
        let assetOptions = PHFetchOptions()
        assetOptions.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        assetOptions.fetchLimit = 1
        guard let asset = PHAsset.fetchAssets(in: collection, options: assetOptions).firstObject else { return nil }
        let options = PHImageRequestOptions()
        options.isSynchronous = true
        options.deliveryMode = .fastFormat
        options.isNetworkAccessAllowed = false
        options.resizeMode = .fast
        var out: Data?
        PHImageManager.default().requestImage(
            for: asset, targetSize: CGSize(width: 512, height: 512), contentMode: .aspectFill, options: options
        ) { image, _ in out = image.flatMap { Self.jpegData(from: $0) } }
        if let out { thumbnailCache[id] = out }
        return out
    }

    /// Scoped entirely to the one album chosen in the picker — this fetch is
    /// the only place `assets` is ever populated, and it only ever contains
    /// this album's images.
    init(album: PHAssetCollection) {
        albumTitle = album.localizedTitle ?? "Album"
        modeDescription = "your real Photos library — scoped to the \u{201c}\(albumTitle)\u{201d} album only"
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        let result = PHAsset.fetchAssets(in: album, options: options)
        result.enumerateObjects { asset, _, _ in self.assets.append(asset) }
    }

    private func asset(_ id: String) throws -> PHAsset {
        guard let a = assets.first(where: { $0.localIdentifier == id }) else {
            throw HelperError(message: "no such photo (not in the selected set)")
        }
        return a
    }

    func listPhotos() throws -> [PhotoInfo] {
        let fmt = ISO8601DateFormatter()
        // One batched AppleScript pass for all captions/keywords instead of a
        // script compile+execute per photo — the difference between seconds
        // and minutes on a big album. Best-effort: if Photos automation isn't
        // approved yet, or a lookup fails, those photos just show as untagged
        // rather than failing the whole listing.
        let meta = PhotosScripting.getCaptionsAndKeywords(ids: assets.map { $0.localIdentifier })
        return assets.map { asset in
            let got = meta[asset.localIdentifier]
            let caption = got?.caption ?? ""
            let keywords = got?.keywords ?? []
            return PhotoInfo(
                id: asset.localIdentifier,
                filename: asset.value(forKey: "filename") as? String ?? "\(asset.localIdentifier).jpg",
                dateTaken: asset.creationDate.map { fmt.string(from: $0) },
                lat: asset.location?.coordinate.latitude,
                lon: asset.location?.coordinate.longitude,
                caption: caption,
                keywords: keywords
            )
        }
    }

    func imageData(for photoID: String) throws -> Data {
        let a = try asset(photoID)
        let options = PHImageRequestOptions()
        options.isSynchronous = true
        options.deliveryMode = .highQualityFormat
        options.isNetworkAccessAllowed = true   // fetch from iCloud if needed

        var result: Data?
        var requestError: Error?
        // 2048px is deliberately the ceiling: it's sharper than any screen
        // needs, and it's exactly the size tagit already downscales to before
        // uploading to iNaturalist — while being far faster to fetch and
        // re-encode than a 48-megapixel original (especially from iCloud).
        // Nothing in Photos mode ever writes image bytes back, so serving a
        // preview loses nothing.
        let targetSize = CGSize(width: 2048, height: 2048)
        imageManager.requestImage(
            for: a, targetSize: targetSize, contentMode: .aspectFit, options: options
        ) { image, info in
            if let e = info?[PHImageErrorKey] as? Error { requestError = e; return }
            guard let image else { return }
            result = Self.jpegData(from: image)
        }
        if let requestError { throw HelperError(message: "could not load image: \(requestError)") }
        guard let result else { throw HelperError(message: "could not load image data") }
        return result
    }

    func updateCaption(for photoID: String, caption: String, keywords: [String]) throws {
        _ = try asset(photoID)  // confirms it's actually one of ours before touching anything
        try PhotosScripting.setCaptionAndKeywords(id: photoID, caption: caption, keywords: keywords)
    }

    static func jpegData(from image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .jpeg, properties: [.compressionFactor: 0.9])
    }
}
