import Foundation

enum AppConfig {
    /// Cloudflare Worker that serves the Runna.io API.
    /// Debug builds can point elsewhere with the RUNNA_API_BASE_URL environment variable (used by the e2e tests).
    static let apiBaseURL: URL = {
        #if DEBUG
        if let override = ProcessInfo.processInfo.environment["RUNNA_API_BASE_URL"], let url = URL(string: override) {
            return url
        }
        #endif
        return URL(string: "https://runna-io-api.runna-io-api.workers.dev")!
    }()

    /// Web app (privacy policy, terms, support pages).
    static let webBaseURL = URL(string: "https://runna-io.pages.dev")!

    /// Custom URL scheme registered in Info.plist (OAuth returns and friend invites).
    static let urlScheme = "runnaio"

    static var privacyURL: URL { webBaseURL.appendingPathComponent("privacy") }
    static var termsURL: URL { webBaseURL.appendingPathComponent("terms") }
    static var supportURL: URL { webBaseURL.appendingPathComponent("support") }

    /// Zaragoza, used to center the map before the first location fix.
    static let defaultLatitude = 41.6488
    static let defaultLongitude = -0.8891

    /// Colours a user can pick for their territory (same palette as the web app).
    static let userColors: [String] = [
        "#E41A1C", "#377EB8", "#4DAF4A", "#984EA3", "#FF7F00", "#A65628",
        "#F781BF", "#999999", "#A0E550", "#FC8D62", "#8DA0CB", "#E78AC3",
    ]

    static let userColorNames: [String: String] = [
        "#E41A1C": "Rojo", "#377EB8": "Azul", "#4DAF4A": "Verde", "#984EA3": "Morado",
        "#FF7F00": "Naranja", "#A65628": "Marrón", "#F781BF": "Rosa", "#999999": "Gris",
        "#A0E550": "Verde pistacho", "#FC8D62": "Coral", "#8DA0CB": "Lavanda", "#E78AC3": "Rosa magenta",
    ]
}
