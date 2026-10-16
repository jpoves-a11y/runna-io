import SwiftUI
import UserNotifications

/// First-run tutorial: run → conquer → steal → compete, and the notifications permission in context.
/// Shown once per device after the first login (UserDefaults flag `doneKey`).
struct OnboardingView: View {
    static let doneKey = "onboardingDone"

    /// e2e tests start logged in and take screenshots: the tutorial would cover them.
    static var isDisabledForTests: Bool {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        return environment["RUNNA_TEST_TOKEN"] != nil && environment["RUNNA_TEST_ONBOARDING"] == nil
        #else
        return false
        #endif
    }

    let onFinish: () -> Void

    fileprivate struct Step: Identifiable {
        let id: Int
        let systemImage: String
        /// Small symbols orbiting the main one.
        let satellites: [String]
        let tint: Color
        let gradient: LinearGradient
        let kicker: String
        let title: String
        let text: String
    }

    private let steps: [Step] = [
        Step(
            id: 0,
            systemImage: "figure.run",
            satellites: ["map.fill", "flame.fill", "sparkles"],
            tint: Color.brand,
            gradient: .brandGradient,
            kicker: "Bienvenido",
            title: "Tu ciudad, tu tablero",
            text: "Corre por tu ciudad y conviértela en tuya. Cada carrera pinta el mapa con tu color."
        ),
        Step(
            id: 1,
            systemImage: "map.fill",
            satellites: ["location.fill", "record.circle", "heart.fill"],
            tint: Color.sky,
            gradient: LinearGradient(colors: [Color.sky, Color.brand], startPoint: .topLeading, endPoint: .bottomTrailing),
            kicker: "Paso 1",
            title: "Corre y conquista",
            text: "Pulsa «Correr» y sal a la calle. La zona que recorres se convierte en tu territorio. También puedes importar carreras de Apple Salud, Strava o Polar desde tu perfil."
        ),
        Step(
            id: 2,
            systemImage: "bolt.shield.fill",
            satellites: ["flag.fill", "camera.fill", "hand.raised.fill"],
            tint: Color.steal,
            gradient: .stealGradient,
            kicker: "Paso 2",
            title: "Roba territorio",
            text: "Si corres por el territorio de un amigo, se lo robas (y le puedes mandar una foto para que no lo olvide). Cuidado: ellos también pueden quitarte el tuyo."
        ),
        Step(
            id: 3,
            systemImage: "trophy.fill",
            satellites: ["crown.fill", "gift.fill", "bolt.fill"],
            tint: Color.gold,
            gradient: .goldGradient,
            kicker: "Paso 3",
            title: "Compite y gana",
            text: "Sube en el ranking de tus amigos y entra en las competiciones: busca tesoros en el mapa y usa sus poderes para conquistar más."
        ),
        Step(
            id: 4,
            systemImage: "bell.badge.fill",
            satellites: ["exclamationmark", "person.2.fill", "gift.fill"],
            tint: Color.grape,
            gradient: .grapeGradient,
            kicker: "Último paso",
            title: "Que no te pillen dormido",
            text: "Activa las notificaciones para saber cuándo te roban territorio, cuándo corre un amigo o cuándo aparece un tesoro."
        ),
    ]

    @State private var page = 0
    @State private var notificationStatus: UNAuthorizationStatus = .notDetermined
    @State private var isRequesting = false

    private var isLastPage: Bool { page == steps.count - 1 }
    private var currentStep: Step { steps[min(max(page, 0), steps.count - 1)] }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            TabView(selection: $page) {
                ForEach(steps) { step in
                    OnboardingStepPage(step: step, isActive: step.id == page)
                        .tag(step.id)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))

            OnboardingPageIndicator(count: steps.count, current: page, tint: currentStep.tint)
                .padding(.bottom, DS.Spacing.xl)

