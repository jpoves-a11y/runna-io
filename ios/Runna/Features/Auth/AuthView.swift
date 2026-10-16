import SwiftUI
import UIKit

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
            ZStack {
                AuthBackdrop()
                ScrollView {
                    VStack(spacing: DS.Spacing.xxl) {
                        AuthHero()
                        formCard
                        footer
                    }
                    .padding(.horizontal, DS.Spacing.xl)
                    .padding(.vertical, DS.Spacing.xxl)
                    .frame(maxWidth: 520)
                    .frame(maxWidth: .infinity)
                }
                .scrollDismissesKeyboard(.interactively)
                .scrollIndicators(.hidden)
            }
        }
    }

    private var formCard: some View {
        VStack(spacing: DS.Spacing.xl) {
            AuthModeSwitch(mode: $mode)
            Group {
                switch mode {
                case .login:
                    LoginForm()
                        .transition(.asymmetric(insertion: .move(edge: .leading).combined(with: .opacity), removal: .opacity))
                case .register:
                    RegisterForm()
                        .transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .opacity))
                }
            }
            .animation(.snappy, value: mode)
        }
        .card(padding: DS.Spacing.xl, radius: 28)
        .shadow(color: Color.black.opacity(0.18), radius: 24, x: 0, y: 12)
    }

    private var footer: some View {
        Text(mode == .login ? "¿Primera vez? Toca «Crear cuenta» y empieza a pintar tu ciudad." : "Tus amigos ya están corriendo. No les dejes el mapa entero.")
            .font(.system(.footnote, design: .rounded, weight: .medium))
            .foregroundStyle(Color.white.opacity(0.85))
            .multilineTextAlignment(.center)
            .padding(.horizontal, DS.Spacing.l)
            .contentTransition(.opacity)
            .animation(.easeInOut, value: mode)
    }
}

// MARK: - Hero

/// Logo tile, app name and tagline over the gradient.
private struct AuthHero: View {
    @State private var appeared = false

    var body: some View {
        VStack(spacing: DS.Spacing.m) {
            ZStack {
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .fill(Color.white)
                    .frame(width: 92, height: 92)
                    .shadow(color: Color.black.opacity(0.22), radius: 18, x: 0, y: 10)
                Image(systemName: "figure.run")
                    .font(.system(size: 46, weight: .bold))
                    .foregroundStyle(.brandGradient)
                    .symbolEffect(.bounce, value: appeared)
            }
            .rotationEffect(.degrees(appeared ? -6 : 0))
            .scaleEffect(appeared ? 1 : 0.7)

            Text("Runna.io")
                .font(.system(size: 40, weight: .heavy, design: .rounded))
                .foregroundStyle(.white)
            HStack(spacing: 6) {
                taglineWord("Corre.")
                taglineWord("Conquista.")
                taglineWord("Roba.", accent: true)
            }
        }
        .padding(.top, DS.Spacing.xl)
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared ? 0 : 16)
        .onAppear {
            withAnimation(.spring(response: 0.6, dampingFraction: 0.7)) { appeared = true }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Runna.io. Corre. Conquista. Roba.")
    }

    private func taglineWord(_ text: String, accent: Bool = false) -> some View {
        Text(text)
            .font(.system(.title3, design: .rounded, weight: .bold))
            .foregroundStyle(accent ? Color.white : Color.white.opacity(0.9))
            .padding(.horizontal, accent ? 10 : 0)
            .padding(.vertical, accent ? 3 : 0)
            .background {
                if accent {
                    Capsule().fill(.stealGradient)
                }
            }
    }
}

