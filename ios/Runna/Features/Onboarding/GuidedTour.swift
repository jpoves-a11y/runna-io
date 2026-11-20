import SwiftUI
import Observation
import UserNotifications

// First-login guided tour: on top of the real app, a dimmed layer with a spotlight on the part being
// explained and a card with a short, human text. It walks through the map and takes a look at each
// tab. The first time it can't be skipped; replayed from Perfil → Ver tutorial it can be closed.
//
// Parts of the screen take part with `.tourAnchor(.id)`: they report their frame (global coordinates)
// to TourController, and the overlay on MainTabView cuts the spotlight there.

/// The parts of the app the tour points at.
enum TourAnchor: Hashable {
    case mapStats, mapModeSwitch, mapAvatar, mapControls, powers, missions, runButton
    case rankingTabs, activityPicker, clubPicker
}

struct TourStep: Identifiable {
    let id: String
    let tab: AppRouter.Tab
    /// nil: a card in the middle, without spotlight (welcome and the end)
    let anchor: TourAnchor?
    let title: String
    let text: String
    /// Extra room around the highlighted part
    var padding: CGFloat = 8
    /// Rounded rectangle corner of the spotlight (capsules and circles get a big one)
    var cornerRadius: CGFloat = 16
    /// Left out when its part isn't on screen (e.g. the missions card after the first two weeks)
    var optional = false
}

@MainActor
@Observable
final class TourController {
    static let shared = TourController()

    /// UserDefaults flag: the tour was completed on this device (same key as the old onboarding pages,
    /// so other first-launch pop-ups keep waiting for it).
    static let doneKey = OnboardingView.doneKey

    private(set) var isActive = false
    /// Replays (Perfil → Ver tutorial) can be closed; the first one can't.
    private(set) var canClose = false
    private(set) var index = 0
    private(set) var steps: [TourStep] = []
    /// Frames of the anchors on screen, in global coordinates.
    private(set) var frames: [TourAnchor: CGRect] = [:]

    private init() {}

    var step: TourStep? { steps.indices.contains(index) ? steps[index] : nil }
    var isLast: Bool { index == steps.count - 1 }

    /// e2e screenshots run without the tour (like the old onboarding).
    static var isDisabledForTests: Bool { OnboardingView.isDisabledForTests }

    static var isDone: Bool { UserDefaults.standard.bool(forKey: doneKey) }

    func start(firstName: String?, replay: Bool) {
        steps = Self.makeSteps(firstName: firstName)
        index = 0
        canClose = replay
        isActive = true
        prepare()
        Analytics.track(replay ? "tour_replayed" : "tour_started")
    }

    func next() {
        guard isActive else { return }
        if isLast {
            finish()
            return
        }
        index += 1
        skipMissingOptional(forward: true)
        prepare()
    }

    func back() {
        guard isActive, index > 0 else { return }
        index -= 1
        skipMissingOptional(forward: false)
        prepare()
    }

    func close() {
        guard canClose else { return }
        Analytics.track("tour_closed", ["step": step?.id ?? ""])
        end()
    }

    private func finish() {
        Analytics.track("tour_completed")
        UserDefaults.standard.set(true, forKey: Self.doneKey)
        end()
    }

    private func end() {
        isActive = false
        AppRouter.shared.selectedTab = .map
    }

    func report(_ anchor: TourAnchor, frame: CGRect?) {
        if let frame, frame.width > 1, frame.height > 1 {
            if frames[anchor] != frame { frames[anchor] = frame }
        } else if frames[anchor] != nil {
            frames[anchor] = nil
        }
    }

    /// Optional steps whose part isn't on screen are skipped.
    private func skipMissingOptional(forward: Bool) {
        while let step, step.optional, let anchor = step.anchor, frames[anchor] == nil {
            let nextIndex = forward ? index + 1 : index - 1
            guard steps.indices.contains(nextIndex) else { return }
            index = nextIndex
        }
    }

    /// Shows the tab of the step (the map in Global mode for the map steps).
    private func prepare() {
        guard let step else { return }
        let router = AppRouter.shared
        router.showProfile = false
        if router.selectedTab != step.tab { router.selectedTab = step.tab }
        if step.tab == .map, step.anchor == .mapStats { MapModel.shared.mode = .global }
        if step.tab == .club { router.clubSection = .club }
        if step.tab == .activity { router.activitySection = .feed }
    }

