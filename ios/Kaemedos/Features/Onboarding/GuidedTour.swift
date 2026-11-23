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
    enum Placement { case auto, above, below }

    let id: String
    let tab: AppRouter.Tab
    /// nil: a card in the middle, without spotlight (welcome, competition, the end)
    let anchor: TourAnchor?
    /// SF Symbol shown in the card
    let symbol: String
    let title: String
    /// Markdown: **words** are highlighted in the brand colour
    let text: String
    /// Extra room around the highlighted part
    var padding: CGFloat = 8
    /// Rounded rectangle corner of the spotlight (capsules and circles get a big one)
    var cornerRadius: CGFloat = 16
    /// Where the card goes relative to the spotlight
    var placement: Placement = .auto
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
        if let userId = RunOwner.currentUserId {
            UserDefaults.standard.set(true, forKey: Self.doneKey(for: userId))
        }
        // Remembered for the account, so another device doesn't show it again
        Task { try? await APIClient.shared.send("POST", "/api/users/me/tour-done", body: [:]) }
        end()
    }

    /// Per-account flag on this device (the server's tourDoneAt is the one that counts).
    static func doneKey(for userId: String) -> String { "tourDone.\(userId)" }

    /// The tour is shown once per account: the first time it signs in, on whichever device.
    static func shouldShow(for user: AppUser?) -> Bool {
        guard let user, user.tourDoneAt == nil else { return false }
        return !UserDefaults.standard.bool(forKey: doneKey(for: user.id))
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
        let welcome = firstName.map { "¡Bienvenido, \($0)!" } ?? "¡Bienvenido!"
        return [
            TourStep(id: "welcome", tab: .map, anchor: nil, symbol: "figure.run",
                     title: welcome,
                     text: "¿Listo para conquistar tu ciudad? Te enseño lo más importante en un momento."),
            TourStep(id: "stats", tab: .map, anchor: .mapStats, symbol: "square.dashed.inset.filled",
                     title: "Tu territorio",
                     text: "Aquí ves cuánto mapa es tuyo y en qué puesto vas. Cada vez que acabes una carrera, el área que encierra tu recorrido pasa a ser **tuya**.",
                     cornerRadius: 29),
            TourStep(id: "modes", tab: .map, anchor: .mapModeSwitch, symbol: "map",
                     title: "Dos mapas",
                     text: "**Global**: en este mapa vas sumando conquistas sin que nadie te robe.\n\n**Competición**: aquí es donde lucharás tanto contra tu club como contra otros.",
                     padding: 6, cornerRadius: 24),
            TourStep(id: "controls", tab: .map, anchor: .mapControls, symbol: "slider.horizontal.3",
                     title: "Tus herramientas",
                     text: "Cambia las **capas** del mapa, mira tus **recorridos** o vuelve a **centrarte** en tu ubicación.",
                     cornerRadius: 28),
            TourStep(id: "powers", tab: .map, anchor: .powers, symbol: "bolt.fill",
                     title: "Poderes",
                     text: "Los cofres que recoges corriendo o ganas en competición te dan **poderes**: escudos, área doble y alguna sorpresa. Los usas desde aquí.",
                     cornerRadius: 28),
            TourStep(id: "missions", tab: .map, anchor: .missions, symbol: "checklist",
                     title: "Primeros pasos",
                     text: "Cinco retos para arrancar con buen pie. Complétalos y te regalamos un **poder**.",
                     placement: .above, optional: true),
            TourStep(id: "run", tab: .map, anchor: .runButton, symbol: "figure.run",
                     title: "A correr",
                     text: "Toca aquí cuando salgas a correr. Te avisaré **por voz** de cada kilómetro y de cuándo pisas territorio que puedes robar. También vale decir «Oye Siri, empieza una carrera en Kaemedos».",
                     cornerRadius: 22, placement: .above),
            TourStep(id: "rankings", tab: .rankings, anchor: .rankingTabs, symbol: "trophy",
                     title: "Ranking",
                     text: "Compárate con tus **amigos**, con tu **ciudad** o con **todo el mundo**, y mira cómo va tu club.",
                     cornerRadius: 14),
            TourStep(id: "activity", tab: .activity, anchor: .activityPicker, symbol: "bubble.left.and.bubble.right",
                     title: "Actividad",
                     text: "Lo que hacen tus amigos: carreras, robos y cofres. Comenta, reacciona y pica a quien te robe. En **Mis carreras** puedes ver tus últimas hazañas, ¡y compartirlas!",
                     cornerRadius: 12),
            TourStep(id: "club", tab: .club, anchor: .clubPicker, symbol: "shield.lefthalf.filled",
                     title: "Tu club",
                     text: "Únete a un club de tu ciudad, o crea el tuyo, para competir juntos. Aquí también están su **chat** y tus **amigos**.",
                     cornerRadius: 12),
            TourStep(id: "competition", tab: .club, anchor: nil, symbol: "flag.checkered",
                     title: "La competición",
                     text: "Cada **dos semanas** empieza una competición nueva, con un modo de juego distinto cada vez.\n\nEntre una y otra hay un **periodo de gracia** para refrescar y conseguir más cofres."),
            TourStep(id: "profile", tab: .map, anchor: .mapAvatar, symbol: "person.crop.circle",
                     title: "Tu perfil",
                     text: "Desde aquí podrás personalizar tu **perfil** y tus **ajustes**.",
                     padding: 6, cornerRadius: 26),
            TourStep(id: "done", tab: .map, anchor: nil, symbol: "flag.fill",
                     title: "¡Listo para conquistar!",
                     text: "Activa las **notificaciones** para saber cuándo te roban territorio o te reta un amigo. Lo demás lo irás descubriendo corriendo."),
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
    @State private var ringPulse = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        GeometryReader { proxy in
            let origin = proxy.frame(in: .global).origin
            let size = proxy.size
            let hole = spotlightRect(origin: origin)
            ZStack(alignment: .topLeading) {
                scrim(size: size, hole: hole)
                if let hole {
                    spotlightRing(hole)
                }
                if let step = tour.step {
                    TourCardSlot(
                        hole: hole,
                        placement: step.placement,
                        size: size,
                        safeTop: max(proxy.safeAreaInsets.top, 20),
                        safeBottom: max(proxy.safeAreaInsets.bottom, 20)
                    ) {
                        card(step: step)
                            .frame(maxWidth: 440)
                            .padding(.horizontal, DS.Spacing.l)
                    }
                    .id(step.id)
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .offset(y: 10)),
                        removal: .opacity
                    ))
                }
            }
            .animation(.spring(response: 0.5, dampingFraction: 0.85), value: hole)
            .animation(.easeOut(duration: 0.25), value: tour.step?.id)
        }
        .ignoresSafeArea()
        .task { notificationStatus = await PushManager.shared.authorizationStatus() }
        .onAppear {
            withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) { ringPulse = true }
        }
        .accessibilityAddTraits(.isModal)
    }

    // MARK: Spotlight

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
            .fill(Color.black.opacity(colorScheme == .dark ? 0.7 : 0.58))
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

    /// A fine ring in the brand colour around the spotlight, with a soft halo that breathes.
    private func spotlightRing(_ hole: CGRect) -> some View {
        let shape = RoundedRectangle(cornerRadius: corner(for: hole), style: .continuous)
        return ZStack {
            shape
                .stroke(Color.brand.opacity(ringPulse ? 0.0 : 0.45), lineWidth: 6)
                .padding(-5)
            shape
                .stroke(Color.white.opacity(0.95), lineWidth: 1.5)
            shape
                .stroke(Color.brand, lineWidth: 1)
                .padding(-2)
        }
        .frame(width: hole.width, height: hole.height)
        .offset(x: hole.minX, y: hole.minY)
        .allowsHitTesting(false)
    }

    // MARK: Card

    private func card(step: TourStep) -> some View {
        let isHero = step.anchor == nil
        return VStack(alignment: isHero ? .center : .leading, spacing: DS.Spacing.l) {
            header(step: step, isHero: isHero)
            VStack(alignment: isHero ? .center : .leading, spacing: DS.Spacing.s) {
                Text(step.title)
                    .font(.system(size: isHero ? 28 : 22, weight: .bold))
                    .tracking(-0.4)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(isHero ? .center : .leading)
                    .fixedSize(horizontal: false, vertical: true)
                Text(Self.styledText(step.text))
                    .font(.system(size: 16))
                    .lineSpacing(3)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(isHero ? .center : .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: isHero ? .center : .leading)
            if step.id == "done" {
                notificationButton
            }
            buttons
        }
        .padding(DS.Spacing.xl)
        .padding(.top, isHero ? DS.Spacing.s : 0)
        .background {
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .fill(Color(uiColor: .systemBackground))
                .shadow(color: Color.black.opacity(0.28), radius: 24, x: 0, y: 12)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.12 : 0), lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
    }

    /// Icon tile and "PASO 3 DE 13" with a thin progress bar; the welcome and end cards get a big icon.
    @ViewBuilder
    private func header(step: TourStep, isHero: Bool) -> some View {
        if isHero {
            VStack(spacing: DS.Spacing.l) {
                HStack {
                    stepLabel
                    Spacer()
                    closeButton
                }
                ZStack {
                    Circle()
                        .fill(Color.brand.opacity(0.12))
                        .frame(width: 84, height: 84)
                    Circle()
                        .fill(Color.brand)
                        .frame(width: 60, height: 60)
                    Image(systemName: step.symbol)
                        .font(.system(size: 26, weight: .semibold))
                        .foregroundStyle(Color.onBrand)
                }
                .accessibilityHidden(true)
            }
        } else {
            VStack(alignment: .leading, spacing: DS.Spacing.m) {
                HStack(spacing: DS.Spacing.m) {
                    Image(systemName: step.symbol)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Color.brand)
                        .frame(width: 40, height: 40)
                        .background(Color.brand.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .accessibilityHidden(true)
                    stepLabel
                    Spacer()
                    closeButton
                }
                progressBar
            }
        }
    }

    private var stepLabel: some View {
        Text("PASO \(tour.index + 1) DE \(tour.steps.count)")
            .font(.system(size: 11, weight: .semibold))
            .tracking(1.2)
            .foregroundStyle(Color.brand)
    }

    @ViewBuilder
    private var closeButton: some View {
        if tour.canClose {
            Button {
                tour.close()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 30, height: 30)
                    .background(Color.secondary.opacity(0.12), in: Circle())
            }
            .accessibilityLabel("Cerrar tutorial")
        }
    }

    private var progressBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.15))
                Capsule()
                    .fill(Color.brand)
                    .frame(width: max(6, geo.size.width * CGFloat(tour.index + 1) / CGFloat(max(tour.steps.count, 1))))
            }
        }
        .frame(height: 4)
        .animation(.spring(response: 0.45, dampingFraction: 0.9), value: tour.index)
        .accessibilityHidden(true)
    }

    private var buttons: some View {
        HStack(spacing: DS.Spacing.m) {
            if tour.index > 0 {
                Button {
                    Haptics.tap()
                    tour.back()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(.primary)
                        .frame(width: 52, height: 52)
                        .background(Color.secondary.opacity(0.12), in: Circle())
                }
                .accessibilityLabel("Atrás")
            }
            Button {
                Haptics.tap()
                tour.next()
            } label: {
                HStack(spacing: 8) {
                    Text(tour.isLast ? "Empezar a correr" : tour.index == 0 ? "Empezar el recorrido" : "Siguiente")
                    Image(systemName: tour.isLast ? "figure.run" : "arrow.right")
                        .font(.system(size: 15, weight: .bold))
                }
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.onBrand)
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .background(Color.brand, in: Capsule())
            }
            .buttonStyle(.pressable)
        }
    }

    @ViewBuilder
    private var notificationButton: some View {
        switch notificationStatus {
        case .authorized, .provisional, .ephemeral:
            Label("Notificaciones activadas", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.semibold))
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
                HStack(spacing: 8) {
                    if isRequesting {
                        ProgressView()
                    } else {
                        Image(systemName: "bell.badge.fill")
                        Text("Activar notificaciones")
                    }
                }
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Color.brand)
                .frame(maxWidth: .infinity)
                .frame(height: 46)
                .background(Color.brand.opacity(0.12), in: Capsule())
            }
            .buttonStyle(.pressable)
            .disabled(isRequesting)
        }
    }

    /// Markdown body: **words** in the brand colour and semibold, paragraphs kept.
    static func styledText(_ markdown: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        guard var text = try? AttributedString(markdown: markdown, options: options) else { return AttributedString(markdown) }
        for run in text.runs where run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true {
            text[run.range].foregroundColor = Color.brand
            text[run.range].font = .system(size: 16, weight: .semibold)
        }
        return text
    }
}

