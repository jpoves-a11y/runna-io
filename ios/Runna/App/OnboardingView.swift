import SwiftUI
import UserNotifications

/// First-run tutorial: four editorial pages (run, conquer, compete, notifications).
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
        let title: String
        let text: String
    }

    private let steps: [Step] = [
        Step(
            id: 0,
            systemImage: "figure.run",
            title: "Corre y conquista",
            text: "Cada carrera convierte las calles que recorres en tu territorio. También puedes importar actividades de Apple Salud, Strava o Polar."
        ),
        Step(
            id: 1,
            systemImage: "map",
            title: "Defiende tu zona",
            text: "Si corres por el territorio de otro corredor, pasa a ser tuyo. Ellos pueden hacer lo mismo con el tuyo."
        ),
        Step(
            id: 2,
            systemImage: "trophy",
            title: "Compite con tus amigos",
            text: "Sube en la clasificación, participa en competiciones y encuentra tesoros en el mapa."
        ),
        Step(
            id: 3,
            systemImage: "bell",
            title: "Mantente al día",
            text: "Activa las notificaciones para saber cuándo pierdes territorio, cuándo corre un amigo o cuándo aparece un tesoro."
        ),
    ]

    @State private var page = 0
    @State private var notificationStatus: UNAuthorizationStatus = .notDetermined
    @State private var isRequesting = false

    private var isLastPage: Bool { page == steps.count - 1 }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            TabView(selection: $page) {
                ForEach(steps) { step in
                    OnboardingStepPage(step: step)
                        .tag(step.id)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))

            OnboardingPageIndicator(count: steps.count, current: page)
                .padding(.bottom, DS.Spacing.xxl)

            bottomControls
                .padding(.horizontal, DS.Spacing.xl)
                .padding(.bottom, DS.Spacing.xl)
        }
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        .animation(.snappy, value: page)
        .sensoryFeedback(.selection, trigger: page)
        .interactiveDismissDisabled()
        .task {
            notificationStatus = await PushManager.shared.authorizationStatus()
        }
    }

    private var topBar: some View {
        HStack {
            Text("Runna.io")
                .font(.headline)
                .foregroundStyle(.primary)
            Spacer()
            if !isLastPage {
                Button("Omitir") { onFinish() }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .accessibilityHint("Cierra el tutorial")
            }
        }
        .frame(height: 44)
        .padding(.horizontal, DS.Spacing.xl)
    }

    private var bottomControls: some View {
        VStack(spacing: DS.Spacing.s) {
            Button {
                if isLastPage {
                    onFinish()
                } else {
                    withAnimation(.snappy) { page += 1 }
                }
            } label: {
                Text(isLastPage ? "Empezar" : "Continuar")
            }
            .buttonStyle(PrimaryButtonStyle())

            notificationRow
                .frame(minHeight: 44)
                .opacity(isLastPage ? 1 : 0)
                .allowsHitTesting(isLastPage)
                .accessibilityHidden(!isLastPage)
        }
    }

    @ViewBuilder
    private var notificationRow: some View {
        switch notificationStatus {
        case .authorized, .provisional, .ephemeral:
            Label("Notificaciones activadas", systemImage: "checkmark")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
        case .denied:
            Text("Puedes activarlas más tarde en Ajustes.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
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
                    Text("Activar notificaciones")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.brand)
                }
            }
            .disabled(isRequesting)
        }
    }
}

// MARK: - Page

/// Editorial page: large brand SF Symbol, title and a short paragraph, left aligned.
private struct OnboardingStepPage: View {
    let step: OnboardingView.Step

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.xxl) {
            Spacer(minLength: 0)
            Image(systemName: step.systemImage)
                .font(.system(size: 64, weight: .regular))
                .symbolRenderingMode(.monochrome)
                .foregroundStyle(Color.brand)
                .frame(height: 80, alignment: .leading)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: DS.Spacing.m) {
                Text(step.title)
                    .font(Font.screenTitle)
                    .tracking(DS.Tracking.title)
                    .fixedSize(horizontal: false, vertical: true)
                Text(step.text)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: 520, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, DS.Spacing.xxxl)
        .accessibilityElement(children: .combine)
    }
}

/// Small page dots: current one in primary, others faint.
private struct OnboardingPageIndicator: View {
    let count: Int
    let current: Int

    var body: some View {
        HStack(spacing: DS.Spacing.s) {
            ForEach(0..<count, id: \.self) { index in
                Circle()
                    .fill(index == current ? Color.primary : Color.secondary.opacity(0.3))
                    .frame(width: 7, height: 7)
            }
        }
        .animation(.easeOut(duration: 0.2), value: current)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Página \(current + 1) de \(count)")
    }
}
