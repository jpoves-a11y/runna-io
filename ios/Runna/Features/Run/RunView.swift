import SwiftUI
import UIKit
import MapKit
import CoreLocation

/// Full-screen run recorder.
struct RunView: View {
    @Environment(RunTracker.self) private var tracker
    @Environment(SessionStore.self) private var session
    @State private var camera: MapCameraPosition = .userLocation(followsHeading: false, fallback: .automatic)
    @State private var confirmFinish = false
    @State private var confirmCancel = false
    @State private var submission: RunSubmission?
    @State private var tooShortAlert = false
    @State private var confirmReplaceRecovered = false

    private var userColor: Color { Color(hex: session.user?.color ?? "#16A34A") }

    var body: some View {
        ZStack(alignment: .bottom) {
            map
                .ignoresSafeArea()

            // Soft fade so the glass panel reads well over busy maps
            LinearGradient(colors: [Color.black.opacity(0), Color.black.opacity(0.18)], startPoint: .center, endPoint: .bottom)
                .ignoresSafeArea()
                .allowsHitTesting(false)

            VStack(spacing: DS.Spacing.m) {
                topBar
                if let treasure = tracker.lastCollected {
                    RunCollectedBanner(treasure: treasure)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                Spacer(minLength: 0)
                HStack {
                    Spacer()
                    recenterButton
                }
                .padding(.horizontal, DS.Spacing.l)
                controlPanel
            }
            .animation(.spring(duration: 0.35), value: tracker.lastCollected?.id)
            .animation(.snappy, value: tracker.phase)
        }
        .onAppear {
            tracker.refreshRecoverableRun()
            tracker.startPreview()
        }
        .onDisappear {
            tracker.stopPreview()
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: tracker.phase)
        .confirmationDialog("¿Terminar la carrera?", isPresented: $confirmFinish, titleVisibility: .visible) {
            Button("Terminar y guardar") { finish() }
            Button("Seguir corriendo", role: .cancel) {}
        } message: {
            Text("Truco: mantén pulsado el botón de meta para terminar al instante.")
        }
        .confirmationDialog("¿Descartar esta carrera?", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Descartar", role: .destructive) {
                tracker.cancel()
                tracker.isPresented = false
            }
            Button("Volver", role: .cancel) {}
        } message: {
            Text("Se perderá el recorrido grabado.")
        }
        .alert("Ruta demasiado corta", isPresented: $tooShortAlert) {
            Button("Seguir corriendo") {
                tracker.resume()
            }
            if tracker.pointCount >= 2 {
                Button("Guardar igualmente") { finish(force: true) }
            }
            Button("Descartar", role: .destructive) {
                tracker.cancel()
                tracker.isPresented = false
            }
        } message: {
            Text(tooShortMessage)
        }
        .confirmationDialog("Tienes una carrera sin terminar", isPresented: $confirmReplaceRecovered, titleVisibility: .visible) {
            Button("Continuar esa carrera") {
                tracker.resumeRecoveredRun()
            }
            Button("Descartarla y empezar una nueva", role: .destructive) {
                tracker.discardRecoveredRun()
                startRun()
            }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("Si empiezas una nueva, se perderá la carrera que quedó a medias.")
        }
        .fullScreenCover(item: Binding(
            get: { submission.map { IdentifiedSubmission(submission: $0) } },
            set: { if $0 == nil { submission = nil } }
        )) { item in
            RunSummaryView(submission: item.submission) {
                submission = nil
                tracker.isPresented = false
            }
        }
    }

    // MARK: - Map

    private var map: some View {
        Map(position: $camera) {
            ForEach(tracker.territoryShapes) { shape in
                MapPolygon(shape.polygon)
                    .foregroundStyle(shape.color.opacity(0.22))
                    .stroke(shape.color.opacity(0.6), lineWidth: 1.5)
            }
            UserAnnotation()
            if tracker.coordinates.count >= 2 {
                MapPolyline(coordinates: tracker.coordinates)
                    .stroke(Color.white.opacity(0.9), style: StrokeStyle(lineWidth: 10, lineCap: .round, lineJoin: .round))
                MapPolyline(coordinates: tracker.coordinates)
                    .stroke(userColor, style: StrokeStyle(lineWidth: 6, lineCap: .round, lineJoin: .round))
            }
            ForEach(tracker.visibleTreasures) { treasure in
                Annotation(treasure.name, coordinate: treasure.coordinate) {
                    RunTreasurePin(treasure: treasure)
                }
            }
        }
        .mapControls {
            MapCompass()
        }
    }