/// Animated "living map": brand gradient, drifting territory blobs and a dashed route being run.
private struct AuthBackdrop: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drift = false
    @State private var routeEnd: CGFloat = 0.05

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            ZStack {
                LinearGradient(
                    colors: [Color.brandDeep, Color.brand, Color.brandLime.opacity(0.9)],
                    startPoint: .top,
                    endPoint: .bottomTrailing
                )
                gridLines(size: size)
                blob(color: Color.white.opacity(0.16), size: 260, x: drift ? size.width * 0.15 : size.width * 0.05, y: drift ? size.height * 0.12 : size.height * 0.18)
                blob(color: Color.steal.opacity(0.30), size: 200, x: drift ? size.width * 0.92 : size.width * 0.82, y: drift ? size.height * 0.30 : size.height * 0.24)
                blob(color: Color.sky.opacity(0.28), size: 240, x: drift ? size.width * 0.10 : size.width * 0.22, y: drift ? size.height * 0.80 : size.height * 0.88)
                blob(color: Color.gold.opacity(0.26), size: 180, x: drift ? size.width * 0.86 : size.width * 0.95, y: drift ? size.height * 0.72 : size.height * 0.64)
                AuthRoutePath()
                    .stroke(Color.white.opacity(0.18), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round, dash: [10, 9]))
                    .frame(width: size.width, height: size.height)
                AuthRoutePath()
                    .trim(from: 0, to: reduceMotion ? 1 : routeEnd)
                    .stroke(Color.white.opacity(0.55), style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
                    .frame(width: size.width, height: size.height)
            }
        }
        .ignoresSafeArea()
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 7).repeatForever(autoreverses: true)) { drift = true }
            withAnimation(.easeInOut(duration: 6).repeatForever(autoreverses: true)) { routeEnd = 1 }
        }
        .accessibilityHidden(true)
    }

    private func blob(color: Color, size: CGFloat, x: CGFloat, y: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: size * 0.38, style: .continuous)
            .fill(color)
            .frame(width: size, height: size * 0.8)
            .rotationEffect(.degrees(drift ? 18 : -12))
            .blur(radius: 18)
            .position(x: x, y: y)
    }

    private func gridLines(size: CGSize) -> some View {
        Path { path in
            let step: CGFloat = 44
            var x: CGFloat = 0
            while x < size.width {
                path.move(to: CGPoint(x: x, y: 0))
                path.addLine(to: CGPoint(x: x + size.height * 0.25, y: size.height))
                x += step
            }
            var y: CGFloat = 0
            while y < size.height {
                path.move(to: CGPoint(x: 0, y: y))
                path.addLine(to: CGPoint(x: size.width, y: y - size.width * 0.12))
                y += step
            }
        }
        .stroke(Color.white.opacity(0.07), lineWidth: 1)
    }
}

/// A playful looping route drawn across the background.
private struct AuthRoutePath: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.width
        let h = rect.height
        path.move(to: CGPoint(x: -20, y: h * 0.34))
        path.addCurve(to: CGPoint(x: w * 0.55, y: h * 0.22), control1: CGPoint(x: w * 0.2, y: h * 0.42), control2: CGPoint(x: w * 0.35, y: h * 0.12))
        path.addCurve(to: CGPoint(x: w * 0.7, y: h * 0.62), control1: CGPoint(x: w * 0.85, y: h * 0.32), control2: CGPoint(x: w * 1.0, y: h * 0.55))
        path.addCurve(to: CGPoint(x: w + 20, y: h * 0.95), control1: CGPoint(x: w * 0.4, y: h * 0.7), control2: CGPoint(x: w * 0.6, y: h * 0.95))
        return path
    }
}

// MARK: - Mode switch