    private static func makeSteps(firstName: String?) -> [TourStep] {
        let hello = firstName.map { "¡Hola, \($0)!" } ?? "¡Hola!"
        return [
            TourStep(id: "welcome", tab: .map, anchor: nil,
                     title: hello,
                     text: "En Runna.io cada carrera se convierte en territorio en el mapa de tu ciudad. Te enseño lo importante en un minuto."),
            TourStep(id: "stats", tab: .map, anchor: .mapStats,
                     title: "Tu territorio",
                     text: "Aquí ves cuánto mapa es tuyo y en qué puesto vas. Cada vez que cierras un recorrido corriendo, el área de dentro pasa a ser tuya.",
                     cornerRadius: 29),
            TourStep(id: "modes", tab: .map, anchor: .mapModeSwitch,
                     title: "Dos mapas",
                     text: "Global es tu mapa para siempre: lo que conquistas ahí nadie te lo quita. Competición es la batalla de tu club cada dos semanas, y ahí sí se roba territorio.",
                     padding: 6, cornerRadius: 24),
            TourStep(id: "controls", tab: .map, anchor: .mapControls,
                     title: "Tus herramientas",
                     text: "Cambia las capas del mapa, mira tus recorridos o vuelve a centrarte en tu ubicación.",
                     cornerRadius: 28),
            TourStep(id: "powers", tab: .map, anchor: .powers,
                     title: "Poderes",
                     text: "Los cofres que recoges corriendo te dan poderes: escudos, área doble y alguna sorpresa. Los usas desde aquí.",
                     cornerRadius: 28),
            TourStep(id: "missions", tab: .map, anchor: .missions,
                     title: "Primeros pasos",
                     text: "Cinco retos para arrancar con buen pie. Complétalos y te regalamos un poder.",
                     optional: true),
            TourStep(id: "run", tab: .map, anchor: .runButton,
                     title: "A correr",
                     text: "Toca aquí cuando salgas a correr. Te avisaré por voz de cada kilómetro y de cuándo pisas territorio que puedes robar. También vale decir «Oye Siri, empieza una carrera en Runna.io».",
                     cornerRadius: 22),
            TourStep(id: "rankings", tab: .rankings, anchor: .rankingTabs,
                     title: "Ranking",
                     text: "Compárate con tus amigos, con tu ciudad o con todo el mundo, y mira cómo va tu club.",
                     cornerRadius: 14),
            TourStep(id: "activity", tab: .activity, anchor: .activityPicker,
                     title: "Actividad",
                     text: "Lo que hacen tus amigos: carreras, robos y cofres. Comenta, reacciona y pica a quien te robe. En «Mis carreras» tienes todas las tuyas.",
                     cornerRadius: 12),
            TourStep(id: "club", tab: .club, anchor: .clubPicker,
                     title: "Tu club",
                     text: "Únete a un club de tu ciudad, o crea el tuyo, para competir juntos cada dos semanas. Aquí también están su chat y tus amigos.",
                     cornerRadius: 12),
            TourStep(id: "profile", tab: .map, anchor: .mapAvatar,
                     title: "Tu perfil",
                     text: "Tu foto, tus relojes, los avisos por voz y la zona privada para que nadie vea dónde vives. Desde aquí puedes repetir este tutorial cuando quieras.",
                     padding: 6, cornerRadius: 26),
            TourStep(id: "done", tab: .map, anchor: nil,
                     title: "¡Listo para conquistar!",
                     text: "Activa las notificaciones para saber cuándo te roban territorio o te reta un amigo. Lo demás lo irás descubriendo corriendo."),
        ]
    }
}

// MARK: - Anchors

extension View {
    /// Marks this view as a part the guided tour can point at.
    func tourAnchor(_ anchor: TourAnchor) -> some View {
        modifier(TourAnchorModifier(anchor: anchor))
    }
}

private struct TourAnchorModifier: ViewModifier {
    let anchor: TourAnchor

    func body(content: Content) -> some View {
        content.background(
            GeometryReader { proxy in
                let frame = proxy.frame(in: .global)
                Color.clear
                    .onAppear { TourController.shared.report(anchor, frame: frame) }
                    .onChange(of: frame) { _, newFrame in TourController.shared.report(anchor, frame: newFrame) }
                    .onDisappear { TourController.shared.report(anchor, frame: nil) }
            }
        )
    }
}

// MARK: - Overlay

/// Shown over MainTabView (tab bar included) while the tour runs.
struct GuidedTourOverlay: View {
    @State private var tour = TourController.shared
    @State private var notificationStatus: UNAuthorizationStatus = .notDetermined
    @State private var isRequesting = false

    var body: some View {
        GeometryReader { proxy in
            let origin = proxy.frame(in: .global).origin
            let size = proxy.size
            let hole = spotlightRect(origin: origin)
            ZStack(alignment: .topLeading) {
                scrim(size: size, hole: hole)
                if let hole {
                    RoundedRectangle(cornerRadius: corner(for: hole), style: .continuous)
                        .stroke(Color.white.opacity(0.9), lineWidth: 2)
                        .frame(width: hole.width, height: hole.height)
                        .offset(x: hole.minX, y: hole.minY)
                        .allowsHitTesting(false)
                }
                if let step = tour.step {
                    card(step: step)
                        .frame(maxWidth: 420)
                        .padding(.horizontal, DS.Spacing.l)
                        .frame(width: size.width)
                        .modifier(CardPlacement(hole: hole, size: size, safeTop: proxy.safeAreaInsets.top, safeBottom: proxy.safeAreaInsets.bottom))
                        .id(step.id)
                        .transition(.opacity.combined(with: .scale(scale: 0.97)))
                }
            }
            .animation(.spring(response: 0.45, dampingFraction: 0.86), value: hole)
            .animation(.easeInOut(duration: 0.2), value: tour.step?.id)
        }
        .ignoresSafeArea()
        .task { notificationStatus = await PushManager.shared.authorizationStatus() }
        .accessibilityAddTraits(.isModal)
    }