    private var recenterButton: some View {
        GlassCircleButton(systemImage: "location.fill", accessibilityLabel: "Centrar en mí", size: 44) {
            withAnimation(.snappy) {
                camera = .userLocation(followsHeading: false, fallback: .automatic)
            }
        }
    }

    // MARK: - Top bar

    private var topBar: some View {
        HStack(spacing: DS.Spacing.s) {
            if !tracker.isRecording || tracker.phase == .paused {
                GlassCircleButton(
                    systemImage: tracker.isRecording ? "trash" : "xmark",
                    accessibilityLabel: tracker.isRecording ? "Descartar carrera" : "Cerrar",
                    tint: tracker.isRecording ? Color.steal : nil,
                    size: 44
                ) {
                    if tracker.isRecording {
                        confirmCancel = true
                    } else {
                        tracker.isPresented = false
                    }
                }
                .transition(.scale.combined(with: .opacity))
            }
            if tracker.isRecording {
                RecordingBadge(isPaused: tracker.phase == .paused)
                    .transition(.scale.combined(with: .opacity))
            }
            Spacer(minLength: 0)
            GPSSignalView(accuracy: tracker.gpsAccuracy)
        }
        .padding(.horizontal, DS.Spacing.l)
        .padding(.top, DS.Spacing.s)
    }

    // MARK: - Controls

    private var controlPanel: some View {
        VStack(spacing: DS.Spacing.l) {
            if tracker.isLocationDenied {
                locationDeniedNotice
            } else if tracker.hasReducedAccuracy {
                reducedAccuracyNotice
            }

            TimelineView(.periodic(from: .now, by: 1)) { context in
                RunLiveMetrics(
                    seconds: Int(tracker.elapsed(at: context.date)),
                    distance: tracker.distance,
                    isPaused: tracker.phase == .paused,
                    isIdle: tracker.phase == .idle
                )
            }

            if !tracker.collectedTreasures.isEmpty {
                StatPill(
                    value: "\(tracker.collectedTreasures.count)",
                    label: tracker.collectedTreasures.count == 1 ? "tesoro recogido" : "tesoros recogidos",
                    systemImage: "gift.fill",
                    tint: Color.gold
                )
            }

            buttons
        }
        .padding(DS.Spacing.xl)
        .frame(maxWidth: .infinity)
        .glassSurface(RoundedRectangle(cornerRadius: 32, style: .continuous))
        .padding(.horizontal, DS.Spacing.m)
        .padding(.bottom, DS.Spacing.s)
    }

    @ViewBuilder
    private var buttons: some View {
        switch tracker.phase {
        case .idle:
            PrimaryActionButton(title: "Empezar", systemImage: "play.fill", pulse: canStart) {
                if tracker.hasRecoverableRun {
                    confirmReplaceRecovered = true
                } else {
                    startRun()
                }
            }
            // With approximate location every GPS fix is discarded: the run would be lost
            .disabled(!canStart)
            .opacity(canStart ? 1 : 0.45)
        case .running:
            HStack(spacing: DS.Spacing.xl) {
                Spacer(minLength: 0)
                RunRoundControl(systemImage: "pause.fill", title: "Pausar", gradient: .stealGradient, size: 84) {
                    Haptics.tap()
                    tracker.pause()
                }
                HoldToFinishButton(size: 64, onTap: { confirmFinish = true }, onFinish: { finish() })
                Spacer(minLength: 0)
            }
        case .paused:
            HStack(spacing: DS.Spacing.xl) {
                Spacer(minLength: 0)
                RunRoundControl(systemImage: "play.fill", title: "Seguir", gradient: .brandGradient, size: 84) {
                    Haptics.tap()
                    tracker.resume()
                }
                HoldToFinishButton(size: 84, onTap: { confirmFinish = true }, onFinish: { finish() })
                Spacer(minLength: 0)
            }
        }
    }

