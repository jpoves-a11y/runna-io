import SwiftUI
import AuthenticationServices
import CryptoKit

/// Sign in with Google without Google's SDK: OAuth 2.0 with PKCE in the system's web sheet (the
/// iOS client of the Google Cloud project), then the code is exchanged for an ID token, which the
/// app sends to the Worker (POST /api/auth/google). Off while `AppConfig.googleClientID` is empty.
enum GoogleSignIn {
    static var isEnabled: Bool {
        #if DEBUG
        if showButtonForScreenshots { return true }
        #endif
        return AppConfig.googleRedirectScheme != nil
    }

    #if DEBUG
    /// runnaio://auth shows the button even without a client ID (e2e screenshots).
    static var showButtonForScreenshots = false
    #endif

    enum Failure: LocalizedError {
        case notConfigured, noCode, badState, exchange(String)

        var errorDescription: String? {
            switch self {
            case .notConfigured: return "El inicio de sesión con Google no está disponible."
            case .noCode, .badState: return "Google no ha devuelto los datos de la cuenta. Inténtalo de nuevo."
            case .exchange(let message): return message
            }
        }
    }

    /// Opens Google's sign-in and returns its ID token, or nil when the user closed the sheet.
    @MainActor
    static func signIn(using session: WebAuthenticationSession) async throws -> SessionStore.GoogleCredential? {
        guard let scheme = AppConfig.googleRedirectScheme else { throw Failure.notConfigured }
        let redirectURI = "\(scheme):/oauth2redirect"
        let verifier = randomString(length: 64)
        let state = randomString(length: 24)
        let nonce = randomString(length: 32)

        var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: AppConfig.googleClientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: "openid email profile"),
            URLQueryItem(name: "code_challenge", value: codeChallenge(for: verifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "nonce", value: nonce),
            URLQueryItem(name: "prompt", value: "select_account"),
        ]

        let callback: URL
        do {
            callback = try await session.authenticate(using: components.url!, callbackURLScheme: scheme, preferredBrowserSession: .shared)
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            return nil
        }
        let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if query.first(where: { $0.name == "error" })?.value == "access_denied" { return nil }
        guard query.first(where: { $0.name == "state" })?.value == state else { throw Failure.badState }
        guard let code = query.first(where: { $0.name == "code" })?.value, !code.isEmpty else { throw Failure.noCode }

        let idToken = try await exchange(code: code, verifier: verifier, redirectURI: redirectURI)
        return SessionStore.GoogleCredential(idToken: idToken, nonce: nonce)
    }

    /// Code → ID token at Google's token endpoint (an iOS client has no secret: PKCE proves the app).
    private static func exchange(code: String, verifier: String, redirectURI: String) async throws -> String {
        var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [
            URLQueryItem(name: "client_id", value: AppConfig.googleClientID),
            URLQueryItem(name: "code", value: code),
            URLQueryItem(name: "code_verifier", value: verifier),
            URLQueryItem(name: "grant_type", value: "authorization_code"),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
        ]
        // URLComponents leaves "+" as is; in a form body it would mean a space
        request.httpBody = form.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard (response as? HTTPURLResponse)?.statusCode == 200, let idToken = json?["id_token"] as? String else {
            throw Failure.exchange("No se pudo iniciar sesión con Google. Inténtalo de nuevo.")
        }
        return idToken
    }

    private static func randomString(length: Int) -> String {
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._~")
        var generator = SystemRandomNumberGenerator()
        return String((0..<length).map { _ in charset[Int(generator.next() % UInt64(charset.count))] })
    }

    private static func codeChallenge(for verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8)))
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// "Continuar con Google", following Google's branding: the coloured G on white (light) or on near
/// black (dark), with a thin outline; the same size and corners as the Apple button above it.
struct GoogleSignInButton: View {
    var isLoading = false
    let action: () -> Void

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image("GoogleG")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 18, height: 18)
                Text("Continuar con Google")
                    .font(.system(size: 19, weight: .medium))
            }
            .foregroundStyle(colorScheme == .dark ? Color(white: 0.89) : Color(white: 0.12))
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(colorScheme == .dark ? Color(white: 0.075) : Color.white,
                        in: RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous)
                    .strokeBorder(colorScheme == .dark ? Color(white: 0.56) : Color(white: 0.46), lineWidth: 1)
            }
            .opacity(isLoading ? 0.5 : 1)
            .overlay { if isLoading { ProgressView() } }
        }
        .buttonStyle(.pressable)
        .disabled(isLoading)
        .accessibilityLabel("Continuar con Google")
    }
}
