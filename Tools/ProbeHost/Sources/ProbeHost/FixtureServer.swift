// SPDX-License-Identifier: GPL-3.0-or-later
//
// FixtureServer.swift - the offline half of the harness (00-index.md section 1).
//
// A ~200-line HTTP/1.1 listener on 127.0.0.1, built on Network.framework so the app
// keeps its "no third-party dependencies" promise. It exists for two reasons. The self
// check needs a page where one URL *must* be blocked and another *must* load, so that
// "0 requests blocked" on a live site is never ambiguous between "the filters did not
// block" and "the harness is not measuring". And the spike needs to be deterministic and
// offline, because a probe that depends on a public site reports the internet's mood
// rather than WebKit's behaviour.
//
// It serves files from the `fixtures/` folder inside the app bundle, nothing else, and
// counts what it served: a request that never arrives here is a request something
// blocked, which is the cleanest possible evidence of a block.

import Foundation
import Network

final class FixtureServer {
    private let log: Log
    private let clock: ProbeClock
    private let queue = DispatchQueue(label: "io.github.mioutic.probehost.fixtures")
    private let lock = NSLock()
    private var listener: NWListener?
    private var hits: [String: Int] = [:]
    private var connections: [ObjectIdentifier: NWConnection] = [:]

    private(set) var port: UInt16 = 0
    private(set) var root: URL?

    init(log: Log, clock: ProbeClock) {
        self.log = log
        self.clock = clock
        // The fixtures ship as a folder reference, so the directory shape inside the
        // .app is the directory shape in the repository.
        if let url = Bundle.main.url(forResource: "fixtures", withExtension: nil) {
            root = url
        } else if let resources = Bundle.main.resourceURL {
            let candidate = resources.appendingPathComponent("fixtures", isDirectory: true)
            root = FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
        }
    }

    /// Starts the listener and returns the port it bound. Blocking, with a five second
    /// deadline; the caller treats a failure as a harness failure, because every fixture
    /// scenario and the whole spike depend on it.
    @discardableResult
    func start(requestedPort: UInt16) throws -> UInt16 {
        guard let root = root, FileManager.default.fileExists(atPath: root.path) else {
            throw ProbeFailure(
                .internalError, "fixtures-missing",
                "the fixtures directory is not in the app bundle"
            )
        }

        // The documented way to bind a port: NWListener(using:on:). Setting
        // requiredLocalEndpoint on a *listener* is not what that property is specified
        // for, and if the combination never reaches .ready the five second deadline
        // throws - which would mean the gate scenario and the whole spike suite produce
        // no measurement at all. The IPv4-only protocol option keeps the bind off ::1
        // so the http://127.0.0.1:<port>/ URLs resolve to it.
        //
        // acceptLocalOnly is deliberately NOT set. It restricts the listener to peers
        // on a directly attached link, and loopback is not one of those. With it set,
        // the WebKit networking process - a different process from this app - completed
        // the handshake and was then dropped, which WKWebView reported as
        // NSURLErrorDomain -1005 with no failing URL while this server recorded no
        // request at all, so the gate could not tell a missing measurement from a
        // working block. The listener is kept off the wider network in `accept`
        // instead, by refusing any peer that is not loopback: a rule this file can
        // state, log, and be visibly wrong about.
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
            ip.version = .v4
        }

        let endpointPort: NWEndpoint.Port =
            requestedPort == 0 ? .any : (NWEndpoint.Port(rawValue: requestedPort) ?? .any)

        let listener: NWListener
        do {
            listener = try NWListener(using: parameters, on: endpointPort)
        } catch {
            throw ProbeFailure(
                .internalError, "listener-create",
                "NWListener could not be created: \(error.localizedDescription)"
            )
        }
        self.listener = listener

        let semaphore = DispatchSemaphore(value: 0)
        let state = StateBox()
        listener.stateUpdateHandler = { newState in
            switch newState {
            case .ready:
                state.ready = true
                semaphore.signal()
            case .failed(let error):
                state.error = error.localizedDescription
                semaphore.signal()
            case .cancelled:
                state.error = state.error ?? "cancelled"
                semaphore.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)

        if semaphore.wait(timeout: .now() + .seconds(5)) == .timedOut {
            listener.cancel()
            throw ProbeFailure(.internalError, "listener-timeout", "the fixture listener never became ready")
        }
        if let error = state.error {
            listener.cancel()
            throw ProbeFailure(.internalError, "listener-failed", "the fixture listener failed: \(error)")
        }
        guard let bound = listener.port?.rawValue else {
            listener.cancel()
            throw ProbeFailure(.internalError, "listener-no-port", "the fixture listener reported no port")
        }
        port = bound
        log.line("fixture server on http://127.0.0.1:\(bound)/ serving \(root.lastPathComponent)")
        return bound
    }