    private var canStart: Bool { !tracker.isLocationDenied && !tracker.hasReducedAccuracy }

    private var locationDeniedNotice: some View {
        RunNoticeCard(
            systemImage: "location.slash.fill",
            title: "Sin ubicación no hay conquista",
            message: "Runna.io necesita tu ubicación para grabar la carrera."
        ) {
            Button("Abrir Ajustes") { openSettings() }
                .buttonStyle(SecondaryButtonStyle(tint: Color.steal))
        }
    }

    private var reducedAccuracyNotice: some View {
        RunNoticeCard(
            systemImage: "location.slash",
            title: "Ubicación aproximada",
            message: "Para grabar la ruta, Runna.io necesita tu ubicación exacta. Sin ella no se guarda ningún punto GPS."
        ) {
            HStack(spacing: DS.Spacing.s) {
                Button("Permitir exacta") {
                    tracker.requestFullAccuracy()
                }
                .buttonStyle(SecondaryButtonStyle(tint: Color.brand))
                Button("Ajustes") { openSettings() }
                    .buttonStyle(SecondaryButtonStyle(tint: Color.steal))
            }
        }
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }

    private var tooShortMessage: String {
        if tracker.hasReducedAccuracy {
            return "Casi no hay puntos GPS: con la ubicación aproximada no se puede dibujar la ruta. Activa «Ubicación exacta» y sigue corriendo."
        }
        return "Apenas hay puntos GPS grabados (la señal ha sido muy débil). Puedes seguir corriendo, guardarla igualmente o descartarla."
    }

    private func startRun() {
        Haptics.tap()
        tracker.start()
    }

    private func finish(force: Bool = false) {
        guard let run = tracker.finish(force: force) else {
            // Stop the clock while the user decides what to do
            tracker.pause()
            tooShortAlert = true
            return
        }
        Haptics.success()
        let newSubmission = RunSubmission(run: run)
        submission = newSubmission
        Task { await newSubmission.submit() }
    }
}

/// Wrapper so the submission can drive `fullScreenCover(item:)`.
private struct IdentifiedSubmission: Identifiable {
    let submission: RunSubmission
    var id: ObjectIdentifier { ObjectIdentifier(submission) }
}

// MARK: - Metrics

/// Big time on top, distance and pace below.
private struct RunLiveMetrics: View {
    let seconds: Int
    let distance: Double
    let isPaused: Bool
    let isIdle: Bool

