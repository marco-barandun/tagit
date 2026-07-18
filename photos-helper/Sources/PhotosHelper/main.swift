import Foundation
import AppKit
import Photos

// ---- CLI args ---------------------------------------------------------
// --demo            run against fake, in-memory photos (no Photos access
//                    at all, nothing real touched) — the safe way to try
//                    the whole thing end to end before pointing it at a
//                    real album.
// --port <n>         default 8765.
// --origin <url>     add an extra allowed origin (repeatable).
let args = CommandLine.arguments
let isDemo = args.contains("--demo")
var port: UInt16 = 8765
if let idx = args.firstIndex(of: "--port"), idx + 1 < args.count, let p = UInt16(args[idx + 1]) {
    port = p
}
var allowedOrigins = Security.defaultAllowedOrigins()
var i = 0
while i < args.count {
    if args[i] == "--origin", i + 1 < args.count { allowedOrigins.insert(args[i + 1]) }
    i += 1
}

// Launched from a terminal (swift run, or a .command double-click) vs.
// launched as a real app (Finder double-click, or tagit's web page opening
// the tagitphotos:// link) — the latter has no terminal to print the
// pairing code into, so it gets a menu bar icon instead (never a window —
// see StatusMenu.swift). Terminal launches also cause Photos to attribute
// the permission prompts to Terminal.app itself rather than to this app;
// the menu-bar path is the one that gets those prompts correctly attributed
// to "tagit Photos Helper".
let isTerminal = isatty(fileno(stdout)) != 0

if isTerminal {
    print("""

      tagit Photos helper
      ────────────────────
      """)
}

func fail(_ message: String) -> Never {
    if isTerminal {
        print("  \(message)")
    } else {
        let alert = NSAlert()
        alert.messageText = "tagit Photos Helper couldn't start"
        alert.informativeText = message
        alert.runModal()
    }
    exit(1)
}

// The photo source stays nil until an album is chosen — in live mode, album
// selection happens from tagit's own UI (POST /album below), which is the
// real safety boundary: until then the server can only list album names and
// thumbnails, and afterwards it can only ever see the one chosen album.
var provider: PhotosProvider?

// HTTPServer's own newConnectionHandler only captures itself weakly (so a
// stopped server doesn't leak), which means something has to hold a real,
// strong reference to it for as long as the process is meant to keep
// serving — otherwise ARC deallocates it the moment the function that
// created it returns, and every future connection silently goes nowhere.
var keepAliveServer: HTTPServer?

var statusMenu: StatusMenuController?
var currentToken = Security.generateToken()
var autoPaired = false
var lastActivity = Date()

// The menu bar icon is the entirety of this app's on-screen presence when
// running as a real app — created once, then just updated in place. Never a
// window, never something that pops to the front or steals focus.
func refreshStatusMenu() {
    guard !isTerminal else { return }
    if statusMenu == nil {
        statusMenu = StatusMenuController(onQuit: { NSApplication.shared.terminate(nil) })
    }
    statusMenu?.update(
        mode: provider?.modeDescription ?? (isDemo ? "demo — waiting for an album pick in tagit" : "waiting for an album to be chosen in tagit"),
        album: provider?.albumTitle ?? "",
        token: currentToken, autoPaired: autoPaired
    )
}

// Selecting the album (from tagit, over the paired connection). In demo mode
// there is exactly one fake "album"; in live mode this constructs the
// LivePhotosProvider scoped to just the chosen collection.
func selectAlbum(id: String) throws -> String {
    if isDemo {
        if provider == nil { provider = MockPhotosProvider() }
        DispatchQueue.main.async { refreshStatusMenu() }
        return provider!.albumTitle
    }
    let fetch = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil)
    guard let collection = fetch.firstObject else {
        throw HelperError(message: "that album no longer exists — pick another")
    }
    let live = LivePhotosProvider(album: collection)
    provider = live
    DispatchQueue.main.async { refreshStatusMenu() }
    return live.albumTitle
}

