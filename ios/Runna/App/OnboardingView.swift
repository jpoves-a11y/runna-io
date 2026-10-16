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

    private struct Step: Identifiable {
        let id: Int
        let systemImage: String
        let tint: Color
        let title: String
        let text: String
    }

    private let steps: [Step] = [
        Step(
            id: 0,
            systemImage: "figure.run.circle.fill",
            tint: .brand,
            title: "Bienvenido a Runna.io",
            text: "Corre por tu ciudad y conviértela en tuya. Cada carrera pinta el mapa con tu color."
        ),
        Step(
            id: 1,
            systemImage: "map.fill",
            tint: .blue,
            title: "Corre y conquista",
            text: "Pulsa el botón de grabar y sal a correr. La zona que recorres se convierte en tu territorio. También puedes importar carreras de Apple Salud, Strava o Polar desde tu perfil."
        ),
        Step(
            id: 2,
            systemImage: "bolt.shield.fill",
            tint: .orange,
            title: "Roba territorio",
            text: "Si corres por el territorio de un amigo, se lo robas. Cuidado: ellos también pueden quitarte el tuyo. Te avisaremos cuando pase."
        ),
        Step(
            id: 3,
            systemImage: "trophy.fill",
            tint: .yellow,
            title: "Compite",
            text: "Sube en el ranking de tus amigos y participa en las competiciones: busca tesoros en el mapa y usa sus poderes para conquistar más."
        ),
        Step(
            id: 4,
            systemImage: "bell.badge.fill",
            tint: .red,
            title: "No te pierdas nada",
            text: "Activa las notificaciones para saber cuándo te roban territorio, cuándo corre un amigo o cuándo aparece un tesoro."
        ),
    ]

    @State private var page = 0
    @State private var notificationStatus: UNAuthorizationStatus = .notDetermined
    @State private var isRequesting = false

    private var isLastPage: Bool { page == steps.count - 1 }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                if !isLastPage {
                    Button("Saltar") { onFinish() }
                        .foregroundStyle(.secondary)
                        .accessibilityHint("Cierra el tutorial")
                }
            }
            .frame(height: 44)
            .padding(.horizontal, 20)

            TabView(selection: $page) {
                ForEach(steps) { step in
                    stepView(step)
                        .tag(step.id)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .always))
            .indexViewStyle(.page(backgroundDisplayMode: .always))

            VStack(spacing: 12) {
                if isLastPage {
                    notificationButton
                }
                HStack(spacing: 12) {
                    if page > 0 {
                        Button("Anterior") {
                            withAnimation { page -= 1 }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                    }
                    Button(isLastPage ? "Empezar" : "Siguiente") {
                        if isLastPage {
                            onFinish()
                        } else {
                            withAnimation { page += 1 }
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
        .background(Color(.systemBackground).ignoresSafeArea())
        .interactiveDismissDisabled()
        .task {
            notificationStatus = await PushManager.shared.authorizationStatus()
        }
    }

    private func stepView(_ step: Step) -> some View {
        VStack(spacing: 22) {
            Spacer()
            Image(systemName: step.systemImage)
                .font(.system(size: 84, weight: .bold))
                .foregroundStyle(step.tint)
                .frame(height: 110)
                .accessibilityHidden(true)
            Text(step.title)
                .font(.title.bold())
                .multilineTextAlignment(.center)
            Text(step.text)
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 32)
    }

    @ViewBuilder
    private var notificationButton: some View {
        switch notificationStatus {
        case .authorized, .provisional, .ephemeral:
            Label("Notificaciones activadas", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.green)
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
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(isRequesting)
        }
    }
}