    var body: some View {
        VStack(spacing: DS.Spacing.m) {
            VStack(spacing: 2) {
                Text(Format.duration(seconds))
                    .font(.system(size: 64, weight: .heavy, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .foregroundStyle(isPaused ? Color.secondary : Color.primary)
                    .animation(.snappy, value: seconds)
                Text(isIdle ? "Listo para salir" : (isPaused ? "En pausa" : "Tiempo"))
                    .statLabelStyle()
            }
            HStack(spacing: 0) {
                metric(value: distanceValue, unit: distanceUnit, label: "Distancia", systemImage: "point.topleft.down.to.point.bottomright.curvepath.fill", tint: Color.sky)
                Rectangle()
                    .fill(Color.hairline)
                    .frame(width: 1, height: 44)
                metric(value: paceValue, unit: "/km", label: "Ritmo", systemImage: "speedometer", tint: Color.brand)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var distanceValue: String {
        let text = Format.distance(distance)
        return text.components(separatedBy: " ").first ?? text
    }

    private var distanceUnit: String {
        let parts = Format.distance(distance).components(separatedBy: " ")
        return parts.count > 1 ? parts[1] : ""
    }

    private var paceValue: String {
        let text = Format.pace(distanceMeters: distance, seconds: seconds)
        return text.components(separatedBy: " ").first ?? text
    }

    private func metric(value: String, unit: String, label: String, systemImage: String, tint: Color) -> some View {
        VStack(spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value)
                    .font(Font.stat(30, weight: .bold))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Text(unit)
                    .font(.system(.subheadline, design: .rounded, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            Label(label, systemImage: systemImage)
                .font(Font.statLabel)
                .textCase(.uppercase)
                .tracking(0.6)
                .foregroundStyle(tint)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Controls

/// Big round gradient control with a caption.
private struct RunRoundControl: View {
    let systemImage: String
    let title: String
    let gradient: LinearGradient
    var size: CGFloat = 84
    let action: () -> Void

    @State private var taps = 0

    var body: some View {
        Button {
            taps += 1
            action()
        } label: {
            VStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: size * 0.36, weight: .heavy))
                    .foregroundStyle(.white)
                    .symbolEffect(.bounce, value: taps)
                    .frame(width: size, height: size)
                    .background(gradient, in: Circle())
                    .overlay(Circle().strokeBorder(Color.white.opacity(0.3), lineWidth: 1))
                    .shadow(color: Color.black.opacity(0.2), radius: 10, x: 0, y: 6)
                Text(title)
                    .font(.system(.caption, design: .rounded, weight: .bold))
                    .foregroundStyle(.secondary)
            }
        }
        .buttonStyle(PressableButtonStyle(scale: 0.92))
        .accessibilityLabel(title)
    }
}

/// Finish button: hold it to finish right away (a progress ring fills), a quick tap asks first.
private struct HoldToFinishButton: View {
    var size: CGFloat = 84
    let onTap: () -> Void
    let onFinish: () -> Void

    private let holdDuration: Double = 1.2
    @State private var progress: CGFloat = 0
    @State private var pressStart: Date?
    @State private var completions = 0

    var body: some View {
        VStack(spacing: 6) {
            ZStack {
                Circle()
                    .fill(Color.surface)
                Circle()
                    .strokeBorder(Color.steal.opacity(0.25), lineWidth: 5)
                Circle()
                    .trim(from: 0, to: progress)
                    .stroke(Color.steal, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .padding(2.5)
                Image(systemName: "flag.checkered")
                    .font(.system(size: size * 0.32, weight: .heavy))
                    .foregroundStyle(Color.steal)
                    .symbolEffect(.bounce, value: completions)
            }
            .frame(width: size, height: size)
            .scaleEffect(progress > 0 ? 1.08 : 1)
            .shadow(color: Color.black.opacity(0.15), radius: 10, x: 0, y: 6)
            .contentShape(Circle())
            .onLongPressGesture(minimumDuration: holdDuration, maximumDistance: 40) {
                pressStart = nil
                completions += 1
                progress = 0
                onFinish()
            } onPressingChanged: { pressing in
                if pressing {
                    pressStart = Date()
                    withAnimation(.linear(duration: holdDuration)) { progress = 1 }
                } else {
                    withAnimation(.easeOut(duration: 0.2)) { progress = 0 }
                    // Released early (a tap or a short press): ask instead
                    if let start = pressStart, Date().timeIntervalSince(start) < holdDuration - 0.1 {
                        onTap()
                    }
                    pressStart = nil
                }
            }
            Text("Mantén para terminar")
                .font(.system(.caption, design: .rounded, weight: .bold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .fixedSize()
        }
        .sensoryFeedback(.success, trigger: completions)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Terminar carrera")
        .accessibilityHint("Mantén pulsado para terminar al instante")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onTap() }
    }
}

/// Coloured card for location problems inside the panel.
private struct RunNoticeCard<Actions: View>: View {
    let systemImage: String
    let title: String
    let message: String
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: DS.Spacing.s) {
            Label(title, systemImage: systemImage)
                .font(.system(.subheadline, design: .rounded, weight: .bold))
                .foregroundStyle(Color.steal)
            Text(message)
                .font(.footnote)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            actions
        }
        .padding(DS.Spacing.m)
        .frame(maxWidth: .infinity)
        .background(Color.steal.opacity(0.12), in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
    }
}

/// Treasure on the live map: emoji on a rarity-coloured glass bubble.
private struct RunTreasurePin: View {
    let treasure: Treasure

    var body: some View {
        Text(treasure.emoji ?? "🎁")
            .font(.title2)
            .frame(width: 44, height: 44)
            .background(.thinMaterial, in: Circle())
            .overlay(Circle().strokeBorder(TreasureLine.rarityColor(treasure.rarity), lineWidth: 2.5))
            .shadow(color: TreasureLine.rarityColor(treasure.rarity).opacity(0.5), radius: 8)
    }
}

/// "¡Cofre recogido!" banner at the top.
private struct RunCollectedBanner: View {
    let treasure: Treasure
    @State private var appeared = false

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            Text(treasure.emoji ?? "🎁")
                .font(.title)
                .scaleEffect(appeared ? 1 : 0.4)
                .rotationEffect(.degrees(appeared ? 0 : -30))
            VStack(alignment: .leading, spacing: 2) {
                Text("¡Cofre recogido!")
                    .font(.system(.subheadline, design: .rounded, weight: .heavy))
                Text("\(treasure.powerName ?? treasure.name) · \(TreasureLine.rarityName(treasure.rarity))")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TreasureLine.rarityColor(treasure.rarity))
            }
            Image(systemName: "sparkles")
                .foregroundStyle(Color.gold)
                .symbolEffect(.bounce, value: appeared)
        }
        .padding(.horizontal, DS.Spacing.l)
        .padding(.vertical, DS.Spacing.m)
        .glassSurface(Capsule())
        .overlay(Capsule().strokeBorder(TreasureLine.rarityColor(treasure.rarity), lineWidth: 2))
        .sensoryFeedback(.success, trigger: appeared)
        .onAppear {
            withAnimation(.spring(response: 0.45, dampingFraction: 0.55)) { appeared = true }
        }
        .accessibilityElement(children: .combine)
    }
}

/// "REC" while recording, "PAUSA" while paused.
private struct RecordingBadge: View {
    let isPaused: Bool

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Color.white)
                .frame(width: 8, height: 8)
                .opacity(isPaused ? 0 : 1)
                .overlay {
                    if isPaused {
                        Image(systemName: "pause.fill")
                            .font(.system(size: 9, weight: .heavy))
                            .foregroundStyle(.white)
                    }
                }
            Text(isPaused ? "PAUSA" : "REC")
                .font(.system(.caption, design: .rounded, weight: .heavy))
                .tracking(1)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
        .frame(height: 36)
        .background(isPaused ? AnyShapeStyle(LinearGradient.goldGradient) : AnyShapeStyle(Color.red), in: Capsule())
        .shadow(color: (isPaused ? Color.gold : Color.red).opacity(0.4), radius: 8, x: 0, y: 4)
        .modifier(RunBlinkModifier(active: !isPaused))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(isPaused ? "Carrera en pausa" : "Grabando carrera")
    }
}

/// Slow breathing opacity for the REC badge.
private struct RunBlinkModifier: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    func body(content: Content) -> some View {
        content
            .opacity(active && dim && !reduceMotion ? 0.75 : 1)
            .onAppear { start() }
            .onChange(of: active) { _, _ in start() }
    }

    private func start() {
        guard active, !reduceMotion else {
            dim = false
            return
        }
        withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
    }
}

/// GPS quality bars (same thresholds as the web app).
struct GPSSignalView: View {
    let accuracy: CLLocationAccuracy?

    private var level: (bars: Int, color: Color, label: String) {
        guard let accuracy else { return (0, .gray, "Buscando GPS…") }
        let meters = Int(accuracy.rounded())
        switch accuracy {
        case ...5: return (4, Color.brand, "\(meters) m · Excelente")
        case ...10: return (3, Color.brandLime, "\(meters) m · Buena")
        case ...20: return (2, Color.gold, "\(meters) m · Aceptable")
        case ...30: return (1, Color.steal, "\(meters) m · Débil")
        default: return (0, .red, "\(meters) m · Mala")
        }
    }

    var body: some View {
        let current = level
        HStack(spacing: 8) {
            HStack(alignment: .bottom, spacing: 2.5) {
                ForEach(0..<4) { index in
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(index < current.bars ? current.color : Color.secondary.opacity(0.3))
                        .frame(width: 4, height: CGFloat(6 + index * 3))
                }
            }
            .animation(.snappy, value: current.bars)
            Text(current.label)
                .font(.system(.caption, design: .rounded, weight: .bold))
                .monospacedDigit()
        }
        .padding(.horizontal, 14)
        .frame(height: 36)
        .glassSurface(Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Señal GPS: \(current.label)")
    }
}