func route(_ req: HTTPServer.Request) -> HTTPServer.Response {
    // Asset and album identifiers contain slashes ("ABC…/L0/001"), which
    // arrive percent-encoded (%2F) — decode each path component after
    // splitting, or no real-library photo can ever be matched by id.
    let parts = req.path.split(separator: "/").map { String($0).removingPercentEncoding ?? String($0) }
    func ready() throws -> PhotosProvider {
        guard let p = provider else {
            throw HelperError(message: "no album selected yet — choose one in tagit first")
        }
        return p
    }
    do {
        switch (req.method, parts) {
        case ("GET", ["health"]):
            var obj: [String: Any] = ["ok": true, "albumSelected": provider != nil]
            if let p = provider {
                obj["mode"] = p.modeDescription
                obj["album"] = p.albumTitle
            }
            return .json(obj)

        case ("GET", ["albums"]):
            if isDemo {
                // Several fake albums across folders, so the picker's folder
                // grouping can be seen and tested without a real library —
                // whichever one is picked serves the same three fake photos.
                return .json(["albums": [
                    ["id": "demo-album", "title": "Demo Album", "count": 3, "folder": ""],
                    ["id": "demo-album-2", "title": "Alpine Flora", "count": 3, "folder": "Botany"],
                    ["id": "demo-album-3", "title": "Orchids 2026", "count": 3, "folder": "Botany"],
                    ["id": "demo-album-4", "title": "Fungi", "count": 3, "folder": "Field Trips / 2026"],
                ]])
            }
            let albums = LivePhotosProvider.fetchAlbums().map { album -> [String: Any] in
                var obj: [String: Any] = ["id": album.id, "title": album.title, "folder": album.folder]
                if let count = album.count { obj["count"] = count }
                return obj
            }
            return .json(["albums": albums])

        case ("GET", let p) where p.count == 3 && p[0] == "albums" && p[2] == "thumbnail":
            if isDemo {
                return .raw(contentType: "image/jpeg", body: try MockPhotosProvider().imageData(for: "demo-1"))
            }
            guard let data = LivePhotosProvider.albumThumbnail(id: p[1]) else {
                return .jsonError(404, "no local thumbnail available")
            }
            return .raw(contentType: "image/jpeg", body: data)

        case ("POST", ["album"]):
            let obj = try JSONSerialization.jsonObject(with: req.body) as? [String: Any]
            guard let id = obj?["id"] as? String, !id.isEmpty else {
                return .jsonError(400, "missing album id")
            }
            return .json(["ok": true, "album": try selectAlbum(id: id)])

        case ("POST", ["quit"]):
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
            return .json(["ok": true])

        case ("GET", ["photos"]):
            let photos = try ready().listPhotos()
            let encoded = try JSONEncoder().encode(photos)
            let obj = try JSONSerialization.jsonObject(with: encoded)
            return .json(["photos": obj])

        case ("POST", ["photos", "meta"]):
            let obj = try JSONSerialization.jsonObject(with: req.body) as? [String: Any]
            guard let ids = obj?["ids"] as? [String], !ids.isEmpty else {
                return .jsonError(400, "missing ids")
            }
            let meta = try ready().metaFor(ids: ids)
            var out: [String: Any] = [:]
            for (id, m) in meta { out[id] = ["caption": m.caption, "keywords": m.keywords] }
            return .json(["meta": out])

        case ("GET", let p) where p.count == 3 && p[0] == "photos" && p[2] == "image":
            let data = try ready().imageData(for: p[1])
            return .raw(contentType: "image/jpeg", body: data)

        case ("GET", let p) where p.count == 3 && p[0] == "photos" && p[2] == "thumbnail":
            let data = try ready().thumbnailData(for: p[1])
            return .raw(contentType: "image/jpeg", body: data)

        case ("POST", let p) where p.count == 3 && p[0] == "photos" && p[2] == "location":
            let obj = try JSONSerialization.jsonObject(with: req.body) as? [String: Any]
            guard let lat = obj?["lat"] as? Double, let lon = obj?["lon"] as? Double,
                  (-90...90).contains(lat), (-180...180).contains(lon) else {
                return .jsonError(400, "missing or out-of-range lat/lon")
            }
            try ready().updateLocation(for: p[1], lat: lat, lon: lon)
            return .json(["ok": true])

        case ("POST", let p) where p.count == 3 && p[0] == "photos" && p[2] == "favorite":
            let obj = try JSONSerialization.jsonObject(with: req.body) as? [String: Any]
            guard let fav = obj?["favorite"] as? Bool else { return .jsonError(400, "missing favorite") }
            try ready().setFavorite(for: p[1], favorite: fav)
            return .json(["ok": true])

        case ("POST", let p) where p.count == 3 && p[0] == "photos" && p[2] == "caption":
            let update = try JSONDecoder().decode(CaptionUpdate.self, from: req.body)
            try ready().updateCaption(for: p[1], caption: update.caption, keywords: update.keywords)
            return .json(["ok": true])

        default:
            return .jsonError(404, "no such endpoint")
        }
    } catch let e as HelperError {
        return .jsonError(400, e.message)
    } catch {
        return .jsonError(500, "\(error)")
    }
}

