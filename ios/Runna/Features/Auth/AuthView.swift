import SwiftUI
import UIKit

/// Welcome / sign-in screen: calm system background, wordmark, segmented mode switch,
/// native-looking grouped fields and one solid primary button.
struct AuthView: View {
    @Environment(SessionStore.self) private var session

    enum Mode: String, CaseIterable, Identifiable {
        case login = "Entrar"
        case register = "Crear cuenta"
        var id: String { rawValue }
    }

    @State private var mode: Mode = .login

    var body: some View {
        if session.pendingVerification != nil {
            VerifyEmailView()
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: DS.Spacing.xxxl) {
                    AuthHeader(
                        title: "Runna.io",
                        subtitle: "Corre por tu ciudad y conquista el mapa."
                    )
                    VStack(spacing: DS.Spacing.xl) {
                        modePicker
                        form
                    }
                }
                .padding(.horizontal, DS.Spacing.xl)
                .padding(.top, 56)
                .padding(.bottom, DS.Spacing.xxl)
                .frame(maxWidth: 480)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollIndicators(.hidden)
            .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        }
    }

    private var modePicker: some View {
        Picker("Modo", selection: $mode.animation(.snappy)) {
            ForEach(Mode.allCases) { item in
                Text(item.rawValue).tag(item)
            }
        }
        .pickerStyle(.segmented)
        .sensoryFeedback(.selection, trigger: mode)
    }

    @ViewBuilder
    private var form: some View {
        switch mode {
        case .login:
            LoginForm()
                .transition(.opacity)
        case .register:
            RegisterForm()
                .transition(.opacity)
        }
    }
}

// MARK: - Header

/// Wordmark (or screen title) with a one-line subtitle, left aligned.
private struct AuthHeader: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Text(title)
                .font(Font.screenTitle)
                .tracking(DS.Tracking.title)
                .foregroundStyle(.primary)
            Text(subtitle)
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Forms

private struct LoginForm: View {
    private enum Field: Hashable {
        case identifier, password
    }

    @Environment(SessionStore.self) private var session
    @State private var identifier = ""
    @State private var password = ""
    @State private var isLoading = false
    @State private var errorMessage: String?
    @FocusState private var focus: Field?

