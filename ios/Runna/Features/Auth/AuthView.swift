import SwiftUI

struct AuthView: View {
    @Environment(SessionStore.self) private var session

    enum Mode: String, CaseIterable, Identifiable {
        case login = "Iniciar sesión"
        case register = "Registrarse"
        var id: String { rawValue }
    }

    @State private var mode: Mode = .login

    var body: some View {
        if session.pendingVerification != nil {
            VerifyEmailView()
        } else {
            ScrollView {
                VStack(spacing: 28) {
                    header
                    Picker("Modo", selection: $mode) {
                        ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)

                    switch mode {
                    case .login: LoginForm()
                    case .register: RegisterForm()
                    }
                }
                .padding(24)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color(.systemGroupedBackground).ignoresSafeArea())
        }
    }

    private var header: some View {
        VStack(spacing: 10) {
            Image(systemName: "figure.run.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(.white, Color.brand)
            Text("Runna.io")
                .font(.largeTitle.bold())
            Text("Corre y conquista tu ciudad")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 32)
    }
}

private struct LoginForm: View {
    @Environment(SessionStore.self) private var session
    @State private var identifier = ""
    @State private var password = ""
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 14) {
            TextField("Usuario o email", text: $identifier)
                .textContentType(.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.emailAddress)
                .authField()
            SecureField("Contraseña", text: $password)
                .textContentType(.password)
                .authField()
                .onSubmit(submit)

            Button(action: submit) {
                if isLoading { ProgressView().tint(.white) } else { Text("Entrar") }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(isLoading || identifier.isEmpty || password.isEmpty)
            .padding(.top, 6)
        }
        .errorAlert($errorMessage)
    }

    private func submit() {
        guard !identifier.isEmpty, !password.isEmpty, !isLoading else { return }
        isLoading = true
        Task {
            do {
                try await session.login(identifier: identifier, password: password)
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }
}

private struct RegisterForm: View {
    @Environment(SessionStore.self) private var session
    @State private var name = ""
    @State private var username = ""
    @State private var email = ""
    @State private var password = ""
    @State private var acceptedTerms = false
    @State private var isLoading = false
    @State private var errorMessage: String?

    private var validationMessage: String? {
        if name.trimmingCharacters(in: .whitespaces).isEmpty { return "Escribe tu nombre" }
        if username.trimmingCharacters(in: .whitespaces).count < 3 { return "El usuario debe tener al menos 3 caracteres" }
        if username.contains(" ") { return "El usuario no puede tener espacios" }
        if !email.contains("@") || !email.contains(".") { return "Escribe un email válido" }
        if password.count < 6 { return "La contraseña debe tener al menos 6 caracteres" }
        if !acceptedTerms { return "Acepta los términos para continuar" }
        return nil
    }

    var body: some View {
        VStack(spacing: 14) {
            TextField("Nombre", text: $name)
                .textContentType(.name)
                .authField()
            TextField("Usuario", text: $username)
                .textContentType(.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .authField()
            TextField("Email", text: $email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .authField()
            SecureField("Contraseña (mín. 6 caracteres)", text: $password)
                .textContentType(.newPassword)
                .authField()

            Toggle(isOn: $acceptedTerms) {
                Text(termsText)
                    .font(.footnote)
            }
            .toggleStyle(.switch)
            .tint(.brand)

            Button(action: submit) {
                if isLoading { ProgressView().tint(.white) } else { Text("Crear cuenta") }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(isLoading)
            .padding(.top, 6)
        }
        .errorAlert($errorMessage)
    }

    private var termsText: AttributedString {
        let markdown = "Acepto los [términos](\(AppConfig.termsURL.absoluteString)) y la [política de privacidad](\(AppConfig.privacyURL.absoluteString))"
        return (try? AttributedString(markdown: markdown)) ?? AttributedString("Acepto los términos y la política de privacidad")
    }

    private func submit() {
        if let validationMessage {
            errorMessage = validationMessage
            return
        }
        isLoading = true
        Task {
            do {
                try await session.register(name: name, username: username, email: email, password: password)
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }
}

struct VerifyEmailView: View {
    @Environment(SessionStore.self) private var session
    @State private var code = ""
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var info: String?
    @State private var resendAvailableAt = Date()

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            Image(systemName: "envelope.badge.fill")
                .font(.system(size: 60))
                .foregroundStyle(Color.brand)
            Text("Verifica tu email")
                .font(.title.bold())
            Text("Hemos enviado un código de 6 dígitos a\n**\(session.pendingVerification?.email ?? "")**")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)

            TextField("123456", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .font(.system(size: 32, weight: .bold, design: .monospaced))
                .multilineTextAlignment(.center)
                .authField()
                .onChange(of: code) { _, newValue in
                    let digits = String(newValue.filter(\.isNumber).prefix(6))
                    if digits != newValue { code = digits }
                    if digits.count == 6 { submit() }
                }

            Button(action: submit) {
                if isLoading { ProgressView().tint(.white) } else { Text("Verificar") }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(code.count != 6 || isLoading)

            TimelineView(.periodic(from: .now, by: 1)) { context in
                let remaining = Int(resendAvailableAt.timeIntervalSince(context.date).rounded(.up))
                Button(remaining > 0 ? "Reenviar código (\(remaining)s)" : "Reenviar código") {
                    resend()
                }
                .disabled(remaining > 0)
            }

            Button("Usar otra cuenta", role: .cancel) {
                session.cancelVerification()
            }
            .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(24)
        .errorAlert($errorMessage)
        .alert("Código enviado", isPresented: Binding(get: { info != nil }, set: { if !$0 { info = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(info ?? "")
        }
    }

    private func submit() {
        guard code.count == 6, !isLoading else { return }
        isLoading = true
        Task {
            do {
                try await session.verifyEmail(code: code)
            } catch {
                errorMessage = error.localizedDescription
                code = ""
            }
            isLoading = false
        }
    }

    private func resend() {
        resendAvailableAt = Date().addingTimeInterval(60)
        Task {
            do {
                try await session.resendVerificationCode()
                info = "Revisa tu bandeja de entrada (y la carpeta de spam)."
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

private extension View {
    func authField() -> some View {
        padding(14)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
