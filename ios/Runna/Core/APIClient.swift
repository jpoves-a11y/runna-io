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
        let data = try await perform(request)
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
        return try decode(T.self, from: data)
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
