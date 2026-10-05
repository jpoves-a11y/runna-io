import Foundation

/// Lenient readers: the API is backed by SQLite, so numbers sometimes arrive as strings,
/// booleans as 0/1 and nested JSON as strings.
extension KeyedDecodingContainer {
    func string(_ key: Key) -> String? {
        if let value = try? decodeIfPresent(String.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Double.self, forKey: key) {
            return value == value.rounded() ? String(Int(value)) : String(value)
        }
        return nil
    }

    func double(_ key: Key) -> Double? {
        if let value = try? decodeIfPresent(Double.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(String.self, forKey: key) { return Double(value) }
        return nil
    }

    func int(_ key: Key) -> Int? {
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Double.self, forKey: key) { return Int(value) }
        if let value = try? decodeIfPresent(String.self, forKey: key) { return Int(value) }
        return nil
    }

    func bool(_ key: Key) -> Bool? {
        if let value = try? decodeIfPresent(Bool.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return value != 0 }
        return nil
    }

    /// A value that may be sent as an object or as a JSON-encoded string.
    func embedded<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        if let value = try? decodeIfPresent(T.self, forKey: key) { return value }
        if let text = try? decodeIfPresent(String.self, forKey: key), let data = text.data(using: .utf8) {
            return try? JSONDecoder().decode(T.self, from: data)
        }
        return nil
    }

    /// A value that may be sent as JSON or as a JSON-encoded string, returned as Foundation objects.
    func jsonObject(_ key: Key) -> Any? {
        if let text = try? decodeIfPresent(String.self, forKey: key) {
            return text.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) }
        }
        if let value = try? decodeIfPresent(JSONValue.self, forKey: key) {
            return value.foundationValue
        }
        return nil
    }
}

/// Any JSON value.
enum JSONValue: Decodable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    var foundationValue: Any {
        switch self {
        case .string(let value): return value
        case .number(let value): return value
        case .bool(let value): return value
        case .array(let values): return values.map { $0.foundationValue }
        case .object(let values): return values.mapValues { $0.foundationValue }
        case .null: return NSNull()
        }
    }
}

/// Coordinates stored as [[lat, lng], ...], possibly JSON-encoded (possibly twice, for old routes).
enum CoordinateList {
    static func parse(_ value: Any?) -> [[Double]] {
        var current = value
        for _ in 0..<2 {
            if let text = current as? String, let data = text.data(using: .utf8) {
                current = try? JSONSerialization.jsonObject(with: data)
            }
        }
        guard let array = current as? [Any] else { return [] }
        return array.compactMap { item -> [Double]? in
            if let pair = item as? [Any], pair.count >= 2,
               let lat = (pair[0] as? NSNumber)?.doubleValue,
               let lng = (pair[1] as? NSNumber)?.doubleValue {
                return [lat, lng]
            }
            if let point = item as? [String: Any],
               let lat = (point["lat"] as? NSNumber)?.doubleValue,
               let lng = (point["lng"] as? NSNumber)?.doubleValue {
                return [lat, lng]
            }
            return nil
        }
    }
}

/// Dates from the API come as ISO 8601 ("2026-01-15T10:30:00.000Z") or SQLite text ("2026-01-15 10:30:00", UTC).
enum APIDate {
    private static let isoWithFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let sqlite: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter
    }()

    static func parse(_ text: String?) -> Date? {
        guard let text, !text.isEmpty else { return nil }
        return isoWithFraction.date(from: text) ?? iso.date(from: text) ?? sqlite.date(from: text)
    }

    static func string(_ date: Date) -> String {
        isoWithFraction.string(from: date)
    }
}