    /// The highlighted part (with its padding), in the overlay's coordinates; nil for a centred card.
    private func spotlightRect(origin: CGPoint) -> CGRect? {
        guard let step = tour.step, let anchor = step.anchor, let frame = tour.frames[anchor] else { return nil }
        return frame.offsetBy(dx: -origin.x, dy: -origin.y).insetBy(dx: -step.padding, dy: -step.padding)
    }

    private func corner(for hole: CGRect) -> CGFloat {
        min(tour.step?.cornerRadius ?? 16, min(hole.width, hole.height) / 2)
    }

    /// Dimmed screen with the spotlight cut out. Taps outside the card do nothing (the app is paused).
    private func scrim(size: CGSize, hole: CGRect?) -> some View {
        Rectangle()
            .fill(Color.black.opacity(0.62))
            .mask {
                Rectangle()
                    .overlay(alignment: .topLeading) {
                        if let hole {
                            RoundedRectangle(cornerRadius: corner(for: hole), style: .continuous)
                                .frame(width: hole.width, height: hole.height)
                                .offset(x: hole.minX, y: hole.minY)
                                .blendMode(.destinationOut)
                        }
                    }
                    .compositingGroup()
            }
            .frame(width: size.width, height: size.height)
            .contentShape(Rectangle())
            .onTapGesture {}
    }

    private func card(step: TourStep) -> some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            HStack {
                Text("\(tour.index + 1) de \(tour.steps.count)")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
                if tour.canClose {
                    Button("Cerrar") { tour.close() }
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            Text(step.title)
                .font(.title3.weight(.bold))
                .fixedSize(horizontal: false, vertical: true)
            Text(step.text)
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if step.id == "done" {
                notificationButton
            }
            progress
            HStack(spacing: DS.Spacing.m) {
                if tour.index > 0 {
                    Button("Atrás") {
                        Haptics.tap()
                        tour.back()
                    }
                    .buttonStyle(SecondaryButtonStyle(tint: Color.primary))
                }
                Button {
                    Haptics.tap()
                    tour.next()
                } label: {
                    Text(tour.isLast ? "Empezar" : tour.index == 0 ? "Vamos" : "Siguiente")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
            }
        }
        .padding(DS.Spacing.xl)
        .background(Color.surface, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous)
                .stroke(Color.hairline, lineWidth: DS.Stroke.hairline)
        )
        .accessibilityElement(children: .contain)
    }

    private var progress: some View {
        HStack(spacing: 5) {
            ForEach(tour.steps.indices, id: \.self) { i in
                Capsule()
                    .fill(i <= tour.index ? Color.brand : Color.secondary.opacity(0.25))
                    .frame(width: i == tour.index ? 18 : 6, height: 6)
            }
        }
        .animation(.snappy, value: tour.index)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var notificationButton: some View {
        switch notificationStatus {
        case .authorized, .provisional, .ephemeral:
            Label("Notificaciones activadas", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.brand)
        case .denied:
            Text("Puedes activarlas cuando quieras en Ajustes.")
                .font(.footnote)
                .foregroundStyle(.secondary)
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
                    Label("Activar notificaciones", systemImage: "bell.badge")
                }
            }
            .buttonStyle(SecondaryButtonStyle(tint: Color.brand))
            .disabled(isRequesting)
        }
    }
}

/// Puts the card below the spotlight when there's room, above it otherwise, in the middle without one.
private struct CardPlacement: ViewModifier {
    let hole: CGRect?
    let size: CGSize
    let safeTop: CGFloat
    let safeBottom: CGFloat

    func body(content: Content) -> some View {
        GeometryReader { _ in
            content
                .fixedSize(horizontal: false, vertical: true)
                .background(GeometryReader { card in
                    Color.clear.preference(key: CardHeightKey.self, value: card.size.height)
                })
                .modifier(CardOffset(hole: hole, size: size, safeTop: safeTop, safeBottom: safeBottom))
        }
    }
}

private struct CardHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 260
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct CardOffset: ViewModifier {
    let hole: CGRect?
    let size: CGSize
    let safeTop: CGFloat
    let safeBottom: CGFloat
    @State private var cardHeight: CGFloat = 260

    func body(content: Content) -> some View {
        content
            .onPreferenceChange(CardHeightKey.self) { cardHeight = $0 }
            .offset(y: y)
    }

    private var y: CGFloat {
        let gap: CGFloat = 14
        let top = max(safeTop, 20) + 12
        let bottom = size.height - max(safeBottom, 20) - 12
        guard let hole else { return max(top, (size.height - cardHeight) / 2) }
        if hole.maxY + gap + cardHeight <= bottom { return hole.maxY + gap }
        if hole.minY - gap - cardHeight >= top { return hole.minY - gap - cardHeight }
        // Neither fits (a tall part): over the half of the screen away from it
        return hole.midY > size.height / 2 ? top : bottom - cardHeight
    }
}
