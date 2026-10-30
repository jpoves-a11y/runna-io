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
    /// Run name, shown on the opening card of the video.
    var title: String = ""
    /// Opens "Compartir" (cards and video); nil hides the button.
    var shareRun: ShareRun? = nil
    /// Records a clean video straight away: opening card, the replay without controls, closing card.
    var autoRecord: Bool = false

    @Environment(\.dismiss) private var dismiss
    @State private var state = RouteReplayState()
    @State private var engine: RouteReplayEngine?
    /// Chosen speed (0,5×, 1× or 2×), kept between replays.
    @AppStorage("replay_speed") private var speed: Double = 1
    @State private var recorder = ReplayVideoRecorder()
    @State private var exportedVideo: SharedFile?
    @State private var exportError: String?
    @State private var showShare = false
    /// Opening / closing cards of the recorded video.
    @State private var card: VideoCard?

    enum VideoCard { case opening, closing }

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
                recordingOverlay
                    .allowsHitTesting(false)
            } else {
                controls
            }

            if let card {
                ReplayVideoCard(kind: card, title: title, distance: state.totalDistance, color: color)
                    .transition(.opacity)
                    .allowsHitTesting(false)
            }

            if state.phase == .loading || (autoRecord && state.phase == .ready && !state.isExporting) {
                loadingCover
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.4), value: state.phase)
        .animation(.easeInOut(duration: 0.5), value: card)
        .statusBarHidden(state.phase == .following || state.isExporting)
        .onAppear {
            state.speed = RouteReplayState.speeds.contains(speed) ? speed : 1
            if engine == nil {
                let engine = RouteReplayEngine(state: state, locations: locations, color: UIColor(color), territories: territories.map(\.polygon))
                engine.holdAtStart = autoRecord
                self.engine = engine
            }
        }
        .onDisappear {
            engine?.stop()
            recorder.cancel()
        }
        .onChange(of: state.phase) { _, phase in
            if phase == .ready && autoRecord { startRecording() }
            if phase == .finished && state.isExporting { finishRecording() }
        }
        .sheet(item: $exportedVideo, onDismiss: {
            if autoRecord { dismiss() }
        }) { video in
            ShareSheet(items: [video.url])
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showShare) {
            if let shareRun { ShareStudioView(run: shareRun) }
        }
        .alert("No se ha podido grabar el vídeo", isPresented: Binding(
            get: { exportError != nil },
            set: { if !$0 { exportError = nil } }
        )) {
            Button("Vale", role: .cancel) {
                if autoRecord { dismiss() }
            }
        } message: {
            Text(exportError ?? "")
        }
    }

    // MARK: Clean recording (3D video)

    /// The start is drawn: ask iOS to record, show the opening card, then play.
    private func startRecording() {
        guard recorder.isAvailable else {
            exportError = "La grabación de pantalla no está disponible ahora (por ejemplo, si ya estás grabando o duplicando la pantalla)."
            return
        }
        Task {
            do {
                try await recorder.start()
            } catch {
                exportError = "Hace falta permitir la grabación para crear el vídeo en 3D. También puedes elegir el estilo «Cinemático 2D», que no la necesita."
                return
            }
            state.isExporting = true
            card = .opening
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            card = nil
            try? await Task.sleep(nanoseconds: 400_000_000)
            engine?.begin()
        }
    }

    /// The territory is shown: the closing card, then the video is written and offered.
    private func finishRecording() {
        Task {
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            card = .closing
            try? await Task.sleep(nanoseconds: 2_200_000_000)
            do {
                let url = try await recorder.stop()
                state.isExporting = false
                card = nil
                exportedVideo = SharedFile(url: url)
            } catch {
                state.isExporting = false
                card = nil
                exportError = error.localizedDescription
            }
        }
    }

    /// While recording: the Runna.io mark and the distance, nothing else.
    private var recordingOverlay: some View {
        VStack {
            HStack {
                ShareWordmark(ink: .white, size: 16)
                    .shadow(color: Color.black.opacity(0.5), radius: 4, x: 0, y: 1)
                Spacer()
            }
            Spacer()
            if state.phase == .following || state.phase == .finishing {
                progressCard
            }
        }
        .padding(.horizontal, DS.Spacing.l)
        .padding(.top, DS.Spacing.xl)
        .padding(.bottom, DS.Spacing.m)
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
                if shareRun != nil {
                    GlassCircleButton(systemImage: "square.and.arrow.up", accessibilityLabel: "Compartir") {
                        showShare = true
                    }
                }
                Spacer()
                GlassCircleButton(systemImage: "xmark", accessibilityLabel: "Cerrar") {
                    engine?.stop()
                    dismiss()
                }
            }
            Spacer()
            if state.phase == .finished && !autoRecord {
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
                        if shareRun != nil {
                            Button {
                                showShare = true
                            } label: {
                                Label("Compartir", systemImage: "square.and.arrow.up")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(SecondaryButtonStyle(tint: .primary))
                        }
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
                Text(autoRecord ? "Preparando el vídeo…" : "Preparando la reproducción…")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// Opening and closing cards of the recorded 3D video (same look as the cinematic one).
private struct ReplayVideoCard: View {
    let kind: RouteReplayView.VideoCard
    let title: String
    let distance: Double
    let color: Color

    var body: some View {
        ZStack {
            LinearGradient(colors: [color.opacity(0.55), ShareStyle.night, ShareStyle.night], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            VStack(spacing: 18) {
                Spacer()
                if kind == .opening {
                    Text(title.isEmpty ? "Mi carrera" : title)
                        .font(.system(size: 34, weight: .bold))
                        .multilineTextAlignment(.center)
                    Text(Format.distance(distance))
                        .font(ShareStyle.number(56))
                        .foregroundStyle(color)
                } else {
                    Image("RunnaMark")
                        .resizable()
                        .scaledToFill()
                        .frame(width: 96, height: 96)
                        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                    Text("Runna.io")
                        .font(.system(size: 34, weight: .bold).width(.condensed))
                    Text("Conquista tu ciudad corriendo")
                        .font(.system(size: 16, weight: .medium))
                        .opacity(0.7)
                }
                Spacer()
                if kind == .opening {
                    ShareWordmark(ink: .white, size: 16)
                        .padding(.bottom, 40)
                }
            }
            .foregroundStyle(Color.white)
            .padding(.horizontal, 32)
        }
    }
}

/// What the SwiftUI controls show.
@MainActor
@Observable
final class RouteReplayState {
    /// `ready`: the start is drawn and the engine waits for `begin()` (clean recording).
    enum Phase { case loading, ready, following, finishing, finished }

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
    /// Wait in `ready` once the start is drawn instead of playing (clean recording).
    var holdAtStart = false

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
            if self.holdAtStart {
                self.state.phase = .ready
                return
            }
            self.state.phase = .following
            self.startDisplayLink()
        }
    }

    /// Starts playing after a `ready` hold.
    func begin() {
        guard state.phase == .ready else { return }
        state.phase = .following
        startDisplayLink()
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
        case .loading, .ready, .finished:
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
