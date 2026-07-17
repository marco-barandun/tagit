import Foundation
import Network

/// A minimal, dependency-free HTTP/1.1 server for exactly this job: serve a
/// handful of JSON/JPEG endpoints to tagit, running on your own machine,
/// with nothing accepted from anywhere else.
///
/// Security properties, all deliberate:
///   - Every accepted connection is checked against its remote address before
///     a single byte is read from it; anything not from 127.0.0.1/::1 is
///     cancelled immediately. (Network.framework's `requiredLocalEndpoint`,
///     the "ask the OS to only bind loopback" mechanism, reliably fails with
///     EINVAL for listeners on this macOS build — confirmed via isolated
///     reproduction outside this codebase — so enforcement happens here,
///     at accept time, instead. Nothing from a non-loopback peer is ever
///     parsed or answered.)
///   - Every request must have an `Origin` header exactly matching the
///     allowlist, and (except CORS preflight) the correct pairing token.
///   - Answers Private Network Access preflights correctly, since Chrome
///     requires that for a public HTTPS page to reach a local server at all.
///   - One request per connection (`Connection: close`) — keeps the parsing
///     logic simple and avoids any request-smuggling surface from trying to
///     support keep-alive/pipelining we don't need.
final class HTTPServer {
    typealias Handler = (Request) -> Response

    struct Request {
        let method: String
        let path: String
        let headers: [String: String]   // lowercase keys
        let body: Data
    }
    struct Response {
        let status: Int
        let statusText: String
        var headers: [String: String] = [:]
        var body: Data = Data()

        static func json(_ object: Any, _ status: Int = 200) -> Response {
            let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
            return Response(status: status, statusText: Self.text(for: status),
                             headers: ["Content-Type": "application/json"], body: data)
        }
        static func jsonError(_ status: Int, _ message: String) -> Response {
            json(["error": message], status)
        }
        static func raw(_ status: Int = 200, contentType: String, body: Data) -> Response {
            Response(status: status, statusText: Self.text(for: status),
                      headers: ["Content-Type": contentType], body: body)
        }
        static func empty(_ status: Int) -> Response {
            Response(status: status, statusText: Self.text(for: status))
        }
        private static func text(for status: Int) -> String {
            switch status {
            case 200: return "OK"
            case 400: return "Bad Request"
            case 401: return "Unauthorized"
            case 403: return "Forbidden"
            case 404: return "Not Found"
            case 500: return "Internal Server Error"
            default: return "OK"
            }
        }
    }

    private let listener: NWListener
    private let allowedOrigins: Set<String>
    private var token: String
    private let route: (Request) -> Response
    private let queue = DispatchQueue(label: "photos-helper.http")

    /// Called (on the server queue) for every correctly-authenticated request
    /// — drives the idle-shutdown timer.
    var onActivity: (() -> Void)?

    /// Replace the pairing token — used when tagit launches the helper with
    /// a fresh pair secret in the tagitphotos:// URL (including re-launching
    /// while an older instance is still running: the URL is routed to the
    /// running instance, which simply adopts the new secret). Hops onto the
    /// server queue so it never races a token check mid-request.
    func updateToken(_ newToken: String) {
        queue.async { self.token = newToken }
    }

    init(port: UInt16, allowedOrigins: Set<String>, token: String, route: @escaping (Request) -> Response) throws {
        self.allowedOrigins = allowedOrigins
        self.token = token
        self.route = route

        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        self.listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
    }

