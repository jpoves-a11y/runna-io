import Foundation
import UIKit

/// Product analytics sent to our own server (POST /api/events), never to third parties: which screens
/// are used and where new users drop off (admin panel → Estadísticas). Events are buffered on disk and
/// sent in batches every 30 seconds while the app is open, and when it goes to the background.
/// Before signing in they wait until there is a session.
@MainActor
final class Analytics {
    static let shared = Analytics()

    private let bufferKey = "analytics.buffer"
    private let installKey = "analytics.installId"
    private let maxBuffered = 300
    private let batchSize = 50
    private var buffer: [[String: Any]]
    private var isSending = false
    private var timer: Timer?

    private init() {
        buffer = UserDefaults.standard.array(forKey: bufferKey) as? [[String: Any]] ?? []
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
            Task { @MainActor in Analytics.shared.flush() }
        }
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { Analytics.shared.flush() }
        }
    }

    /// Records an event. Props: short strings, numbers and booleans (anything else is dropped).
    static func track(_ name: String, _ props: [String: Any] = [:]) {
        shared.record(name, props)
    }

    /// Identifies this installation (survives sign-out; reset when the app is deleted).
    var installId: String {
        if let id = UserDefaults.standard.string(forKey: installKey) { return id }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: installKey)
        return id
    }

    private static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private func record(_ name: String, _ props: [String: Any]) {
        var clean: [String: Any] = [:]
        for (key, value) in props {
            switch value {
            case let text as String: clean[key] = String(text.prefix(80))
            case let flag as Bool: clean[key] = flag
            case let number as Int: clean[key] = number
            case let number as Double where number.isFinite: clean[key] = number
            default: continue
            }
        }
        var event: [String: Any] = ["name": name, "at": Self.iso.string(from: Date())]
        if !clean.isEmpty { event["props"] = clean }
        buffer.append(event)
        if buffer.count > maxBuffered { buffer.removeFirst(buffer.count - maxBuffered) }
        persist()
    }

    private func persist() {
        UserDefaults.standard.set(buffer, forKey: bufferKey)
    }

    func flush() {
        guard !isSending, !buffer.isEmpty, APIClient.shared.sessionToken != nil else { return }
        isSending = true
        let batch = Array(buffer.prefix(batchSize))
        let info = Bundle.main.infoDictionary
        let version = "\(info?["CFBundleShortVersionString"] as? String ?? "?") (\(info?["CFBundleVersion"] as? String ?? "?"))"
        Task {
            defer { isSending = false }
            do {
                try await APIClient.shared.send("POST", "/api/events", body: [
                    "installId": installId,
                    "appVersion": version,
                    "events": batch,
                ])
                // Drop what was sent (new events may have arrived meanwhile)
                buffer.removeFirst(min(batch.count, buffer.count))
                persist()
                if buffer.count >= batchSize { flush() }
            } catch {
                // Offline or server error: they stay buffered for the next try
            }
        }
    }
}
