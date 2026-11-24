import SwiftUI
import AuthenticationServices
import CryptoKit

/// "Iniciar sesión con Apple" and "Continuar con Google" below the email forms. A new user then
/// picks a username and accepts the terms (14+) in a sheet; an existing one goes straight in.
struct AppleSignInSection: View {
    let isRegister: Bool

    @Environment(SessionStore.self) private var session
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var rawNonce = ""
    @State private var isLoading = false
    @State private var isLoadingGoogle = false
    @State private var errorMessage: String?
    @State private var pendingProfile: PendingAppleProfile?

    var body: some View {
        VStack(spacing: DS.Spacing.l) {
            HStack(spacing: DS.Spacing.m) {
                line
                Text("o")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                line
            }
            SignInWithAppleButton(isRegister ? .signUp : .signIn) { request in
                rawNonce = Self.randomNonce()
                request.requestedScopes = [.fullName, .email]
                request.nonce = Self.sha256(rawNonce)
            } onCompletion: { result in
                handle(result)
            }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(height: 50)
            .clipShape(RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous))
            .disabled(isLoading)
            .overlay {
                if isLoading { ProgressView() }
            }
            if GoogleSignIn.isEnabled {
                GoogleSignInButton(isLoading: isLoadingGoogle, action: signInWithGoogle)
                    .disabled(isLoading)
            }
        }
        .errorAlert($errorMessage)
        .sheet(item: $pendingProfile) { profile in
            AppleProfileSheet(profile: profile)
        }
    }

    private var line: some View {
        Rectangle()
            .fill(Color.secondary.opacity(0.25))
            .frame(height: 1)
    }

    private func signInWithGoogle() {
        isLoadingGoogle = true
        Task {
            defer { isLoadingGoogle = false }
            do {
                guard let credential = try await GoogleSignIn.signIn(using: webAuthenticationSession) else { return }
                try await finish(.google(credential))
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Sends the Apple / Google credential to the server; a new account goes on in the profile sheet.
    private func finish(_ social: SessionStore.SocialCredential) async throws {
        switch try await session.signIn(with: social) {
        case .signedIn:
            break
        case .needsProfile(let name, let suggestedUsername):
            Analytics.track("signup_started", ["method": social.analyticsMethod])
            pendingProfile = PendingAppleProfile(credential: social, name: name ?? "", username: suggestedUsername ?? "")
        }
    }

    private func handle(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case .failure(let error):
            // Closing Apple's sheet is not an error
            if (error as? ASAuthorizationError)?.code == .canceled { return }
            errorMessage = "No se pudo iniciar sesión con Apple. Inténtalo de nuevo."
        case .success(let authorization):
            guard let apple = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = apple.identityToken, let token = String(data: tokenData, encoding: .utf8) else {
                errorMessage = "Apple no ha devuelto los datos de la cuenta. Inténtalo de nuevo."
                return
            }
            let name = apple.fullName.map { PersonNameComponentsFormatter.localizedString(from: $0, style: .default) }?
                .trimmingCharacters(in: .whitespaces)
            let credential = SessionStore.AppleCredential(
                identityToken: token,
                authorizationCode: apple.authorizationCode.flatMap { String(data: $0, encoding: .utf8) },
                rawNonce: rawNonce,
                fullName: (name?.isEmpty ?? true) ? nil : name
            )
            isLoading = true
            Task {
                defer { isLoading = false }
                do {
                    try await finish(.apple(credential))
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    static func randomNonce(length: Int = 32) -> String {
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var generator = SystemRandomNumberGenerator()
        return String((0..<length).map { _ in charset[Int(generator.next() % UInt64(charset.count))] })
    }

    static func sha256(_ input: String) -> String {
        SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

struct PendingAppleProfile: Identifiable {
    let id = UUID()
    let credential: SessionStore.SocialCredential
    let name: String
    let username: String
}

/// New account with Apple or Google: name, username and the age / terms check (the email comes from
/// Apple / Google). Or, for someone who already has an account the email didn't match (Apple may
/// hide it; a Google account may use another address), their user and password link it.
private struct AppleProfileSheet: View {
    let profile: PendingAppleProfile

    private enum Mode: String, CaseIterable, Identifiable {
        case new = "Soy nuevo"
        case existing = "Ya tengo cuenta"
        var id: String { rawValue }
    }

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var mode: Mode = .new
    @State private var name = ""
    @State private var username = ""
    @State private var acceptedTerms = false
    @State private var linkIdentifier = ""
    @State private var linkPassword = ""
    @State private var isLoading = false
    @State private var errorMessage: String?

    private var validationMessage: String? {
        if name.trimmingCharacters(in: .whitespaces).isEmpty { return "Escribe tu nombre." }
        if username.trimmingCharacters(in: .whitespaces).count < 3 { return "El usuario debe tener al menos 3 caracteres." }
        if username.contains(" ") { return "El usuario no puede contener espacios." }
        if !acceptedTerms { return "Acepta los términos para continuar." }
        return nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("¿Tienes cuenta?", selection: $mode.animation(.snappy)) {
                        ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                if mode == .existing {
                    existingAccountSections
                } else {
                    newAccountSections
                }
            }
            .navigationTitle(mode == .new ? "Completa tu perfil" : "Vincula tu cuenta")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isLoading {
                        ProgressView()
                    } else {
                        Button(mode == .new ? "Crear cuenta" : "Vincular", action: mode == .new ? submit : link)
                            .bold()
                    }
                }
            }
            .errorAlert($errorMessage)
            .onAppear {
                if name.isEmpty { name = profile.name }
                if username.isEmpty { username = profile.username }
            }
        }
        .interactiveDismissDisabled(isLoading)
    }

    @ViewBuilder
    private var existingAccountSections: some View {
        Section {
            TextField("Usuario o email", text: $linkIdentifier)
                .textContentType(.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.emailAddress)
            SecureField("Contraseña", text: $linkPassword)
                .textContentType(.password)
        } footer: {
            Text("Entra con tu cuenta de KM2 y la vincularemos a tu \(profile.credential.accountName). Desde entonces podrás entrar con \(providerName) o con tu contraseña, y conservarás todo tu territorio.")
        }
    }

    private func link() {
        guard !linkIdentifier.trimmingCharacters(in: .whitespaces).isEmpty, !linkPassword.isEmpty else {
            errorMessage = "Escribe tu usuario o email y tu contraseña."
            return
        }
        isLoading = true
        Task {
            defer { isLoading = false }
            do {
                _ = try await session.signIn(with: profile.credential, link: (linkIdentifier, linkPassword))
                Analytics.track("\(profile.credential.analyticsMethod)_linked")
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    @ViewBuilder
    private var newAccountSections: some View {
        Section {
            TextField("Nombre", text: $name)
                .textContentType(.name)
            TextField("Usuario", text: $username)
                .textContentType(.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        } footer: {
            Text("Tus amigos te verán con este nombre y te encontrarán por tu usuario.")
        }
        Section {
            Toggle(isOn: $acceptedTerms) {
                Text(termsText)
                    .font(.footnote)
            }
            .tint(Color.brand)
        } footer: {
            Text("Necesitas tener al menos \(AppConfig.minimumAge) años para usar KM2.")
        }
    }

    private var providerName: String {
        switch profile.credential {
        case .apple: return "Apple"
        case .google: return "Google"
        }
    }

    private var termsText: AttributedString {
        let markdown = "Tengo al menos \(AppConfig.minimumAge) años y acepto los [términos](\(AppConfig.termsURL.absoluteString)) y la [política de privacidad](\(AppConfig.privacyURL.absoluteString))"
        return (try? AttributedString(markdown: markdown)) ?? AttributedString("Tengo al menos \(AppConfig.minimumAge) años y acepto los términos y la política de privacidad")
    }

    private func submit() {
        if let validationMessage {
            errorMessage = validationMessage
            return
        }
        isLoading = true
        Task {
            defer { isLoading = false }
            do {
                _ = try await session.signIn(
                    with: profile.credential,
                    username: username,
                    name: name.trimmingCharacters(in: .whitespaces),
                    acceptedTerms: acceptedTerms
                )
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