    func stop() {
        lock.lock()
        let open = Array(connections.values)
        connections.removeAll()
        lock.unlock()
        for connection in open { connection.cancel() }
        listener?.cancel()
        listener = nil
    }

    /// `fixture:/selftest.html` becomes `http://127.0.0.1:<port>/selftest.html`. The
    /// scenario file keeps the scheme so the URL in the repository says nothing about a
    /// port that only exists at run time.
    func resolve(_ url: String) -> String {
        guard url.hasPrefix("fixture:") else { return url }
        var path = String(url.dropFirst("fixture:".count))
        if !path.hasPrefix("/") { path = "/" + path }
        return "http://127.0.0.1:\(port)\(path)"
    }

    /// How many times a path was actually requested. Zero for a blocked resource is the
    /// evidence the self check is built on.
    func hitCount(_ path: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return hits[path] ?? 0
    }

    var servedPaths: [String: Int] {
        lock.lock()
        defer { lock.unlock() }
        return hits
    }

    // MARK: - Connections

    private func accept(_ connection: NWConnection) {
        // The peer check the NWParameters no longer do (see `start`). Anything that is
        // not loopback is dropped before a byte of it is read.
        guard FixtureServer.isLoopback(connection.endpoint) else {
            log.detail("fixture refused non-loopback peer \(connection.endpoint)")
            connection.cancel()
            return
        }
        log.detail("fixture accepted \(connection.endpoint)")

        lock.lock()
        connections[ObjectIdentifier(connection)] = connection
        lock.unlock()

        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed(let error):
                // A connection that reaches .failed never delivered a request, so
                // without this line the only evidence left is an empty hit table.
                self?.log.detail("fixture connection failed: \(error.localizedDescription)")
                self?.forget(connection)
            case .cancelled:
                self?.forget(connection)
            default:
                break
            }
        }
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func forget(_ connection: NWConnection) {
        lock.lock()
        connections.removeValue(forKey: ObjectIdentifier(connection))
        lock.unlock()
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) {
            [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            var accumulated = buffer
            if let data = data { accumulated.append(data) }
            if let error = error {
                self.log.detail("fixture receive error: \(error.localizedDescription)")
                connection.cancel()
                return
            }
            // One request per connection is all a fixture page needs; the response says
            // `Connection: close` and the connection is cancelled after it is written.
            if let headerEnd = FixtureServer.headerTerminator(in: accumulated) {
                let head = accumulated.prefix(upTo: headerEnd)
                self.respond(to: String(decoding: head, as: UTF8.self), on: connection)
                return
            }
            if isComplete || accumulated.count > 64 * 1024 {
                connection.cancel()
                return
            }
            self.receive(connection, buffer: accumulated)
        }
    }

    private func respond(to head: String, on connection: NWConnection) {
        // components(separatedBy:) rather than split(separator:): the separator is two
        // characters, and Foundation's String API is the one that takes a string.
        let firstLine = head.components(separatedBy: "\r\n").first ?? ""
        let parts = firstLine.split(separator: " ")
        guard parts.count >= 2 else {
            send(status: "400 Bad Request", body: Data(), type: "text/plain", on: connection)
            return
        }
        let method = String(parts[0])
        var path = String(parts[1])
        if let question = path.firstIndex(of: "?") { path = String(path[..<question]) }
        if path == "/" { path = "/index.html" }

        lock.lock()
        hits[path, default: 0] += 1
        lock.unlock()
        log.detail("fixture \(method) \(path)")

        guard let root = root,
              let file = FixtureServer.safeURL(root: root, path: path),
              let body = try? Data(contentsOf: file)
        else {
            send(
                status: "404 Not Found",
                body: Data("not a fixture: \(path)".utf8),
                type: "text/plain; charset=utf-8",
                on: connection
            )
            return
        }
        send(
            status: "200 OK",
            body: method == "HEAD" ? Data() : body,
            type: FixtureServer.contentType(for: file.pathExtension),
            length: body.count,
            on: connection
        )
    }

    private func send(
        status: String, body: Data, type: String, length: Int? = nil, on connection: NWConnection
    ) {
        var header = "HTTP/1.1 \(status)\r\n"
        header += "Content-Type: \(type)\r\n"
        header += "Content-Length: \(length ?? body.count)\r\n"
        header += "Cache-Control: no-store\r\n"
        header += "Connection: close\r\n\r\n"
        var response = Data(header.utf8)
        response.append(body)
        connection.send(content: response, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    // MARK: - Reachability

    /// Proves the listener is reachable before the suite blames the filters for a page
    /// that never loaded. Two legs, because they fail differently and the difference is
    /// the entire diagnosis: the raw NWConnection answers "is anything serving this
    /// port", and the URLSession request answers "does the URL loading system in this
    /// process agree to talk to it" - an App Transport Security refusal appears only in
    /// the second, and WKWebView reports one with the same -1005 a dropped connection
    /// gets. Neither leg blocks: the result is logged, and the navigation that needs it
    /// is a rule-list compile away.
    func verifyReachable() {
        guard port != 0, let endpointPort = NWEndpoint.Port(rawValue: port) else { return }
        let path = "/probe-reachability"

        let probe = NWConnection(host: .ipv4(.loopback), port: endpointPort, using: .tcp)
        probe.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                let request = "GET \(path) HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                    + "Connection: close\r\n\r\n"
                probe.send(content: Data(request.utf8), completion: .contentProcessed { _ in })
                probe.receive(minimumIncompleteLength: 1, maximumLength: 256) { data, _, _, _ in
                    let first = String(decoding: data ?? Data(), as: UTF8.self)
                        .components(separatedBy: "\r\n").first ?? ""
                    self?.log.line(
                        "fixture reachability tcp=\(first.isEmpty ? "no response" : first)"
                    )
                    probe.cancel()
                }
            case .failed(let error):
                self?.log.warn("fixture reachability tcp failed: \(error.localizedDescription)")
                probe.cancel()
            default:
                break
            }
        }
        probe.start(queue: queue)

        guard let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        // Ephemeral: nothing about a reachability check belongs in a cache that a later
        // scenario could read.
        let session = URLSession(configuration: .ephemeral)
        session.dataTask(with: request) { [weak self] _, response, error in
            if let error = error as NSError? {
                self?.log.warn(
                    "fixture reachability urlsession failed: \(error.domain) \(error.code) "
                        + "detail=\(error.localizedDescription)"
                )
            } else if let http = response as? HTTPURLResponse {
                self?.log.line("fixture reachability urlsession=\(http.statusCode)")
            }
            session.finishTasksAndInvalidate()
        }.resume()
    }

    // MARK: - Helpers

    /// Loopback and nothing else. Written against the address rather than a string so
    /// an IPv4-mapped IPv6 peer cannot spell its way past it.
    private static func isLoopback(_ endpoint: NWEndpoint) -> Bool {
        guard case let .hostPort(host, _) = endpoint else { return false }
        switch host {
        case .ipv4(let address):
            return address.isLoopback
        case .ipv6(let address):
            return address.isLoopback || (address.asIPv4?.isLoopback ?? false)
        default:
            return false
        }
    }

    private static func headerTerminator(in data: Data) -> Data.Index? {
        let marker = Data("\r\n\r\n".utf8)
        guard data.count >= marker.count else { return nil }
        return data.range(of: marker)?.lowerBound
    }

    /// No traversal, no symlinks out of the fixture directory, no absolute paths: the
    /// listener is loopback-only, but a fixture server that could serve the container
    /// would still be a bad thing to ship in an artifact-producing app.
    private static func safeURL(root: URL, path: String) -> URL? {
        let components = path.split(separator: "/").map(String.init)
        guard !components.isEmpty, !components.contains("..") else { return nil }
        var url = root
        for component in components { url.appendPathComponent(component) }
        let resolved = url.standardizedFileURL.path
        guard resolved.hasPrefix(root.standardizedFileURL.path) else { return nil }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: resolved, isDirectory: &isDirectory),
              !isDirectory.boolValue
        else { return nil }
        return url
    }

    private static func contentType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "svg": return "image/svg+xml"
        case "mp4": return "video/mp4"
        case "m3u8": return "application/vnd.apple.mpegurl"
        case "txt": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}

private final class StateBox {
    var ready = false
    var error: String?
}