/// Puts the card below the spotlight or above it (whichever the step asks, else where there's more
/// room), or in the middle without one. It aligns the card's edge to the gap, so its height never
/// has to be known and it can't cover the highlighted part.
private struct TourCardSlot<Content: View>: View {
    let hole: CGRect?
    let placement: TourStep.Placement
    let size: CGSize
    let safeTop: CGFloat
    let safeBottom: CGFloat
    @ViewBuilder let content: Content

    private let gap: CGFloat = 16

    var body: some View {
        let top = safeTop + 8
        let bottom = size.height - safeBottom - 8
        if let hole {
            let spaceBelow = bottom - (hole.maxY + gap)
            let spaceAbove = (hole.minY - gap) - top
            let goesAbove: Bool = {
                switch placement {
                case .above: return true
                case .below: return false
                case .auto: return spaceBelow < 280 && spaceAbove > spaceBelow
                }
            }()
            if goesAbove {
                // The card's bottom edge sits just above the spotlight
                content
                    .frame(width: size.width, height: max(0, hole.minY - gap - top), alignment: .bottom)
                    .offset(y: top)
            } else {
                content
                    .frame(width: size.width, height: max(0, bottom - hole.maxY - gap), alignment: .top)
                    .offset(y: hole.maxY + gap)
            }
        } else {
            content
                .frame(width: size.width, height: size.height)
        }
    }
}
