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

    var body: some View {
        ZStack(alignment: .bottom) {
            map
                .ignoresSafeArea()

            VStack(spacing: 10) {
                topBar
                if let treasure = tracker.lastCollected {
                    collectedBanner(treasure)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                Spacer()
            }
            .animation(.spring(duration: 0.35), value: tracker.lastCollected?.id)

            controlPanel
        }
        .onAppear {
            tracker.refreshRecoverableRun()
            tracker.startPreview()
        }
        .onDisappear {
            tracker.stopPreview()
        }
        .confirmationDialog("¿Terminar la carrera?", isPresented: $confirmFinish, titleVisibility: .visible) {
            Button("Terminar y guardar") { finish() }
            Button("Seguir corriendo", role: .cancel) {}
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
                    .foregroundStyle(shape.color.opacity(0.2))
                    .stroke(shape.color.opacity(0.5), lineWidth: 1.5)
            }
            UserAnnotation()
            if tracker.coordinates.count >= 2 {
                MapPolyline(coordinates: tracker.coordinates)
                    .stroke(Color(hex: session.user?.color ?? "#16A34A"), style: StrokeStyle(lineWidth: 6, lineCap: .round, lineJoin: .round))
            }
            ForEach(tracker.visibleTreasures) { treasure in
                Annotation(treasure.name, coordinate: treasure.coordinate) {
                    Text(treasure.emoji ?? "🎁")
                        .font(.title)
                        .padding(6)
                        .background(.thinMaterial, in: Circle())
                }
            }
        }
        .mapControls {
            MapUserLocationButton()
            MapCompass()
        }
    }

    // MARK: - Top bar

    private var topBar: some View {
        HStack {
            if !tracker.isRecording || tracker.phase == .paused {
                Button {
                    if tracker.isRecording {
                        confirmCancel = true
                    } else {
                        tracker.isPresented = false
                    }
                } label: {
                    Image(systemName: "xmark")
                        .font(.headline)
                        .padding(12)
                        .background(.regularMaterial, in: Circle())
                }
                .accessibilityLabel(tracker.isRecording ? "Descartar carrera" : "Cerrar")
            }
            if tracker.isRecording {
                RecordingBadge(isPaused: tracker.phase == .paused)
            }
            Spacer()
            GPSSignalView(accuracy: tracker.gpsAccuracy)
        }
        .padding(.horizontal)
        .padding(.top, 8)
    }

    // MARK: - Controls

    private var controlPanel: some View {
        VStack(spacing: 16) {
            if tracker.isLocationDenied {
                locationDeniedNotice
            } else if tracker.hasReducedAccuracy {
                reducedAccuracyNotice
            }

            TimelineView(.periodic(from: .now, by: 1)) { context in
                let seconds = Int(tracker.elapsed(at: context.date))
                HStack {
                    StatTile(value: Format.distance(tracker.distance), label: "Distancia")
                    StatTile(value: Format.duration(seconds), label: "Tiempo")
                    StatTile(value: Format.pace(distanceMeters: tracker.distance, seconds: seconds), label: "Ritmo")
                }
            }

            if !tracker.collectedTreasures.isEmpty {
                Label("\(tracker.collectedTreasures.count) tesoro(s) recogido(s)", systemImage: "gift.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.orange)
            }

            buttons
        }
        .padding(20)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
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
                Label("Empezar", systemImage: "play.fill")
            }
            .buttonStyle(PrimaryButtonStyle())
            // With approximate location every GPS fix is discarded: the run would be lost
            .disabled(tracker.isLocationDenied || tracker.hasReducedAccuracy)
        case .running:
            Button {
                Haptics.tap()
                tracker.pause()
            } label: {
                Label("Pausar", systemImage: "pause.fill")
            }
            .buttonStyle(PrimaryButtonStyle(color: .orange))
        case .paused:
            HStack(spacing: 12) {
                Button {
                    Haptics.tap()
                    tracker.resume()
                } label: {
                    Label("Seguir", systemImage: "play.fill")
                }
                .buttonStyle(PrimaryButtonStyle())
                Button {
                    confirmFinish = true
                } label: {
                    Label("Terminar", systemImage: "flag.checkered")
                }
                .buttonStyle(PrimaryButtonStyle(color: .red))
            }
        }
    }

    private var locationDeniedNotice: some View {
        VStack(spacing: 8) {
            Text("Runna.io necesita tu ubicación para grabar la carrera.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
            Button("Abrir Ajustes") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .font(.subheadline.weight(.semibold))
        }
    }

    private var reducedAccuracyNotice: some View {
        VStack(spacing: 8) {
            Label("Ubicación aproximada", systemImage: "location.slash")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.orange)
            Text("Para grabar la ruta, Runna.io necesita tu ubicación exacta. Sin ella no se guarda ningún punto GPS.")
                .font(.footnote)
                .multilineTextAlignment(.center)
            HStack(spacing: 16) {
                Button("Permitir ubicación exacta") {
                    tracker.requestFullAccuracy()
                }
                Button("Abrir Ajustes") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
            }
            .font(.subheadline.weight(.semibold))
        }
    }

    private func collectedBanner(_ treasure: Treasure) -> some View {
        HStack(spacing: 10) {
            Text(treasure.emoji ?? "🎁")
                .font(.title2)
            VStack(alignment: .leading, spacing: 2) {
                Text("¡Cofre recogido!")
                    .font(.subheadline.weight(.bold))
                Text("\(treasure.powerName ?? treasure.name) · \(TreasureLine.rarityName(treasure.rarity))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().stroke(TreasureLine.rarityColor(treasure.rarity), lineWidth: 2))
        .accessibilityElement(children: .combine)
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

/// "REC" while recording, "PAUSA" while paused.
private struct RecordingBadge: View {
    let isPaused: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: isPaused ? "pause.circle.fill" : "record.circle")
                .symbolEffect(.pulse, isActive: !isPaused)
            Text(isPaused ? "PAUSA" : "REC")
                .font(.caption.weight(.heavy))
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(isPaused ? Color.orange : Color.red, in: Capsule())
        .accessibilityLabel(isPaused ? "Carrera en pausa" : "Grabando carrera")
    }
}

/// GPS quality bars (same thresholds as the web app).
struct GPSSignalView: View {
    let accuracy: CLLocationAccuracy?

    private var level: (bars: Int, color: Color, label: String) {
        guard let accuracy else { return (0, .gray, "Buscando GPS…") }
        let meters = Int(accuracy.rounded())
        switch accuracy {
        case ...5: return (4, .green, "\(meters) m · Excelente")
        case ...10: return (3, Color(hex: "#84CC16"), "\(meters) m · Buena")
        case ...20: return (2, .yellow, "\(meters) m · Aceptable")
        case ...30: return (1, .orange, "\(meters) m · Débil")
        default: return (0, .red, "\(meters) m · Mala")
        }
    }

    var body: some View {
        let current = level
        HStack(spacing: 6) {
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(0..<4) { index in
                    RoundedRectangle(cornerRadius: 1)
                        .fill(index < current.bars ? current.color : Color.secondary.opacity(0.3))
                        .frame(width: 4, height: CGFloat(5 + index * 3))
                }
            }
            Text(current.label)
                .font(.caption.weight(.semibold))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.regularMaterial, in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Señal GPS: \(current.label)")
    }
}
