import Foundation

/// Reads and writes caption/keywords on a specific Photos.app media item via
/// Apple Events (AppleScript automation) — the only sanctioned way to touch
/// this data; PhotosKit's public API doesn't expose it (verified directly
/// against the Photos.framework headers, not just documentation).
///
/// Triggers macOS's own "tagit Photos helper wants to control Photos"
/// Automation permission prompt the first time it runs — separate from, and
/// in addition to, the Photos-library-access permission.
enum PhotosScripting {
    /// AppleScript string literals only need `\` and `"` escaped — but since
    /// caption/keyword text ultimately comes from the web page, this escaping
    /// is a real security boundary (preventing script injection via a caption
    /// containing a stray quote), not just a correctness nicety. Every piece
    /// of external text MUST go through this before being spliced into a
    /// script string.
    private static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
         .replacingOccurrences(of: "\"", with: "\\\"")
    }

    private static func run(_ source: String) throws -> NSAppleEventDescriptor {
        guard let script = NSAppleScript(source: source) else {
            throw HelperError(message: "could not compile AppleScript")
        }
        var errorDict: NSDictionary?
        let result = script.executeAndReturnError(&errorDict)
        if let errorDict {
            let message = errorDict[NSAppleScript.errorMessage] as? String ?? "unknown AppleScript error"
            throw HelperError(message: "Photos automation failed: \(message)")
        }
        return result
    }

    /// Reads caption+keywords for many photos in one script execution per
    /// 100-photo chunk (a per-photo script compile+execute made big albums
    /// take minutes to list). Best-effort by design: photos whose lookup
    /// fails are simply absent from the result, never aborting the batch.
    static func getCaptionsAndKeywords(ids: [String]) -> [String: (caption: String, keywords: [String])] {
        var out: [String: (caption: String, keywords: [String])] = [:]
        var start = 0
        while start < ids.count {
            let chunk = Array(ids[start..<min(start + 100, ids.count)])
            start += 100
            let listLiteral = chunk.map { "\"\(escape($0))\"" }.joined(separator: ", ")
            let source = """
            tell application "Photos"
                set resultList to {}
                repeat with tid in {\(listLiteral)}
                    try
                        set m to media item id (tid as text)
                        set d to description of m
                        if d is missing value then set d to ""
                        set kws to keywords of m
                        if kws is missing value then set kws to {}
                        set end of resultList to {tid as text, d, kws}
                    on error
                        set end of resultList to {tid as text, "", {}}
                    end try
                end repeat
                return resultList
            end tell
            """
            guard let result = try? run(source), result.numberOfItems > 0 else { continue }
            for i in 1...result.numberOfItems {
                guard let entry = result.atIndex(i), entry.numberOfItems >= 2,
                      let id = entry.atIndex(1)?.stringValue, !id.isEmpty else { continue }
                let caption = entry.atIndex(2)?.stringValue ?? ""
                var keywords: [String] = []
                if let kwList = entry.atIndex(3), kwList.numberOfItems > 0 {
                    for k in 1...kwList.numberOfItems {
                        if let s = kwList.atIndex(k)?.stringValue { keywords.append(s) }
                    }
                }
                out[id] = (caption, keywords)
            }
        }
        return out
    }

    static func setCaptionAndKeywords(id: String, caption: String, keywords: [String]) throws {
        let keywordLiteral = keywords.map { "\"\(escape($0))\"" }.joined(separator: ", ")
        let source = """
        tell application "Photos"
            set targetItem to media item id "\(escape(id))"
            set description of targetItem to "\(escape(caption))"
            set keywords of targetItem to {\(keywordLiteral)}
        end tell
        """
        _ = try run(source)
    }
}