/// Capsule segmented control with a sliding thumb.
private struct AuthModeSwitch: View {
    @Binding var mode: AuthView.Mode
    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 4) {
            ForEach(AuthView.Mode.allCases) { item in
                segment(item)
            }
        }
        .padding(4)
        .background(Color.surfaceRaised, in: Capsule())
        .sensoryFeedback(.selection, trigger: mode)
    }

    private func segment(_ item: AuthView.Mode) -> some View {
        let selected = item == mode
        return Button {
            withAnimation(.snappy) { mode = item }
        } label: {
            Text(item.rawValue)
                .font(.system(.subheadline, design: .rounded, weight: .bold))
                .foregroundStyle(selected ? Color.white : Color.secondary)
                .frame(maxWidth: .infinity, minHeight: 40)
                .background {
                    if selected {
                        Capsule()
                            .fill(.brandGradient)
                            .shadow(color: Color.brand.opacity(0.35), radius: 6, x: 0, y: 3)
                            .matchedGeometryEffect(id: "thumb", in: thumb)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Forms

private struct LoginForm: View {
    @Environment(SessionStore.self) private var session
    @State private var identifier = ""
    @State private var password = ""
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: DS.Spacing.m) {
            AuthTextField(systemImage: "person.fill") {
                TextField("Usuario o email", text: $identifier)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.emailAddress)
            }
            AuthTextField(systemImage: "lock.fill") {
                PasswordField(title: "Contraseña", text: $password, contentType: .password, onSubmit: submit)
            }

            Button(action: submit) {
                if isLoading {
                    ProgressView().tint(.white)
                } else {
                    Label("Entrar", systemImage: "arrow.right")
                        .labelStyle(AuthTrailingIconLabelStyle())
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(isLoading || identifier.isEmpty || password.isEmpty)
            .padding(.top, DS.Spacing.s)
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
        VStack(spacing: DS.Spacing.m) {
            fields
            termsToggle
            Label("Debes tener al menos \(AppConfig.minimumAge) años para usar Runna.io.", systemImage: "info.circle.fill")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            Button(action: submit) {
                if isLoading {
                    ProgressView().tint(.white)
                } else {
                    Label("Crear cuenta", systemImage: "sparkles")
                        .labelStyle(AuthTrailingIconLabelStyle())
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(isLoading)
            .padding(.top, DS.Spacing.s)
        }
        .errorAlert($errorMessage)
    }

    private var fields: some View {
        VStack(spacing: DS.Spacing.m) {
            AuthTextField(systemImage: "face.smiling.fill") {
                TextField("Nombre", text: $name)
                    .textContentType(.name)
            }
            AuthTextField(systemImage: "at") {
                TextField("Usuario", text: $username)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            AuthTextField(systemImage: "envelope.fill") {
                TextField("Email", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            AuthTextField(systemImage: "lock.fill") {
                PasswordField(title: "Contraseña (mín. 6 caracteres)", text: $password, contentType: .newPassword)
            }
        }
    }

    private var termsToggle: some View {
        Toggle(isOn: $acceptedTerms) {
            Text(termsText)
                .font(.footnote)
        }
        .toggleStyle(.switch)
        .tint(Color.brand)
        .padding(.top, DS.Spacing.xs)
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
        ZStack {
            AuthBackdrop()
            ScrollView {
                VStack(spacing: DS.Spacing.xxl) {
                    header
                    card
                }
                .padding(.horizontal, DS.Spacing.xl)
                .padding(.vertical, DS.Spacing.xxl)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .errorAlert($errorMessage)
        .alert("Código enviado", isPresented: Binding(get: { info != nil }, set: { if !$0 { info = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(info ?? "")
        }
        .onAppear { codeFocused = true }
    }

    private var header: some View {
        VStack(spacing: DS.Spacing.m) {
            ZStack {
                Circle()
                    .fill(Color.white.opacity(0.18))
                    .frame(width: 120, height: 120)
                Circle()
                    .fill(Color.white)
                    .frame(width: 88, height: 88)
                    .shadow(color: Color.black.opacity(0.2), radius: 14, x: 0, y: 8)
                Image(systemName: "envelope.badge.fill")
                    .font(.system(size: 40, weight: .semibold))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(Color.steal, Color.brand)
                    .symbolEffect(.bounce, value: code.count == 6)
            }
            Text("Revisa tu email")
                .font(.system(size: 32, weight: .heavy, design: .rounded))
                .foregroundStyle(.white)
            Text("Te hemos mandado un código de 6 dígitos a\n**\(session.pendingVerification?.email ?? "")**")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(Color.white.opacity(0.9))
        }
        .padding(.top, DS.Spacing.xxl)
    }

    private var card: some View {
        VStack(spacing: DS.Spacing.l) {
            codeBoxes
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
                .buttonStyle(SecondaryButtonStyle())
                .disabled(remaining > 0)
                .opacity(remaining > 0 ? 0.6 : 1)
            }

            Button("Usar otra cuenta", role: .cancel) {
                session.cancelVerification()
            }
            .font(.system(.footnote, design: .rounded, weight: .semibold))
            .foregroundStyle(.secondary)
        }
        .card(padding: DS.Spacing.xl, radius: 28)
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
            HStack(spacing: 8) {
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
        let isCurrent = index == digits.count && codeFocused
        return Text(char)
            .font(.system(size: 28, weight: .heavy, design: .rounded))
            .monospacedDigit()
            .frame(maxWidth: .infinity, minHeight: 58)
            .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous)
                    .strokeBorder(isCurrent || !char.isEmpty ? Color.brand : Color.hairline, lineWidth: isCurrent ? 2 : 1)
            )
            .scaleEffect(char.isEmpty ? 1 : 1.04)
            .animation(.spring(response: 0.25, dampingFraction: 0.6), value: char)
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

// MARK: - Inputs

/// Rounded input row with a leading icon that lights up when focused.
private struct AuthTextField<Field: View>: View {
    let systemImage: String
    @ViewBuilder var field: Field
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            Image(systemName: systemImage)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(focused ? Color.brand : Color.secondary)
                .frame(width: 22)
            field
                .focused($focused)
                .font(.system(.body, design: .rounded))
        }
        .padding(.horizontal, DS.Spacing.l)
        .frame(minHeight: 54)
        .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous)
                .strokeBorder(focused ? Color.brand : Color.clear, lineWidth: 1.5)
        )
        .animation(.easeOut(duration: 0.15), value: focused)
    }
}

/// Title first, icon after it.
private struct AuthTrailingIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 8) {
            configuration.title
            configuration.icon
        }
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
        HStack(spacing: 8) {
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
            .onSubmit(onSubmit)

            Button {
                isRevealed.toggle()
            } label: {
                Image(systemName: isRevealed ? "eye.slash.fill" : "eye.fill")
                    .foregroundStyle(.secondary)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isRevealed ? "Ocultar contraseña" : "Mostrar contraseña")
        }
    }
}
