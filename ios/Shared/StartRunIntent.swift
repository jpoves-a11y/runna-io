import AppIntents
import Foundation

/// "Empezar una carrera": Siri, Shortcuts, the Action button and the Control Center / lock screen
/// control. Opens the app on the run screen and starts recording (if location is allowed).
/// Compiled in the app and in the widget extension; with openAppWhenRun the system runs it in the app.
struct StartRunIntent: AppIntent {
    static let title: LocalizedStringResource = "Empezar una carrera"
    static let description = IntentDescription("Abre KM2 y empieza a grabar una carrera.")
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        StartRunRequest.post(source: "intent")
        return .result()
    }
}

/// A request to open the run screen and start recording, picked up by the app's main screen
/// (works when the app was closed: the request waits a minute for it).
enum StartRunRequest {
    static let notification = Notification.Name("runna.startRunRequested")
    private static let timeKey = "startRunRequest.at"
    private static let sourceKey = "startRunRequest.source"

    static func post(source: String) {
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: timeKey)
        UserDefaults.standard.set(source, forKey: sourceKey)
        NotificationCenter.default.post(name: notification, object: nil)
    }

    /// The pending request's source ("intent", "link"), once; nil when there is none or it's stale.
    static func consume() -> String? {
        let defaults = UserDefaults.standard
        let at = defaults.double(forKey: timeKey)
        let source = defaults.string(forKey: sourceKey) ?? "intent"
        defaults.removeObject(forKey: timeKey)
        defaults.removeObject(forKey: sourceKey)
        guard at > 0, Date().timeIntervalSince1970 - at < 60 else { return nil }
        return source
    }
}
