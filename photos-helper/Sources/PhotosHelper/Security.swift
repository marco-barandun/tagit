import Foundation

/// Everything that keeps this server from being usable by anything except
/// tagit, running from an origin you've explicitly approved, with the
/// pairing code you were shown when the helper started.
enum Security {
    /// Random, URL-safe, shown once in the terminal banner. Every request
    /// (other than a CORS preflight, which browsers send with no custom
    /// headers) must include this as `X-Tagit-Token`. Knowing the right
    /// Origin isn't enough on its own — you also have to have actually seen
    /// this terminal window.
    static func generateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        let result = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(result == errSecSuccess, "could not generate a secure random token")
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Origins allowed to talk to this server. Both the real hosted site and
    /// the local dev server tagit has been running from this session — edit
    /// this list (or pass --origin) if you serve tagit from somewhere else.
    static func defaultAllowedOrigins() -> Set<String> {
        [
            "https://marco-barandun.github.io",
            "http://localhost:8777",
            "http://127.0.0.1:8777",
        ]
    }
}
