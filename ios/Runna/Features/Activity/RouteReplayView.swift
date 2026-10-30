import SwiftUI
import MapKit
import QuartzCore
import ReplayKit
import UIKit

/// Full-screen replay of a run, like a car navigator: a tilted camera follows the runner forward at
/// constant speed with the runner always in the centre, the line is painted as it goes, then the camera
/// pulls back to the whole route and the territory it conquered fills in.
///
/// Built on MKMapView driven frame by frame (CADisplayLink): SwiftUI's Map only takes discrete camera
/// positions, which made the replay move in steps.
struct RouteReplayView: View {
    let locations: [CLLocationCoordinate2D]
    let color: Color
    let territories: [TerritoryShape]

    @Environment(\.dismiss) private var dismiss
    @State private var state = RouteReplayState()
    @State private var engine: RouteReplayEngine?
    /// Chosen speed (0,5×, 1× or 2×), kept between replays.
    @AppStorage("replay_speed") private var speed: Double = 1
    @State private var recorder = ReplayVideoRecorder()
    @State private var exportedVideo: ExportedVideo?
    @State private var exportError: String?

    var body: some View {
        ZStack {
            ZStack {
                if let engine {
                    RouteReplayMap(engine: engine)
                }
                // The camera is centred on the runner: the dot stays in the middle of the screen
                if state.phase == .following {
                    Circle()
                        .fill(color)
                        .frame(width: 20, height: 20)
                        .overlay(Circle().strokeBorder(Color.white, lineWidth: 3.5))
                        .shadow(color: Color.black.opacity(0.3), radius: 4, x: 0, y: 2)
                        .allowsHitTesting(false)
                }
            }
            .ignoresSafeArea()

            if state.isExporting {
                RunnaWatermark()
                    .allowsHitTesting(false)
            } else {
                controls
            }

            if state.isExporting, state.phase == .following || state.phase == .finishing {
                VStack {
                    Spacer()
                    progressCard
                }
                .padding(.horizontal, DS.Spacing.l)
                .padding(.vertical, DS.Spacing.m)
                .allowsHitTesting(false)
            }

            if state.phase == .loading {
                loadingCover
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.4), value: state.phase)
        .statusBarHidden(state.phase == .following || state.isExporting)
        .onAppear {
            state.speed = RouteReplayState.speeds.contains(speed) ? speed : 1
            if engine == nil {
                engine = RouteReplayEngine(state: state, locations: locations, color: UIColor(color), territories: territories.map(\.polygon))
            }
        }
        .onDisappear {
            engine?.stop()
            recorder.cancel()
        }
        .onChange(of: state.phase) { _, phase in
            if phase == .finished && state.isExporting { finishExport() }
        }
        .sheet(item: $exportedVideo) { video in
            ShareSheet(items: [video.url])
                .presentationDetents([.medium, .large])
        }
        .alert("No se ha podido exportar el vídeo", isPresented: Binding(
            get: { exportError != nil },
            set: { if !$0 { exportError = nil } }
        )) {
            Button("Vale", role: .cancel) {}
        } message: {
            Text(exportError ?? "")
        }
    }

    // MARK: Video export

    /// Records the replay from the start (screen recording of the app, without the controls and with
    /// the Runna.io watermark), then offers to share or save the video.
    private func startExport() {
        guard recorder.isAvailable else {
            exportError = "La grabación de pantalla no está disponible en este momento (por ejemplo, si ya estás grabando o duplicando la pantalla)."
            return
        }
        state.isExporting = true
        Task {
            do {
                try await recorder.start()
            } catch {
                state.isExporting = false
                exportError = "Hace falta permitir la grabación para crear el vídeo."
                return
            }
            engine?.restart(instant: true)
        }
    }

    private func finishExport() {
        Task {
            // Keep the conquered territory on screen for a moment at the end of the video
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            do {
                let url = try await recorder.stop()
                state.isExporting = false
                exportedVideo = ExportedVideo(url: url)
            } catch {
                state.isExporting = false
                exportError = error.localizedDescription
            }
        }
    }