    var body: some View {
        VStack(spacing: DS.Spacing.xl) {
            AuthFieldGroup {
                AuthFieldRow {
                    TextField("Usuario o email", text: $identifier)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                        .submitLabel(.next)
                        .focused($focus, equals: Field.identifier)
                        .onSubmit { focus = Field.password }
                }
                HairlineDivider()
                    .padding(.leading, DS.Spacing.l)
                AuthFieldRow {
                    PasswordField(title: "Contraseña", text: $password, contentType: .password, onSubmit: submit)
                        .focused($focus, equals: Field.password)
                }
            }

            Button(action: submit) {
                if isLoading {
                    ProgressView().tint(Color.onBrand)
                } else {
                    Text("Entrar")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(isLoading || identifier.isEmpty || password.isEmpty)
        }
        .errorAlert($errorMessage)
    }

    private func submit() {
        guard !identifier.isEmpty, !password.isEmpty, !isLoading else { return }
        focus = nil
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
    private enum Field: Hashable {
        case name, username, email, password
    }

    @Environment(SessionStore.self) private var session
    @State private var name = ""
    @State private var username = ""
    @State private var email = ""
    @State private var password = ""
    @State private var acceptedTerms = false
    @State private var isLoading = false
    @State private var errorMessage: String?
    @FocusState private var focus: Field?

    private var validationMessage: String? {
        if name.trimmingCharacters(in: .whitespaces).isEmpty { return "Escribe tu nombre." }
        if username.trimmingCharacters(in: .whitespaces).count < 3 { return "El usuario debe tener al menos 3 caracteres." }
        if username.contains(" ") { return "El usuario no puede contener espacios." }
        if !email.contains("@") || !email.contains(".") { return "Escribe un email válido." }
        if password.count < 6 { return "La contraseña debe tener al menos 6 caracteres." }
        if !acceptedTerms { return "Acepta los términos para continuar." }
        return nil
    }

    var body: some View {
        VStack(spacing: DS.Spacing.xl) {
            fields
            termsCard
            Button(action: submit) {
                if isLoading {
                    ProgressView().tint(Color.onBrand)
                } else {
                    Text("Crear cuenta")
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(isLoading)
        }
        .errorAlert($errorMessage)
    }

    private var fields: some View {
        AuthFieldGroup {
            AuthFieldRow {
                TextField("Nombre", text: $name)
                    .textContentType(.name)
                    .submitLabel(.next)
                    .focused($focus, equals: Field.name)
                    .onSubmit { focus = Field.username }
            }
            rowDivider
            AuthFieldRow {
                TextField("Usuario", text: $username)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .focused($focus, equals: Field.username)
                    .onSubmit { focus = Field.email }
            }
            rowDivider
            AuthFieldRow {
                TextField("Email", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .focused($focus, equals: Field.email)
                    .onSubmit { focus = Field.password }
            }
            rowDivider
            AuthFieldRow {
                PasswordField(title: "Contraseña (mín. 6 caracteres)", text: $password, contentType: .newPassword, onSubmit: { focus = nil })
                    .focused($focus, equals: Field.password)
            }
        }
    }

    private var rowDivider: some View {
        HairlineDivider()
            .padding(.leading, DS.Spacing.l)
    }

    private var termsCard: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Toggle(isOn: $acceptedTerms) {
                Text(termsText)
                    .font(.footnote)
                    .tint(Color.brand)
            }
            .toggleStyle(.switch)
            .tint(Color.brand)
            Text("Necesitas tener al menos \(AppConfig.minimumAge) años para usar Runna.io.")
                .font(Font.meta)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, DS.Spacing.xs)
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
        focus = nil
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

// MARK: - Verify email

struct VerifyEmailView: View {
    @Environment(SessionStore.self) private var session
    @State private var code = ""
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var info: String?
    @State private var resendAvailableAt = Date()
    @FocusState private var codeFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Spacing.xxxl) {
                header
                VStack(spacing: DS.Spacing.xl) {
                    codeBoxes
                    verifyButton
                    secondaryActions
                }
            }
            .padding(.horizontal, DS.Spacing.xl)
            .padding(.top, 56)
            .padding(.bottom, DS.Spacing.xxl)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollIndicators(.hidden)
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        .errorAlert($errorMessage)
        .alert("Código enviado", isPresented: Binding(get: { info != nil }, set: { if !$0 { info = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(info ?? "")
        }
        .onAppear { codeFocused = true }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.l) {
            Image(systemName: "envelope")
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(Color.brand)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                Text("Verifica tu email")
                    .font(Font.screenTitle)
                    .tracking(DS.Tracking.title)
                subtitle
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var subtitle: Text {
        let email: String = session.pendingVerification?.email ?? ""
        return Text("Introduce el código de 6 dígitos que hemos enviado a **\(email)**.")
    }

    private var verifyButton: some View {
        Button(action: submit) {
            if isLoading {
                ProgressView().tint(Color.onBrand)
            } else {
                Text("Verificar")
            }
        }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(code.count != 6 || isLoading)
    }

    private var secondaryActions: some View {
        VStack(spacing: DS.Spacing.s) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let remaining: Int = Int(resendAvailableAt.timeIntervalSince(context.date).rounded(.up))
                Button(remaining > 0 ? "Reenviar código en \(remaining) s" : "Reenviar código") {
                    resend()
                }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(remaining > 0 ? Color.secondary : Color.brand)
                .monospacedDigit()
                .disabled(remaining > 0)
                .frame(minHeight: 44)
            }
            Button("Usar otra cuenta") {
                session.cancelVerification()
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(minHeight: 44)
        }
        .frame(maxWidth: .infinity)
    }

    /// Six digit boxes drawn over a hidden text field (keeps one-time-code autofill).
    private var codeBoxes: some View {
        ZStack {
            TextField("", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .focused($codeFocused)
                .foregroundStyle(Color.clear)
                .tint(Color.clear)
                .frame(height: 60)
                .accessibilityLabel("Código de verificación")
                .onChange(of: code) { _, newValue in
                    let digits = String(newValue.filter(\.isNumber).prefix(6))
                    if digits != newValue { code = digits }
                    if digits.count == 6 { submit() }
                }
            HStack(spacing: DS.Spacing.s) {
                ForEach(0..<6, id: \.self) { index in
                    digitBox(index)
                }
            }
            .allowsHitTesting(false)
        }
        .contentShape(Rectangle())
        .onTapGesture { codeFocused = true }
    }

    private func digitBox(_ index: Int) -> some View {
        let digits: [Character] = Array(code)
        let char: String = index < digits.count ? String(digits[index]) : ""
        let isCurrent: Bool = index == digits.count && codeFocused
        let shape = RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous)
        return Text(char)
            .font(Font.stat(30, weight: .semibold))
            .monospacedDigit()
            .frame(maxWidth: .infinity, minHeight: 58)
            .background(Color(uiColor: .secondarySystemBackground), in: shape)
            .overlay(
                shape.strokeBorder(isCurrent ? Color.brand : Color.hairline, lineWidth: isCurrent ? 1.5 : DS.Stroke.hairline)
            )
            .animation(.easeOut(duration: 0.15), value: isCurrent)
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
                info = "Revisa tu bandeja de entrada y la carpeta de spam."
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

// MARK: - Inputs

/// Grouped container for form rows (like an inset grouped list section).
private struct AuthFieldGroup<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous)
        VStack(spacing: 0) {
            content
        }
        .background(Color(uiColor: .secondarySystemBackground), in: shape)
        .overlay(shape.strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline))
    }
}

/// One plain input row inside an `AuthFieldGroup`.
private struct AuthFieldRow<Field: View>: View {
    @ViewBuilder var field: Field

    var body: some View {
        field
            .font(.body)
            .padding(.horizontal, DS.Spacing.l)
            .frame(maxWidth: .infinity, minHeight: 50, alignment: .leading)
    }
}

/// Password input with a show/hide button.
private struct PasswordField: View {
    let title: String
    @Binding var text: String
    var contentType: UITextContentType = .password
    var onSubmit: () -> Void = {}

    @State private var isRevealed = false

    var body: some View {
        HStack(spacing: DS.Spacing.s) {
            Group {
                if isRevealed {
                    TextField(title, text: $text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } else {
                    SecureField(title, text: $text)
                }
            }
            .textContentType(contentType)
            .submitLabel(.go)
            .onSubmit(onSubmit)

            Button {
                isRevealed.toggle()
            } label: {
                Image(systemName: isRevealed ? "eye.slash" : "eye")
                    .font(.body)
                    .foregroundStyle(.tertiary)
                    .frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isRevealed ? "Ocultar contraseña" : "Mostrar contraseña")
        }
    }
}
