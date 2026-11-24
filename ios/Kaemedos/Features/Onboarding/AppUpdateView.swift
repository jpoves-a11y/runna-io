import SwiftUI

/// The update screen: over everything (the app can't be used) when the update is required; a
/// card that can be closed while the new version is still fresh (AppUpdate).
struct AppUpdateView: View {
    let version: String
    let required: Bool
    let onUpdate: () -> Void
    var onLater: (() -> Void)?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 0) {
                Spacer()
                KM2Logo(size: 64, onDark: true)
                    .accessibilityHidden(true)
                Spacer().frame(height: DS.Spacing.xxl)
                Text(required ? "Actualiza KM2" : "Hay una versión nueva")
                    .font(.system(size: 30, weight: .bold))
                    .tracking(-0.5)
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                Text(required
                     ? "Esta versión ya no funciona. Instala la \(version) para seguir conquistando."
                     : "La \(version) ya está en el App Store. Actualiza cuando puedas: dentro de poco será necesaria.")
                    .font(.system(size: 16))
                    .foregroundStyle(.white.opacity(0.65))
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, DS.Spacing.s)
                Spacer()
                VStack(spacing: DS.Spacing.m) {
                    Button(action: onUpdate) {
                        Text("Actualizar")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(.black)
                            .frame(maxWidth: .infinity)
                            .frame(height: 54)
                            .background(Color.brandNeon, in: Capsule())
                    }
                    .buttonStyle(.pressable)
                    if !required, let onLater {
                        Button("Ahora no", action: onLater)
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(.white.opacity(0.6))
                            .frame(height: 44)
                    }
                }
                Text("Tienes la \(AppUpdate.shared.installedVersion)")
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.35))
                    .padding(.top, DS.Spacing.s)
            }
            .padding(.horizontal, DS.Spacing.xl)
            .padding(.bottom, DS.Spacing.l)
        }
        .environment(\.colorScheme, .dark)
        .interactiveDismissDisabled(required)
    }
}

/// Shows the update screen when there is one (checked on launch and on coming back to the app),
/// never on top of a run being recorded: it waits for the run to end.
struct AppUpdateGate: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(RunTracker.self) private var tracker
    @State private var update = AppUpdate.shared

    private var blocking: (version: String, required: Bool)? {
        switch update.state {
        case .required(let version, _):
            return (version, true)
        case .available(let version, _) where update.dismissedVersion != version:
            return (version, false)
        default:
            return nil
        }
    }

    func body(content: Content) -> some View {
        content
            .overlay {
                if let blocking, !tracker.isRecording {
                    AppUpdateView(
                        version: blocking.version,
                        required: blocking.required,
                        onUpdate: { update.openStore() },
                        onLater: { withAnimation(.easeOut(duration: 0.25)) { update.dismissedVersion = blocking.version } }
                    )
                    .transition(.opacity)
                    .zIndex(1000)
                }
            }
            .animation(.easeInOut(duration: 0.3), value: update.state)
            .task { await update.check(force: true) }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await update.check() } }
            }
    }
}

extension View {
    func appUpdateGate() -> some View {
        modifier(AppUpdateGate())
    }
}