    private var speedPicker: some View {
        HStack(spacing: 4) {
            ForEach(RouteReplayState.speeds, id: \.self) { value in
                Button {
                    speed = value
                    state.speed = value
                } label: {
                    Text(RouteReplayState.speedLabel(value))
                        .font(.footnote.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(state.speed == value ? Color.white : Color.primary)
                        .frame(minWidth: 40, minHeight: 30)
                        .background(state.speed == value ? color : Color.clear, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Velocidad \(RouteReplayState.speedLabel(value))")
                .accessibilityAddTraits(state.speed == value ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Color.primary.opacity(0.08), in: Capsule())
        .sensoryFeedback(.selection, trigger: state.speed)
    }

    private var controls: some View {
        VStack {
            HStack {
                Spacer()
                GlassCircleButton(systemImage: "xmark", accessibilityLabel: "Cerrar") {
                    engine?.stop()
                    dismiss()
                }
            }
            Spacer()
            if state.phase == .finished {
                VStack(spacing: DS.Spacing.m) {
                    HStack {
                        Text("Velocidad")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(.secondary)
                        Spacer()
                        speedPicker
                    }
                    HStack(spacing: DS.Spacing.m) {
                        Button {
                            engine?.restart()
                        } label: {
                            Label("Repetir", systemImage: "arrow.counterclockwise")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(SecondaryButtonStyle(tint: color))
                        Button {
                            startExport()
                        } label: {
                            Label("Vídeo", systemImage: "square.and.arrow.up")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(SecondaryButtonStyle(tint: .primary))
                    }
                }
                .padding(DS.Spacing.m)
                .glassSurface(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
                .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if state.phase == .following || state.phase == .finishing {
                progressCard
            }
        }
        .padding(.horizontal, DS.Spacing.l)
        .padding(.vertical, DS.Spacing.m)
    }

    private var progressCard: some View {
        let total = state.totalDistance
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(Format.distance(total * state.progress))
                    .font(Font.stat(20, weight: .semibold))
                    .monospacedDigit()
                Spacer()
                if state.isExporting {
                    Text(Format.distance(total))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                } else {
                    speedPicker
                }
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.12))
                    Capsule().fill(color)
                        .frame(width: max(6, proxy.size.width * state.progress))
                }
            }
            .frame(height: 6)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .glassSurface(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
    }

    private var loadingCover: some View {
        ZStack {
            Color(uiColor: .systemBackground)
                .ignoresSafeArea()
            VStack(spacing: DS.Spacing.m) {
                ProgressView()
                    .controlSize(.large)
                Text("Preparando la reproducción…")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// What the SwiftUI controls show.
@MainActor
@Observable
final class RouteReplayState {
    enum Phase { case loading, following, finishing, finished }

    var phase: Phase = .loading
    /// 0...1 of the run covered.
    var progress: Double = 0
    var totalDistance: Double = 0
    /// Playback speed: 1 is the default pace, 0.5 half, 2 double.
    var speed: Double = 1
    /// Recording the replay as a video: controls hidden, watermark shown.
    var isExporting = false

    static let speeds: [Double] = [0.5, 1, 2]

    static func speedLabel(_ value: Double) -> String {
        value == 0.5 ? "0,5×" : "\(Int(value))×"
    }
}

private struct RouteReplayMap: UIViewRepresentable {
    let engine: RouteReplayEngine

    func makeUIView(context: Context) -> MKMapView {
        let mapView = MKMapView(frame: .zero)
        engine.attach(mapView)
        return mapView
    }

    func updateUIView(_ mapView: MKMapView, context: Context) {}

    static func dismantleUIView(_ mapView: MKMapView, coordinator: ()) {
        mapView.delegate = nil
    }
}

/// Drives the MKMapView: loading, the follow camera (every frame), the painted line and the final pull back.
@MainActor
final class RouteReplayEngine: NSObject, MKMapViewDelegate {
    private let state: RouteReplayState
    /// The route resampled evenly by distance (constant speed).
    private let path: [CLLocationCoordinate2D]
    private let color: UIColor
    private let polygons: [MKPolygon]
    private let length: Double
    private let duration: Double

    private weak var mapView: MKMapView?
    private let ghost: MKPolyline
    private let casing: MKPolyline
    private let trail: MKPolyline
    private var trailRenderers: [MKPolylineRenderer] = []
    private var territoryRenderers: [MKPolygonRenderer] = []

    private var displayLink: CADisplayLink?
    private var lastTimestamp: CFTimeInterval = 0
    private var elapsed: Double = 0
    private var fadeElapsed: Double = 0
    private var heading: Double = 0
    private var isFullyRendered = false
    private var startTask: Task<Void, Never>?

    /// Follow camera.
    private let cameraDistance: Double = 480
    private let cameraPitch: Double = 60
    /// The camera looks towards the point this far ahead (metres), so turns start smoothly.
    private let lookAheadMeters: Double = 70

    init(state: RouteReplayState, locations: [CLLocationCoordinate2D], color: UIColor, territories: [MKPolygon]) {
        self.state = state
        self.color = color
        self.polygons = territories
        let path = MapGeometry.resampled(locations, count: 900)
        self.path = path
        let length = MapGeometry.length(locations)
        self.length = length
        // At 1× (the default): 3.5 s per km between 12 and 32 s, played 1.7 times faster
        self.duration = min(max(length / 1000 * 3.5, 12), 32) / 1.7
        ghost = MKPolyline(coordinates: path, count: path.count)
        casing = MKPolyline(coordinates: path, count: path.count)
        trail = MKPolyline(coordinates: path, count: path.count)
        super.init()
        state.totalDistance = length
    }

    func attach(_ mapView: MKMapView) {
        self.mapView = mapView
        mapView.delegate = self
        let configuration = MKStandardMapConfiguration(elevationStyle: .realistic, emphasisStyle: .muted)
        configuration.pointOfInterestFilter = .excludingAll
        mapView.preferredConfiguration = configuration
        mapView.showsCompass = false
        mapView.showsScale = false
        mapView.isRotateEnabled = false
        mapView.isPitchEnabled = false
        mapView.isZoomEnabled = false
        mapView.isScrollEnabled = false
        mapView.addOverlays(polygons, level: .aboveRoads)
        mapView.addOverlays([ghost, casing, trail], level: .aboveRoads)
        prepareStart()
    }

    /// Puts the camera behind the start (under the loading cover) and starts once the map has drawn it.
    private func prepareStart() {
        guard let mapView, path.count >= 2 else { return }
        elapsed = 0
        fadeElapsed = 0
        setTrail(0)
        setTerritoryAlpha(0)
        state.progress = 0
        heading = MapGeometry.bearing(from: path[0], to: point(at: lookAheadFraction))
        isFullyRendered = false
        mapView.camera = camera(at: path[0])

        startTask?.cancel()
        startTask = Task { [weak self] in
            // Wait for the tiles (at most 5 s), and show the cover at least a moment so it doesn't flash
            let started = Date()
            while let self, !self.isFullyRendered, Date().timeIntervalSince(started) < 5 {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            let shown = Date().timeIntervalSince(started)
            if shown < 0.6 { try? await Task.sleep(nanoseconds: UInt64((0.6 - shown) * 1_000_000_000)) }
            guard let self, !Task.isCancelled else { return }
            self.state.phase = .following
            self.startDisplayLink()
        }
    }

    /// Plays again from the start. `instant` jumps there (for the video) instead of swooping down.
    func restart(instant: Bool = false) {
        guard let mapView, path.count >= 2 else { return }
        stopDisplayLink()
        // Tiles are cached now: swoop down to the start instead of showing the cover again
        elapsed = 0
        fadeElapsed = 0
        setTrail(0)
        setTerritoryAlpha(0)
        state.progress = 0
        heading = MapGeometry.bearing(from: path[0], to: point(at: lookAheadFraction))
        state.phase = .finishing
        if instant {
            mapView.camera = camera(at: path[0])
            startTask?.cancel()
            startTask = Task { [weak self] in
                // A moment for the start to draw before the video begins moving
                try? await Task.sleep(nanoseconds: 700_000_000)
                guard let self, !Task.isCancelled else { return }
                self.state.phase = .following
                self.startDisplayLink()
            }
            return
        }
        UIView.animate(withDuration: 1.4 / speed, delay: 0, options: [.curveEaseInOut]) {
            mapView.camera = self.camera(at: self.path[0])
        } completion: { _ in
            self.state.phase = .following
            self.startDisplayLink()
        }
    }

    func stop() {
        startTask?.cancel()
        stopDisplayLink()
    }

    // MARK: Frames

    private func startDisplayLink() {
        stopDisplayLink()
        lastTimestamp = 0
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    private func stopDisplayLink() {
        displayLink?.invalidate()
        displayLink = nil
    }

    @objc private func tick(_ link: CADisplayLink) {
        let dt = lastTimestamp == 0 ? 0 : min(link.timestamp - lastTimestamp, 0.1)
        lastTimestamp = link.timestamp
        switch state.phase {
        case .following:
            follow(dt)
        case .finishing:
            fadeTerritory(dt)
        case .loading, .finished:
            break
        }
    }

    private var speed: Double { max(0.25, state.speed) }

    private func follow(_ dt: Double) {
        guard let mapView else { return }
        elapsed += dt * speed
        let progress = min(elapsed / duration, 1)
        let position = point(at: progress)
        let ahead = point(at: min(progress + lookAheadFraction, 1))
        if MKMapPoint(position).distance(to: MKMapPoint(ahead)) > 5 {
            // Turn towards where the run goes next, smoothly (shortest way round)
            let target = MapGeometry.bearing(from: position, to: ahead)
            let delta = (target - heading + 540).truncatingRemainder(dividingBy: 360) - 180
            heading = (heading + delta * (1 - exp(-dt * 2.2)) + 360).truncatingRemainder(dividingBy: 360)
        }
        mapView.camera = camera(at: position)
        setTrail(progress)
        if abs(progress - state.progress) > 0.002 || progress >= 1 {
            state.progress = progress
        }
        if progress >= 1 { finish() }
    }

    /// Pulls back to the whole route (north up, flat), then fades the territory in.
    private func finish() {
        guard let mapView else { return }
        state.phase = .finishing
        fadeElapsed = -1.9 // the fade starts once the camera has pulled back (time scaled by the speed)
        let rect = ghost.boundingMapRect
        let padding = UIEdgeInsets(top: 90, left: 40, bottom: 170, right: 40)
        let fitted = mapView.mapRectThatFits(rect, edgePadding: padding)
        let center = MKMapPoint(x: fitted.midX, y: fitted.midY).coordinate
        let meters = max(fitted.width, fitted.height) / MKMapPointsPerMeterAtLatitude(center.latitude)
        UIView.animate(withDuration: 1.8 / speed, delay: 0, options: [.curveEaseInOut]) {
            mapView.camera = MKMapCamera(lookingAtCenter: center, fromDistance: meters * 1.15, pitch: 0, heading: 0)
        } completion: { _ in
            mapView.setVisibleMapRect(rect, edgePadding: padding, animated: true)
        }
    }

    private func fadeTerritory(_ dt: Double) {
        guard displayLink != nil else { return }
        fadeElapsed += dt * speed
        let alpha = min(max(fadeElapsed / 0.8, 0), 1)
        setTerritoryAlpha(alpha)
        if alpha >= 1 {
            stopDisplayLink()
            state.phase = .finished
            if !polygons.isEmpty {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            }
        }
    }

    // MARK: Helpers

    private var lookAheadFraction: Double {
        length > 0 ? min(lookAheadMeters / length, 0.2) : 0
    }

    private func camera(at center: CLLocationCoordinate2D) -> MKMapCamera {
        MKMapCamera(lookingAtCenter: center, fromDistance: cameraDistance, pitch: cameraPitch, heading: heading)
    }

    /// The point `fraction` of the way along the route (between resampled points).
    private func point(at fraction: Double) -> CLLocationCoordinate2D {
        guard path.count >= 2 else { return path.first ?? CLLocationCoordinate2D() }
        let position = min(max(fraction, 0), 1) * Double(path.count - 1)
        let index = min(Int(position), path.count - 2)
        let t = position - Double(index)
        let a = path[index]
        let b = path[index + 1]
        return CLLocationCoordinate2D(
            latitude: a.latitude + (b.latitude - a.latitude) * t,
            longitude: a.longitude + (b.longitude - a.longitude) * t
        )
    }

    private func setTrail(_ progress: Double) {
        for renderer in trailRenderers {
            renderer.strokeEnd = CGFloat(progress)
            renderer.setNeedsDisplay()
        }
    }

    private func setTerritoryAlpha(_ alpha: Double) {
        for renderer in territoryRenderers {
            renderer.alpha = CGFloat(alpha)
            renderer.setNeedsDisplay()
        }
    }

    // MARK: MKMapViewDelegate

    func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
        if let polyline = overlay as? MKPolyline {
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.lineCap = .round
            renderer.lineJoin = .round
            if polyline === ghost {
                renderer.strokeColor = color.withAlphaComponent(0.28)
                renderer.lineWidth = 5
            } else {
                renderer.strokeColor = polyline === casing ? UIColor.white.withAlphaComponent(0.9) : color
                renderer.lineWidth = polyline === casing ? 9 : 5.5
                renderer.strokeEnd = CGFloat(state.phase == .finished ? 1 : state.progress)
                trailRenderers.append(renderer)
            }
            return renderer
        }
        if let polygon = overlay as? MKPolygon {
            let renderer = MKPolygonRenderer(polygon: polygon)
            renderer.fillColor = color.withAlphaComponent(0.3)
            renderer.strokeColor = color
            renderer.lineWidth = 2
            // Round joins: sharp corners don't turn into long spikes when zoomed out
            renderer.lineJoin = .round
            renderer.alpha = state.phase == .finished ? 1 : 0
            territoryRenderers.append(renderer)
            return renderer
        }
        return MKOverlayRenderer(overlay: overlay)
    }

    func mapViewDidFinishRenderingMap(_ mapView: MKMapView, fullyRendered: Bool) {
        if fullyRendered { isFullyRendered = true }
    }
}

// MARK: - Video export

/// The Runna.io mark on exported replays.
private struct RunnaWatermark: View {
    var body: some View {
        VStack {
            HStack {
                HStack(spacing: 6) {
                    Image(systemName: "figure.run")
                        .font(.system(size: 15, weight: .bold))
                    Text("Runna.io")
                        .font(.system(size: 17, weight: .bold))
                }
                .foregroundStyle(Color.white)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(Color.black.opacity(0.45), in: Capsule())
                .shadow(color: Color.black.opacity(0.25), radius: 4, x: 0, y: 2)
                Spacer()
            }
            Spacer()
        }
        .padding(.horizontal, DS.Spacing.l)
        .padding(.top, DS.Spacing.xl)
    }
}

/// Screen recording of the app (ReplayKit) saved to a video file.
@MainActor
final class ReplayVideoRecorder {
    private let recorder = RPScreenRecorder.shared()

    var isAvailable: Bool { recorder.isAvailable && !recorder.isRecording }

    func start() async throws {
        recorder.isMicrophoneEnabled = false
        recorder.isCameraEnabled = false
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            recorder.startRecording { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    /// Stops and writes the video; returns its file.
    func stop() async throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("Runna-\(Int(Date().timeIntervalSince1970)).mp4")
        try? FileManager.default.removeItem(at: url)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            recorder.stopRecording(withOutput: url) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
        return url
    }

    /// Closing the replay while recording throws the recording away.
    func cancel() {
        guard recorder.isRecording else { return }
        recorder.stopRecording { _, _ in }
    }
}

private struct ExportedVideo: Identifiable {
    let url: URL
    var id: URL { url }
}

/// iOS share sheet (Guardar vídeo, Instagram, WhatsApp…).
private struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
