import Foundation

/// Error returned by the API (or a transport failure), with a message ready to show to the user.
struct APIError: LocalizedError {
    let status: Int
    let message: String

    var errorDescription: String? { message }

    static let network = APIError(status: 0, message: "No hay conexión con el servidor. Comprueba tu conexión a internet.")
}

/// Response body we don't need to read.
struct EmptyResponse: Decodable {}

/// HTTP client for the Runna.io API. Sends the session token as "Authorization: Bearer <token>".
final class APIClient {
    static let shared = APIClient()

    /// Called when the server rejects the session token (expired or revoked).
    var onUnauthorized: (@MainActor () -> Void)?

    private let tokenLock = NSLock()
    private var storedToken: String?

    /// Session token sent with every request (set by SessionStore).
    var sessionToken: String? {
        get {
            tokenLock.lock()
            defer { tokenLock.unlock() }
            return storedToken
        }
        set {
            tokenLock.lock()
            storedToken = newValue
            tokenLock.unlock()
        }
    }

    private let session: URLSession
    private let decoder = JSONDecoder()
    private let inFlightLock = NSLock()
    private var inFlight: [String: Task<Data, Error>] = [:]

    init() {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 120
        session = URLSession(configuration: configuration)
    }

    // MARK: - Requests

    /// Sends a request and decodes the JSON response.
    /// - Parameter token: overrides the session token (used to verify the email right after registering).
    func request<T: Decodable>(
        _ method: String,
        _ path: String,
        query: [String: String] = [:],
        body: [String: Any]? = nil,
        token: String? = nil,
        as type: T.Type = T.self
    ) async throws -> T {
        var request = try makeRequest(method, path, query: query, token: token)
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data
        if method == "GET" && body == nil {
            data = try await performGET(request, path: path, query: query, usesSessionToken: token == nil)
        } else {
            data = try await perform(request)
            noteMutation(method, path: path)
        }
        return try decode(T.self, from: data)
    }

    /// Sends a request and ignores the response body.
    func send(
        _ method: String,
        _ path: String,
        query: [String: String] = [:],
        body: [String: Any]? = nil,
        token: String? = nil
    ) async throws {
        let _: EmptyResponse = try await request(method, path, query: query, body: body, token: token)
    }

