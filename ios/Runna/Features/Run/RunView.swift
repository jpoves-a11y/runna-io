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

    var body: some View {
        ZStack(alignment: .bottom) {
            map
                .ignoresSafeArea()

            VStack {
                topBar
                Spacer()
            }

            controlPanel
        }
        .onAppear {
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
            Button("OK") { tracker.isPresented = false }
        } message: {
            Text("Hacen falta más puntos GPS para crear territorio. Corre un poco más la próxima vez.")
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
            UserAnnotation()
            if tracker.coordinates.count >= 2 {
                MapPolyline(coordinates: tracker.coordinates)
                    .stroke(Color(hex: session.user?.color ?? "#16A34A"), style: StrokeStyle(lineWidth: 6, lineCap: .round, lineJoin: .round))
            }
            ForEach(tracker.activeTreasures) { treasure in
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
            Spacer()
            GPSSignalView(accuracy: tracker.gpsAccuracy)
        }
        .padding(.horizontal)
        .padding(.top, 8)
    }

    // MARK: - Controls

    private var controlPanel: some View {
        VStack(spacing: 16) {
            if tracker.authorizationStatus == .denied || tracker.authorizationStatus == .restricted {
                locationDeniedNotice
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
                Haptics.tap()
                tracker.start()
            } label: {
                Label("Empezar", systemImage: "play.fill")
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(tracker.authorizationStatus == .denied || tracker.authorizationStatus == .restricted)
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

    private func finish() {
        guard let run = tracker.finish() else {
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
