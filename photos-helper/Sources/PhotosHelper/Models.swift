import Foundation

/// One photo as exposed to tagit over HTTP.
struct PhotoInfo: Codable {
    let id: String              // PHAsset.localIdentifier — stable across launches
    let filename: String
    let dateTaken: String?      // ISO 8601, or nil if unknown
    let lat: Double?
    let lon: Double?
    let caption: String
    let keywords: [String]
}

struct AlbumInfo: Codable {
    let id: String
    let title: String
    let photoCount: Int
}

struct CaptionUpdate: Codable {
    let caption: String
    let keywords: [String]
}

struct HelperError: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}