func startServer() {
    do {
        let server = try HTTPServer(port: port, allowedOrigins: allowedOrigins, token: currentToken, route: route)
        server.onActivity = { DispatchQueue.main.async { lastActivity = Date() } }
        keepAliveServer = server
        server.start()
    } catch {
        fail("Failed to start: \(error) — another copy might already be running. Quit it (its window, or Control-C in its terminal) and try again.")
    }
}

// If nothing has talked to the helper for an hour, quit — access to your
// library should never quietly outlive the tagging session it was opened for.
func scheduleIdleShutdown() {
    Timer.scheduledTimer(withTimeInterval: 120, repeats: true) { _ in
        if Date().timeIntervalSince(lastActivity) > 3600 {
            if isTerminal { print("  No activity for an hour — quitting so access doesn't linger.") }
            exit(0)
        }
    }
}

func printPairing() {
    print("  Album:  \(provider?.albumTitle ?? "none yet — pick one from tagit after connecting")")
    print("  Data:   \(provider?.modeDescription ?? "nothing until an album is chosen")")
    print("")
    print("  Pairing code (paste this into tagit's \"Connect to Photos\" dialog):")
    print("")
    print("      \(currentToken)")
    print("")
    print("  Listening on http://127.0.0.1:\(port) — only reachable from this Mac,")
    print("  only from an approved tagit origin, only with the code above.")
    print("  Press Control-C to stop (it also auto-quits after an hour idle).")
    print("")
}

/// Receives the tagitphotos://start?pair=… URL — both when that URL launches
/// the app and when it's routed to an already-running instance (relaunching
/// from tagit while an old helper is still up just re-pairs it, no port
/// conflict). The pair secret becomes the token; tagit is polling /health
/// with it and connects the moment it's adopted.
final class HelperAppDelegate: NSObject, NSApplicationDelegate {
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "tagitphotos" {
            guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
                  let secret = items.first(where: { $0.name == "pair" })?.value,
                  secret.count >= 22,
                  secret.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
            else { continue }
            currentToken = secret
            keepAliveServer?.updateToken(secret)
            autoPaired = true
            refreshStatusMenu()
        }
    }
}
let appDelegate = HelperAppDelegate()   // NSApp.delegate is weak — keep it alive

if isDemo {
    // Demo starts with no album "selected" so the full web flow — including
    // tagit's album picker — can be exercised against fake data.
    if isTerminal {
        print("  Mode:   DEMO — fake photos only, your real Photos library is not touched.")
        startServer()
        printPairing()
        scheduleIdleShutdown()
        RunLoop.main.run()
    } else {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.delegate = appDelegate
        startServer()
        refreshStatusMenu()
        scheduleIdleShutdown()
        app.run()
    }
} else {
    if isTerminal {
        print("  Mode:   LIVE — this will ask for access to your real Photos library.")
        print("  (Run with --demo instead if you want to try this risk-free first.)")
    }
    // LivePhotosProvider.requestAccess() is what triggers the real permission
    // flow — nothing above this point has touched Photos in any way. macOS's
    // permission alert is all-or-nothing (see LivePhotosProvider.swift), so
    // the album choice made from tagit right after is the real safety
    // boundary: only that one album is ever fetched, served, or written to.
    do { try LivePhotosProvider.requestAccess() } catch { fail("\(error)") }

    if isTerminal {
        startServer()
        printPairing()
        scheduleIdleShutdown()
        RunLoop.main.run()
    } else {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.delegate = appDelegate
        startServer()
        refreshStatusMenu()
        scheduleIdleShutdown()
        app.run()
    }
}
