import SwiftUI
import UIKit
import MapKit
import CoreLocation

/// Full-screen run recorder: the map with the route and a bottom panel with the live metrics.
struct RunView: View {
    @Environment(RunTracker.self) private var tracker
    @Environment(SessionStore.self) private var session
    @State private var camera: MapCameraPosition = .userLocation(followsHeading: false, fallback: .automatic)
    @State private var confirmFinish = false
    @State private var confirmCancel = false
    @State private var submission: RunSubmission?
    @State private var tooShortAlert = false
    @State private var confirmReplaceRecovered = false
    @AppStorage(RunSettings.voiceKey) private var voiceEnabled = true
    @AppStorage(RunSettings.autoPauseKey) private var autoPauseEnabled = true

    var body: some View {
        ZStack(alignment: .bottom) {
            map
                .ignoresSafeArea()

            VStack(spacing: DS.Spacing.m) {
                topBar
                if let treasure = tracker.lastCollected {
                    RunCollectedBanner(treasure: treasure)
                        .transition(.move(edge: .top).combined(with: .opacity))
                } else if tracker.isRecording, let text = tracker.zone.text {
                    RunZoneBanner(text: text, isRival: tracker.zone.isRival, color: zoneColor)
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
            .animation(.snappy, value: tracker.lastCollected?.id)
            .animation(.snappy, value: tracker.zone)
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
            Text("Mantén pulsado el botón de terminar para hacerlo sin confirmar.")
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
                    .foregroundStyle(shape.color.opacity(0.18))
                    .stroke(shape.color.opacity(0.5), lineWidth: 1)
            }
            if tracker.isRecording, let preview = tracker.preview {
                // What you'd conquer if you finished now
                MapPolygon(coordinates: preview.ring)
                    .foregroundStyle(Color.brand.opacity(0.14))
                    .stroke(Color.brand.opacity(0.55), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
            }
            if tracker.isRecording, let start = tracker.coordinates.first, let last = tracker.coordinates.last,
               (tracker.distanceToStart ?? 0) > 20 {
                // How the territory closes: straight back to the start
                MapPolyline(coordinates: [last, start])
                    .stroke(Color.brand.opacity(0.7), style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [2, 6]))
            }
            if tracker.isRecording, let start = tracker.coordinates.first {
                Annotation("Salida", coordinate: start, anchor: .center) {
                    RunStartPin()
                }
                .annotationTitles(.hidden)
            }
            UserAnnotation()
            if tracker.coordinates.count >= 2 {
                MapPolyline(coordinates: tracker.coordinates)
                    .stroke(Color.white, style: StrokeStyle(lineWidth: 8, lineCap: .round, lineJoin: .round))
                MapPolyline(coordinates: tracker.coordinates)
                    .stroke(Color.brand, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
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
        GlassCircleButton(systemImage: "location", accessibilityLabel: "Centrar en mí", size: DS.Size.mapControl) {
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
                    size: DS.Size.mapControl
                ) {
                    if tracker.isRecording {
                        confirmCancel = true
                    } else {
                        tracker.isPresented = false
                    }
                }
                .transition(.opacity)
            }
            Spacer(minLength: 0)
            settingsMenu
        }
        .padding(.horizontal, DS.Spacing.l)
        .padding(.top, DS.Spacing.s)
    }

    /// Voice cues and auto-pause, kept between runs.
    private var settingsMenu: some View {
        Menu {
            Toggle(isOn: $voiceEnabled) {
                Label("Avisos de voz", systemImage: "speaker.wave.2")
            }
            Toggle(isOn: $autoPauseEnabled) {
                Label("Pausa automática", systemImage: "pause.circle")
            }
        } label: {
            GlassCircleLabel(systemImage: voiceEnabled ? "speaker.wave.2" : "speaker.slash", size: DS.Size.mapControl)
        }
        .accessibilityLabel("Opciones de la carrera")
    }

    private var zoneColor: Color {
        switch tracker.zone {
        case .none: return Color.secondary
        case .mine: return Color.brand
        case .rival(let userId, _):
            return tracker.territoryShapes.first { $0.userId == userId }?.color ?? Color.steal
        }
    }

    // MARK: - Panel

    private var controlPanel: some View {
        VStack(spacing: DS.Spacing.xl) {
            panelHeader

            if tracker.isLocationDenied {
                locationDeniedNotice
            } else if tracker.hasReducedAccuracy {
                reducedAccuracyNotice
            }

            TimelineView(.periodic(from: .now, by: 1)) { context in
                RunLiveMetrics(
                    seconds: Int(tracker.elapsed(at: context.date)),
                    distance: tracker.distance,
                    currentPace: tracker.currentPace,
                    lastSplit: tracker.lastSplit,
                    isPaused: tracker.phase == .paused,
                    isAutoPaused: tracker.isAutoPaused
                )
            }

            if tracker.isRecording {
                RunTerritoryStrip(
                    preview: tracker.preview,
                    distanceToStart: tracker.distanceToStart,
                    bearingToStart: tracker.bearingToStart,
                    heading: tracker.currentLocation?.course
                )
            }

            buttons
        }
        .padding(.horizontal, DS.Spacing.xl)
        .padding(.top, DS.Spacing.l)
        .padding(.bottom, DS.Spacing.m)
        .frame(maxWidth: .infinity)
        .background {
            UnevenRoundedRectangle(topLeadingRadius: 24, topTrailingRadius: 24, style: .continuous)
                .fill(Color(uiColor: .systemBackground))
                .ignoresSafeArea(edges: .bottom)
        }
    }

    /// Recording status on the left, GPS quality on the right; treasures in between when any.
    private var panelHeader: some View {
        HStack(spacing: DS.Spacing.m) {
            RunStatusLabel(phase: tracker.phase)
            if !tracker.collectedTreasures.isEmpty {
                treasureCount
            }
            Spacer(minLength: DS.Spacing.s)
            GPSSignalView(accuracy: tracker.gpsAccuracy)
        }
    }

    private var treasureCount: some View {
        let count: Int = tracker.collectedTreasures.count
        return Label(count == 1 ? "1 tesoro" : "\(count) tesoros", systemImage: "gift")
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .monospacedDigit()
            .lineLimit(1)
    }

    @ViewBuilder
    private var buttons: some View {
        switch tracker.phase {
        case .idle:
            Button {
                if tracker.hasRecoverableRun {
                    confirmReplaceRecovered = true
                } else {
                    startRun()
                }
            } label: {
                Text("Empezar")
            }
            .buttonStyle(PrimaryButtonStyle())
            // With approximate location every GPS fix is discarded: the run would be lost
            .disabled(!canStart)
        case .running:
            HStack(spacing: 48) {
                RunRoundControl(systemImage: "pause.fill", title: "Pausar", style: .neutral) {
                    Haptics.tap()
                    tracker.pause()
                }
                HoldToFinishButton(onTap: { confirmFinish = true }, onFinish: { finish() })
            }
            .frame(maxWidth: .infinity)
        case .paused:
            HStack(spacing: 48) {
                RunRoundControl(systemImage: "play.fill", title: "Reanudar", style: .brand) {
                    Haptics.tap()
                    tracker.resume()
                }
                HoldToFinishButton(onTap: { confirmFinish = true }, onFinish: { finish() })
            }
            .frame(maxWidth: .infinity)
        }
    }

    private var canStart: Bool { !tracker.isLocationDenied && !tracker.hasReducedAccuracy }

    private var locationDeniedNotice: some View {
        RunNoticeCard(
            systemImage: "location.slash",
            title: "Ubicación desactivada",
            message: "Runna.io necesita tu ubicación para grabar la carrera."
        ) {
            Button("Abrir Ajustes") { openSettings() }
                .buttonStyle(SecondaryButtonStyle(tint: Color.brand))
        }
    }

    private var reducedAccuracyNotice: some View {
        RunNoticeCard(
            systemImage: "location.slash",
            title: "Ubicación aproximada",
            message: "Para grabar la ruta hace falta la ubicación exacta. Sin ella no se guarda ningún punto GPS."
        ) {
            HStack(spacing: DS.Spacing.s) {
                Button("Permitir exacta") {
                    tracker.requestFullAccuracy()
                }
                .buttonStyle(SecondaryButtonStyle(tint: Color.brand))
                Button("Ajustes") { openSettings() }
                    .buttonStyle(SecondaryButtonStyle(tint: Color.primary))
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

/// Big time on top; distance, current pace and average pace below, separated by hairlines.
private struct RunLiveMetrics: View {
    let seconds: Int
    let distance: Double
    let currentPace: Double?
    let lastSplit: RunSplits.Split?
    let isPaused: Bool
    let isAutoPaused: Bool

    var body: some View {
        VStack(spacing: DS.Spacing.l) {
            VStack(spacing: 2) {
                Text(Format.duration(seconds))
                    .font(Font.stat(80, weight: .semibold))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                    .foregroundStyle(isPaused ? Color.secondary : Color.primary)
                    .animation(.snappy, value: seconds)
                Text(isAutoPaused ? "Pausa automática" : "Tiempo")
                    .statLabelStyle()
            }
            HairlineDivider()
            HStack(spacing: 0) {
                metric(value: distanceValue, unit: distanceUnit, label: "Distancia")
                StatDivider(height: 40)
                metric(value: currentPaceValue, unit: "/km", label: "Ritmo")
                StatDivider(height: 40)
                metric(value: paceValue, unit: "/km", label: "Medio")
            }
            if let lastSplit {
                Text("Km \(lastSplit.km) en \(Format.duration(Int(lastSplit.seconds.rounded())))")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
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

    private var currentPaceValue: String {
        guard !isPaused, let currentPace else { return "--" }
        let total = Int(currentPace.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    private var paceValue: String {
        let text = Format.pace(distanceMeters: distance, seconds: seconds)
        return text.components(separatedBy: " ").first ?? text
    }

    private func metric(value: String, unit: String, label: String) -> some View {
        VStack(spacing: 4) {
            StatValue(value: value, unit: unit.isEmpty ? nil : unit, font: Font.stat(30, weight: .semibold))
            Text(label)
                .statLabelStyle()
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Status

/// "REC" while recording, "Pausa" while paused, "Listo" before starting. Small text label.
private struct RunStatusLabel: View {
    let phase: RunTracker.Phase

    var body: some View {
        HStack(spacing: 6) {
            indicator
            Text(title)
                .font(Font.statLabel)
                .textCase(.uppercase)
                .tracking(DS.Tracking.label)
                .foregroundStyle(phase == .running ? Color.primary : Color.secondary)
        }
        .lineLimit(1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder
    private var indicator: some View {
        switch phase {
        case .running:
            Circle()
                .fill(Color.brand)
                .frame(width: 7, height: 7)
        case .paused:
            Image(systemName: "pause.fill")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(.secondary)
        case .idle:
            Circle()
                .strokeBorder(Color.secondary, lineWidth: 1)
                .frame(width: 7, height: 7)
        }
    }

    private var title: String {
        switch phase {
        case .running: return "Rec"
        case .paused: return "Pausa"
        case .idle: return "Listo"
        }
    }

    private var accessibilityText: String {
        switch phase {
        case .running: return "Grabando carrera"
        case .paused: return "Carrera en pausa"
        case .idle: return "Listo para empezar"
        }
    }
}

// MARK: - Controls

/// Round solid control with a caption below.
private struct RunRoundControl: View {
    enum Style {
        /// Solid primary (near-black in light mode, white in dark mode).
        case neutral
        /// Solid brand.
        case brand
    }

    let systemImage: String
    let title: String
    let style: Style
    var size: CGFloat = 76
    let action: () -> Void

    private var fill: Color {
        switch style {
        case .neutral: return Color.primary
        case .brand: return Color.brand
        }
    }

    private var iconColor: Color {
        switch style {
        case .neutral: return Color(uiColor: .systemBackground)
        case .brand: return Color.onBrand
        }
    }

    var body: some View {
        Button(action: action) {
            VStack(spacing: DS.Spacing.s) {
                Image(systemName: systemImage)
                    .font(.system(size: size * 0.32, weight: .semibold))
                    .foregroundStyle(iconColor)
                    .frame(width: size, height: size)
                    .background(fill, in: Circle())
                Text(title)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
        .buttonStyle(PressableButtonStyle(scale: 0.95))
        .accessibilityLabel(title)
    }
}

/// Finish button: hold it to finish right away (a progress ring fills), a quick tap asks first.
private struct HoldToFinishButton: View {
    var size: CGFloat = 76
    let onTap: () -> Void
    let onFinish: () -> Void

    private let holdDuration: Double = 1.2
    @State private var progress: CGFloat = 0
    @State private var pressStart: Date?
    @State private var completions = 0

    var body: some View {
        VStack(spacing: DS.Spacing.s) {
            ZStack {
                Circle()
                    .fill(Color(uiColor: .tertiarySystemFill))
                Circle()
                    .trim(from: 0, to: progress)
                    .stroke(Color.primary, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .padding(1.5)
                Image(systemName: "stop.fill")
                    .font(.system(size: size * 0.28, weight: .semibold))
                    .foregroundStyle(Color.primary)
            }
            .frame(width: size, height: size)
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
                .font(.caption.weight(.medium))
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

/// Neutral inline notice for location problems inside the panel.
private struct RunNoticeCard<Actions: View>: View {
    let systemImage: String
    let title: String
    let message: String
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.steal)
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            actions
                .padding(.top, DS.Spacing.xs)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: DS.Spacing.m, radius: DS.Radius.tile)
    }
}

/// Treasure on the live map: small emoji on a material disc with a hairline.
private struct RunTreasurePin: View {
    let treasure: Treasure

    var body: some View {
        Text(treasure.emoji ?? "🎁")
            .font(.body)
            .frame(width: 34, height: 34)
            .background(.regularMaterial, in: Circle())
            .overlay(Circle().strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline))
    }
}

/// "Tesoro recogido" note at the top of the map.
private struct RunCollectedBanner: View {
    let treasure: Treasure

    var body: some View {
        HStack(spacing: DS.Spacing.s) {
            Image(systemName: "gift")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.brand)
            VStack(alignment: .leading, spacing: 1) {
                Text("Tesoro recogido")
                    .font(.subheadline.weight(.semibold))
                Text("\(treasure.powerName ?? treasure.name) · \(TreasureLine.rarityName(treasure.rarity))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, DS.Spacing.l)
        .padding(.vertical, DS.Spacing.s)
        .glassSurface(Capsule())
        .sensoryFeedback(.success, trigger: treasure.id)
        .accessibilityElement(children: .combine)
    }
}

/// Whose territory you're in, at the top of the map.
private struct RunZoneBanner: View {
    let text: String
    let isRival: Bool
    let color: Color

    var body: some View {
        HStack(spacing: DS.Spacing.s) {
            Image(systemName: isRival ? "flag.fill" : "checkmark.seal.fill")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(color)
            Text(text)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
        }
        .padding(.horizontal, DS.Spacing.l)
        .padding(.vertical, DS.Spacing.s)
        .glassSurface(Capsule())
        .accessibilityElement(children: .combine)
    }
}

/// Where the run started (the territory closes back here).
private struct RunStartPin: View {
    var body: some View {
        Image(systemName: "flag.checkered")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(Color.onBrand)
            .frame(width: 26, height: 26)
            .background(Color.brand, in: Circle())
            .overlay(Circle().strokeBorder(Color.white, lineWidth: 2))
    }
}

/// "Si terminas ahora: 0,12 km² · robas 3.400 m² a Ana" and the way back to the start.
private struct RunTerritoryStrip: View {
    let preview: RunPreview?
    let distanceToStart: Double?
    let bearingToStart: Double?
    /// Direction the runner is moving (degrees, negative when unknown).
    let heading: Double?

    var body: some View {
        HStack(alignment: .center, spacing: DS.Spacing.m) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .lineLimit(1)
                if let stealText {
                    Text(stealText)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Color.steal)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: DS.Spacing.s)
            if let distanceToStart, distanceToStart > 20 {
                HStack(spacing: 4) {
                    Image(systemName: "location.north.fill")
                        .font(.caption.weight(.bold))
                        .rotationEffect(.degrees(arrowAngle))
                        .foregroundStyle(Color.brand)
                    Text("Salida a \(Format.distance(distanceToStart))")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, DS.Spacing.m)
        .padding(.vertical, DS.Spacing.s)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        guard let preview else { return "Rodea una zona para conquistarla" }
        return "Si terminas ahora: \(Format.area(preview.area))"
    }

    private var stealText: String? {
        guard let preview, let first = preview.steals.first else { return nil }
        let total = preview.steals.reduce(0) { $0 + $1.area }
        if preview.steals.count == 1 {
            return "Robas ~\(Format.area(total)) a \(first.name)"
        }
        return "Robas ~\(Format.area(total)) a \(preview.steals.count) corredores"
    }

    /// Arrow relative to where you're heading when known, else relative to north.
    private var arrowAngle: Double {
        guard let bearingToStart else { return 0 }
        if let heading, heading >= 0 { return bearingToStart - heading }
        return bearingToStart
    }
}

/// GPS quality: four small bars and the accuracy in metres (same thresholds as the web app).
struct GPSSignalView: View {
    let accuracy: CLLocationAccuracy?

    private var level: (bars: Int, label: String) {
        guard let accuracy else { return (0, "Buscando GPS") }
        let meters = Int(accuracy.rounded())
        switch accuracy {
        case ...5: return (4, "GPS · \(meters) m")
        case ...10: return (3, "GPS · \(meters) m")
        case ...20: return (2, "GPS · \(meters) m")
        case ...30: return (1, "GPS débil · \(meters) m")
        default: return (0, "GPS débil · \(meters) m")
        }
    }

    private var isWeak: Bool {
        guard let accuracy else { return false }
        return accuracy > 20
    }

    var body: some View {
        let current = level
        HStack(spacing: 6) {
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(0..<4, id: \.self) { index in
                    RoundedRectangle(cornerRadius: 1, style: .continuous)
                        .fill(index < current.bars ? Color.primary : Color.secondary.opacity(0.3))
                        .frame(width: 3, height: CGFloat(5 + index * 3))
                }
            }
            .animation(.snappy, value: current.bars)
            Text(current.label)
                .font(Font.statLabel)
                .textCase(.uppercase)
                .tracking(DS.Tracking.label)
                .monospacedDigit()
                .foregroundStyle(isWeak ? Color.steal : Color.secondary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Señal GPS: \(current.label)")
    }
}