    /// Uploads a file as multipart/form-data.
    func upload<T: Decodable>(
        _ path: String,
        fileField: String,
        fileName: String,
        mimeType: String,
        fileData: Data,
        fields: [String: String] = [:],
        as type: T.Type = T.self
    ) async throws -> T {
        var request = try makeRequest("POST", path, query: [:], token: nil)
        let boundary = "Boundary-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        for (name, value) in fields {
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
            body.append("\(value)\r\n")
        }
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(fileName)\"\r\n")
        body.append("Content-Type: \(mimeType)\r\n\r\n")
        body.append(fileData)
        body.append("\r\n--\(boundary)--\r\n")
        request.httpBody = body

        let data = try await perform(request)
        noteMutation("POST", path: path)
        return try decode(T.self, from: data)
    }

    // MARK: - Cached GETs (stale-while-revalidate)

    /// GET returning the raw JSON body (also stored in the response cache).
    func getData(_ path: String, query: [String: String] = [:]) async throws -> Data {
        let request = try makeRequest("GET", path, query: query, token: nil)
        return try await performGET(request, path: path, query: query, usesSessionToken: true)
    }

    /// The last body received for this GET (memory, else the Caches directory), if any.
    func cachedData(_ path: String, query: [String: String] = [:]) -> Data? {
        ResponseCache.shared.entry(for: ResponseCache.key(path: path, query: query))?.data
    }

    /// The last body received for this GET, decoded; nil when there is none (or it no longer decodes).
    func cached<T: Decodable>(_ path: String, query: [String: String] = [:], as type: T.Type = T.self) -> T? {
        guard let data = cachedData(path, query: query) else { return nil }
        return try? decode(T.self, from: data)
    }

    /// True when this GET was answered less than `maxAge` seconds ago and nothing was changed since.
    func isCacheFresh(_ path: String, query: [String: String] = [:], maxAge: TimeInterval = ResponseCache.freshness) -> Bool {
        ResponseCache.shared.isFresh(ResponseCache.key(path: path, query: query), maxAge: maxAge)
    }

    /// Decodes a body obtained with `getData` / `cachedData`.
    func decodeBody<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try decode(T.self, from: data)
    }

    // MARK: - Internals

    private func makeRequest(_ method: String, _ path: String, query: [String: String], token: String?) throws -> URLRequest {
        guard var components = URLComponents(url: AppConfig.apiBaseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false) else {
            throw APIError(status: 0, message: "URL no válida")
        }
        if !query.isEmpty {
            components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { throw APIError(status: 0, message: "URL no válida") }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let authToken = token ?? sessionToken {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    /// Identical GETs in flight at the same time share one network request, and the body of a
    /// session GET is stored in the response cache. A cancelled caller still gets CancellationError,
    /// but the shared request finishes and fills the cache for the next visit.
    private func performGET(_ request: URLRequest, path: String, query: [String: String], usesSessionToken: Bool) async throws -> Data {
        let cache = ResponseCache.shared
        guard usesSessionToken, cache.isCacheable(path: path), let url = request.url else {
            return try await perform(request)
        }
        let cacheKey = ResponseCache.key(path: path, query: query)
        let flightKey = (request.value(forHTTPHeaderField: "Authorization") ?? "-") + " " + url.absoluteString
        let generation = cache.generation

        let task: Task<Data, Error> = sharedFlight(flightKey) {
            Task<Data, Error> {
                defer { self.endFlight(flightKey) }
                let requestedAt = Date()
                let data = try await self.perform(request)
                cache.store(data, for: cacheKey, generation: generation, requestedAt: requestedAt)
                return data
            }
        }
        let data = try await task.value
        try Task.checkCancellation()
        return data
    }

    /// The request in flight for this key, or a new one (synchronous: the lock never spans a suspension).
    private func sharedFlight(_ key: String, start: () -> Task<Data, Error>) -> Task<Data, Error> {
        inFlightLock.lock()
        defer { inFlightLock.unlock() }
        if let running = inFlight[key] { return running }
        let task = start()
        inFlight[key] = task
        return task
    }

    private func endFlight(_ key: String) {
        inFlightLock.lock()
        inFlight[key] = nil
        inFlightLock.unlock()
    }

    /// Requests that don't change anything the screens show (device registration, reports, invite links).
    private static let nonInvalidatingPrefixes = ["/api/push/", "/api/reports", "/api/friends/invite"]

    /// A request that changes data succeeded: cached GETs must be revalidated on the next visit.
    private func noteMutation(_ method: String, path: String) {
        guard method != "GET", !Self.nonInvalidatingPrefixes.contains(where: { path.hasPrefix($0) }) else { return }
        ResponseCache.shared.invalidateAll()
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw APIError.network
        }

        guard let http = response as? HTTPURLResponse else { throw APIError.network }
        guard (200..<300).contains(http.statusCode) else {
            // Only a rejected *session* token logs the user out (not a wrong password, nor a pending-verification token)
            if http.statusCode == 401,
               let sent = request.value(forHTTPHeaderField: "Authorization"),
               let current = sessionToken,
               sent == "Bearer \(current)" {
                if let handler = onUnauthorized {
                    await MainActor.run { handler() }
                }
            }
            throw APIError(status: http.statusCode, message: Self.errorMessage(from: data, status: http.statusCode))
        }
        return data
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        if T.self == EmptyResponse.self, let empty = EmptyResponse() as? T {
            return empty
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            #if DEBUG
            print("Decoding \(T.self) failed:", error)
            #endif
            throw APIError(status: 0, message: "Respuesta inesperada del servidor")
        }
    }

    static func errorMessage(from data: Data, status: Int) -> String {
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let message = object["error"] as? String, !message.isEmpty { return message }
            if let message = object["message"] as? String, !message.isEmpty { return message }
        }
        switch status {
        case 401: return "Tu sesión ha caducado. Vuelve a iniciar sesión."
        case 403: return "No tienes permiso para hacer esto."
        case 404: return "No encontrado."
        case 500...599: return "Error del servidor. Inténtalo de nuevo en unos minutos."
        default: return "Algo ha ido mal (\(status))."
        }
    }
}

private extension Data {
    mutating func append(_ string: String) {
        append(Data(string.utf8))
    }
}
