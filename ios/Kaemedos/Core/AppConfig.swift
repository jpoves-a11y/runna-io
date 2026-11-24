import Foundation

enum AppConfig {
    /// Cloudflare Worker that serves the KM2 API.
    /// Debug builds can point elsewhere with the KAEMEDOS_API_BASE_URL environment variable (used by the e2e tests).
    static let apiBaseURL: URL = {
        #if DEBUG
        if let override = ProcessInfo.processInfo.environment["KAEMEDOS_API_BASE_URL"], let url = URL(string: override) {
            return url
        }
        #endif
        return URL(string: "https://runna-io-api.runna-io-api.workers.dev")!
    }()

    /// Custom URL scheme registered in Info.plist (OAuth returns and friend invites).
    static let urlScheme = "runnaio"

    /// Privacy policy, terms and support pages, served as static HTML by the Worker.
    static var privacyURL: URL { apiBaseURL.appendingPathComponent("privacy") }
    static var termsURL: URL { apiBaseURL.appendingPathComponent("terms") }
    static var supportURL: URL { apiBaseURL.appendingPathComponent("support") }

    /// Support contact (same address as the support page).
    static let supportEmail = "kaeme2.support@gmail.com"
    static var supportMailURL: URL? {
        URL(string: "mailto:\(supportEmail)?subject=Soporte%20KM2")
    }

    /// Strava connection offered in Perfil → Servicios conectados. Off until Strava approves the app
    /// (until then its API admits only the developer's own athlete). A user who is already connected
    /// still sees the row, to disconnect.
    static let stravaEnabled = false

    /// OAuth client ID of the iOS app in Google Cloud (APIs & Services → Credentials → OAuth client
    /// ID, type iOS, bundle com.jpoves.runnaio). Not secret. Empty: the Google button is hidden.
    /// The Worker must list the same ID in GOOGLE_CLIENT_IDS.
    static let googleClientID = "872664300416-tmr9ipo7n8tnjhf2rrnhta9lqr9fu4bd.apps.googleusercontent.com"

    /// The redirect of the Google sign-in: the client ID reversed, as Google expects for iOS clients
    /// ("com.googleusercontent.apps.<id>"). Nil when Google sign-in is off.
    static var googleRedirectScheme: String? {
        let suffix = ".apps.googleusercontent.com"
        guard googleClientID.hasSuffix(suffix) else { return nil }
        return "com.googleusercontent.apps." + googleClientID.dropLast(suffix.count)
    }

    /// Minimum age to use the app (Terms, "Elegibilidad").
    static let minimumAge = 14

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
