import Foundation
import SwiftUI

enum Format {
    private static let spanish = Locale(identifier: "es_ES")

    private static func number(_ value: Double, decimals: Int) -> String {
        value.formatted(.number.precision(.fractionLength(decimals)).locale(spanish))
    }

    /// Area in m²: km² from 0.05 km² up, m² below (same rule as the web app).
    static func area(_ squareMeters: Double) -> String {
        let parts = areaParts(squareMeters)
        return "\(parts.value) \(parts.unit)"
    }

    static func areaParts(_ squareMeters: Double) -> (value: String, unit: String) {
        let sign = squareMeters < 0 ? "-" : ""
        let absolute = abs(squareMeters)
        let km2 = absolute / 1_000_000
        if km2 >= 0.05 {
            return (sign + number(km2, decimals: 2), "km²")
        }
        return (sign + number(absolute.rounded(), decimals: 0), "m²")
    }

    static func distance(_ meters: Double) -> String {
        if meters >= 1000 {
            return "\(number(meters / 1000, decimals: 2)) km"
        }
        return "\(Int(meters.rounded())) m"
    }

    /// 1:05:03 or 05:03
    static func duration(_ seconds: Int) -> String {
        let total = max(0, seconds)
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, secs)
        }
        return String(format: "%02d:%02d", minutes, secs)
    }

    /// Pace in min/km ("5:32 /km"), or "--" without enough data.
    static func pace(distanceMeters: Double, seconds: Int) -> String {
        guard distanceMeters >= 50, seconds > 0 else { return "--" }
        let secondsPerKm = Double(seconds) / (distanceMeters / 1000)
        guard secondsPerKm.isFinite, secondsPerKm < 60 * 60 else { return "--" }
        let minutes = Int(secondsPerKm) / 60
        let secs = Int(secondsPerKm) % 60
        return String(format: "%d:%02d /km", minutes, secs)
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "es_ES")
        formatter.unitsStyle = .short
        return formatter
    }()

    static func relative(_ date: Date?) -> String {
        guard let date else { return "" }
        if abs(date.timeIntervalSinceNow) < 60 { return "ahora" }
        return relativeFormatter.localizedString(for: date, relativeTo: Date())
    }

    static func dayAndTime(_ date: Date?) -> String {
        guard let date else { return "" }
        return date.formatted(.dateTime.day().month(.abbreviated).hour().minute().locale(spanish))
    }

    static func day(_ date: Date?) -> String {
        guard let date else { return "" }
        return date.formatted(.dateTime.day().month(.wide).year().locale(spanish))
    }
}

extension Color {
    /// Brand green (#16A34A).
    static let brand = Color(red: 0x16 / 255, green: 0xA3 / 255, blue: 0x4A / 255)

    /// "#RRGGBB" → Color (gray if the string isn't a hex colour).
    init(hex: String) {
        var text = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = UInt32(text, radix: 16) else {
            self = .gray
            return
        }
        self = Color(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}