            bottomControls
                .padding(.horizontal, DS.Spacing.xxl)
                .padding(.bottom, DS.Spacing.xxl)
        }
        .background { background }
        .animation(.snappy, value: page)
        .sensoryFeedback(.selection, trigger: page)
        .interactiveDismissDisabled()
        .task {
            notificationStatus = await PushManager.shared.authorizationStatus()
        }
    }

    private var background: some View {
        ZStack(alignment: .top) {
            Color.canvas
            LinearGradient(
                colors: [currentStep.tint.opacity(0.28), currentStep.tint.opacity(0.0)],
                startPoint: .top,
                endPoint: .center
            )
        }
        .ignoresSafeArea()
        .animation(.easeInOut(duration: 0.4), value: page)
    }

    private var topBar: some View {
        HStack {
            Text("Runna.io")
                .font(.system(.headline, design: .rounded, weight: .heavy))
                .foregroundStyle(currentStep.tint)
            Spacer()
            if !isLastPage {
                Button("Saltar") { onFinish() }
                    .font(.system(.subheadline, design: .rounded, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityHint("Cierra el tutorial")
            }
        }
        .frame(height: 44)
        .padding(.horizontal, DS.Spacing.xl)
    }

    private var bottomControls: some View {
        VStack(spacing: DS.Spacing.m) {
            if isLastPage {
                notificationButton
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            HStack(spacing: DS.Spacing.m) {
                if page > 0 {
                    Button {
                        withAnimation { page -= 1 }
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.headline.weight(.bold))
                            .foregroundStyle(currentStep.tint)
                            .frame(width: 54, height: 54)
                            .background(currentStep.tint.opacity(0.14), in: Circle())
                    }
                    .buttonStyle(.pressable)
                    .accessibilityLabel("Anterior")
                    .transition(.scale.combined(with: .opacity))
                }
                Button {
                    if isLastPage {
                        onFinish()
                    } else {
                        withAnimation { page += 1 }
                    }
                } label: {
                    Label(isLastPage ? "¡A correr!" : "Siguiente", systemImage: isLastPage ? "figure.run" : "arrow.right")
                }
                .buttonStyle(PrimaryButtonStyle(color: isLastPage ? Color.brand : currentStep.tint))
            }
        }
    }

    @ViewBuilder
    private var notificationButton: some View {
        switch notificationStatus {
        case .authorized, .provisional, .ephemeral:
            Label("Notificaciones activadas", systemImage: "checkmark.circle.fill")
                .font(.system(.subheadline, design: .rounded, weight: .bold))
                .foregroundStyle(Color.brand)
                .frame(minHeight: 44)
        case .denied:
            Text("Las notificaciones están desactivadas. Puedes activarlas más tarde en Ajustes.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(minHeight: 44)
        default:
            Button {
                isRequesting = true
                Task {
                    await PushManager.shared.requestPermissionAndRegister()
                    notificationStatus = await PushManager.shared.authorizationStatus()
                    isRequesting = false
                }
            } label: {
                if isRequesting {
                    ProgressView()
                } else {
                    Label("Activar notificaciones", systemImage: "bell.fill")
                }
            }
            .buttonStyle(SecondaryButtonStyle(tint: Color.grape))
            .disabled(isRequesting)
        }
    }
}

// MARK: - Page

private struct OnboardingStepPage: View {
    let step: OnboardingView.Step
    let isActive: Bool

    var body: some View {
        VStack(spacing: DS.Spacing.xxl) {
            Spacer(minLength: 0)
            OnboardingIllustration(step: step, isActive: isActive)
                .frame(height: 260)
                .accessibilityHidden(true)
            VStack(spacing: DS.Spacing.m) {
                Text(step.kicker)
                    .font(Font.statLabel)
                    .textCase(.uppercase)
                    .tracking(1.2)
                    .foregroundStyle(step.tint)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(step.tint.opacity(0.14), in: Capsule())
                Text(step.title)
                    .font(.system(size: 30, weight: .heavy, design: .rounded))
                    .multilineTextAlignment(.center)
                Text(step.text)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .opacity(isActive ? 1 : 0.4)
            .offset(y: isActive ? 0 : 12)
            .animation(.spring(response: 0.5, dampingFraction: 0.8), value: isActive)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 32)
    }
}

/// Big SF Symbol composition: gradient disc with halos and orbiting bubbles.
private struct OnboardingIllustration: View {
    let step: OnboardingView.Step
    let isActive: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var floating = false

    private let positions: [CGSize] = [
        CGSize(width: -104, height: -70),
        CGSize(width: 108, height: -40),
        CGSize(width: -70, height: 96),
    ]

    var body: some View {
        ZStack {
            Circle()
                .fill(step.tint.opacity(0.08))
                .frame(width: 250, height: 250)
            Circle()
                .fill(step.tint.opacity(0.14))
                .frame(width: 196, height: 196)
                .scaleEffect(floating ? 1.04 : 0.98)
            mainDisc
            ForEach(Array(step.satellites.enumerated()), id: \.offset) { index, symbol in
                satellite(symbol, index: index)
            }
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 2.4).repeatForever(autoreverses: true)) { floating = true }
        }
    }

    private var mainDisc: some View {
        ZStack {
            Circle()
                .fill(step.gradient)
                .frame(width: 140, height: 140)
                .shadow(color: step.tint.opacity(0.45), radius: 22, x: 0, y: 12)
            Circle()
                .strokeBorder(Color.white.opacity(0.35), lineWidth: 2)
                .frame(width: 140, height: 140)
            Image(systemName: step.systemImage)
                .font(.system(size: 64, weight: .bold))
                .foregroundStyle(.white)
                .symbolEffect(.bounce, value: isActive)
        }
        .scaleEffect(isActive ? 1 : 0.8)
        .rotationEffect(.degrees(isActive ? 0 : -10))
        .animation(.spring(response: 0.55, dampingFraction: 0.6), value: isActive)
    }

    private func satellite(_ symbol: String, index: Int) -> some View {
        let base = positions[index % positions.count]
        let wobble: CGFloat = floating ? (index.isMultiple(of: 2) ? -8 : 8) : 0
        return Image(systemName: symbol)
            .font(.system(size: 20, weight: .bold))
            .foregroundStyle(step.tint)
            .frame(width: 50, height: 50)
            .background(Color.surface, in: Circle())
            .overlay(Circle().strokeBorder(step.tint.opacity(0.25), lineWidth: 1))
            .shadow(color: Color.black.opacity(0.10), radius: 8, x: 0, y: 4)
            .offset(x: isActive ? base.width : 0, y: (isActive ? base.height : 0) + wobble)
            .scaleEffect(isActive ? 1 : 0.3)
            .opacity(isActive ? 1 : 0)
            .animation(.spring(response: 0.6, dampingFraction: 0.65).delay(Double(index) * 0.08), value: isActive)
    }
}

/// Capsule page dots: the current one stretches and takes the page colour.
private struct OnboardingPageIndicator: View {
    let count: Int
    let current: Int
    let tint: Color

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<count, id: \.self) { index in
                Capsule()
                    .fill(index == current ? tint : Color.secondary.opacity(0.25))
                    .frame(width: index == current ? 26 : 8, height: 8)
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.75), value: current)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Página \(current + 1) de \(count)")
    }
}