    func start() {
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)
    }

    private func accept(_ connection: NWConnection) {
        guard Self.isLoopback(connection.endpoint) else {
            connection.cancel()
            return
        }
        connection.start(queue: queue)
        receiveRequest(on: connection, buffer: Data())
    }

    private static func isLoopback(_ endpoint: NWEndpoint) -> Bool {
        guard case let .hostPort(host, _) = endpoint else { return false }
        switch host {
        case .ipv4(let addr): return addr == .loopback
        case .ipv6(let addr): return addr == .loopback
        case .name(let name, _): return name == "localhost"
        @unknown default: return false
        }
    }

    private func receiveRequest(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let data, !data.isEmpty { buffer.append(data) }

            if let headerEnd = Self.range(of: "\r\n\r\n", in: buffer) {
                self.handleFullHeaders(connection: connection, buffer: buffer, headerEnd: headerEnd)
                return
            }
            if isComplete || error != nil {
                connection.cancel()
                return
            }
            self.receiveRequest(on: connection, buffer: buffer)
        }
    }

    private func handleFullHeaders(connection: NWConnection, buffer: Data, headerEnd: Range<Data.Index>) {
        let headerBytes = buffer[..<headerEnd.lowerBound]
        let headerText = String(decoding: headerBytes, as: UTF8.self)
        var lines = headerText.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { self.reject(connection, 400, "bad request"); return }
        let requestLine = lines.removeFirst().components(separatedBy: " ")
        guard requestLine.count >= 2 else { self.reject(connection, 400, "bad request line"); return }
        let method = requestLine[0]
        let path = requestLine[1]

        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }

        let bodyStart = headerEnd.upperBound
        let contentLength = Int(headers["content-length"] ?? "0") ?? 0
        let alreadyHave = buffer.count - buffer.distance(from: buffer.startIndex, to: bodyStart)
        if alreadyHave < contentLength {
            self.receiveBody(connection: connection, buffer: buffer, bodyStart: bodyStart,
                              contentLength: contentLength, method: method, path: path, headers: headers)
        } else {
            let body = buffer[bodyStart...].prefix(contentLength)
            self.dispatch(connection: connection, method: method, path: path, headers: headers, body: Data(body))
        }
    }

    private func receiveBody(connection: NWConnection, buffer: Data, bodyStart: Data.Index, contentLength: Int,
                              method: String, path: String, headers: [String: String]) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let data, !data.isEmpty { buffer.append(data) }
            let haveNow = buffer.count - buffer.distance(from: buffer.startIndex, to: bodyStart)
            if haveNow >= contentLength {
                let body = buffer[bodyStart...].prefix(contentLength)
                self.dispatch(connection: connection, method: method, path: path, headers: headers, body: Data(body))
                return
            }
            if isComplete || error != nil { connection.cancel(); return }
            self.receiveBody(connection: connection, buffer: buffer, bodyStart: bodyStart, contentLength: contentLength,
                              method: method, path: path, headers: headers)
        }
    }

    private func dispatch(connection: NWConnection, method: String, path: String, headers: [String: String], body: Data) {
        let origin = headers["origin"]
        let originAllowed = origin != nil && allowedOrigins.contains(origin!)

        // Requests with no Origin header can't come from a web page (browsers
        // always attach Origin to cross-origin fetches) — only from a local
        // process like curl or a newly-launched helper instance. Two tiny
        // exceptions exist for them, everything else stays origin-gated:
        //   - GET /health: lets a new helper instance detect a stale one
        //     (answers only "a helper lives here", nothing about the library).
        //   - POST /quit: lets anything local shut the helper down. That's
        //     fail-closed by design — the worst a local process can do with
        //     it is END access to your photos, never gain it.
        if origin == nil {
            if method == "GET", path == "/health" {
                send(Response.json(["helper": true]), on: connection)
            } else if method == "POST", path == "/quit" {
                send(Response.json(["ok": true]), on: connection)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
            } else {
                send(Response.jsonError(403, "origin not allowed"), on: connection)
            }
            return
        }

        // CORS preflight — answer it if (and only if) the Origin is one we
        // trust; otherwise just say nothing useful and let the browser's own
        // CORS enforcement do the rest.
        if method == "OPTIONS" {
            var resp = Response.empty(originAllowed ? 204 : 403)
            if originAllowed {
                resp.headers["Access-Control-Allow-Origin"] = origin!
                resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
                resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Tagit-Token"
                resp.headers["Access-Control-Allow-Private-Network"] = "true"
                resp.headers["Vary"] = "Origin"
            }
            send(resp, on: connection)
            return
        }

        guard originAllowed else {
            send(Response.jsonError(403, "origin not allowed"), on: connection)
            return
        }
        // /health is intentionally still token-gated — knowing the server is
        // there at all shouldn't be free to anyone but tagit with the code.
        guard headers["x-tagit-token"] == token else {
            send(withCors(Response.jsonError(401, "missing or incorrect pairing token"), origin: origin!), on: connection)
            return
        }
        onActivity?()

        let req = Request(method: method, path: path, headers: headers, body: body)
        let resp = withCors(route(req), origin: origin!)
        send(resp, on: connection)
    }

    private func withCors(_ resp: Response, origin: String) -> Response {
        var r = resp
        r.headers["Access-Control-Allow-Origin"] = origin
        r.headers["Vary"] = "Origin"
        return r
    }

    private func reject(_ connection: NWConnection, _ status: Int, _ message: String) {
        send(Response.jsonError(status, message), on: connection)
    }

    private func send(_ response: Response, on connection: NWConnection) {
        var head = "HTTP/1.1 \(response.status) \(response.statusText)\r\n"
        var headers = response.headers
        headers["Content-Length"] = String(response.body.count)
        headers["Connection"] = "close"
        for (k, v) in headers { head += "\(k): \(v)\r\n" }
        head += "\r\n"
        var out = Data(head.utf8)
        out.append(response.body)
        connection.send(content: out, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private static func range(of needle: String, in data: Data) -> Range<Data.Index>? {
        let needleBytes = Array(needle.utf8)
        guard !needleBytes.isEmpty, data.count >= needleBytes.count else { return nil }
        let end = data.count - needleBytes.count
        var i = data.startIndex
        var count = 0
        while count <= end {
            var matched = true
            for (offset, b) in needleBytes.enumerated() {
                if data[data.index(i, offsetBy: offset)] != b { matched = false; break }
            }
            if matched {
                let lower = i
                let upper = data.index(i, offsetBy: needleBytes.count)
                return lower..<upper
            }
            i = data.index(after: i)
            count += 1
        }
        return nil
    }
}
