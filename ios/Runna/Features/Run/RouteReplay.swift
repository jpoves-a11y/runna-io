import SwiftUI
import MapKit
import UIKit

// MARK: - Geometry of the replay

/// The route prepared for the replay: resampled evenly and smoothed (GPS zigzags out, corners
/// rounded a little), with the distance along it, where the runner is after any distance and
/// which way the route goes there.
struct RouteReplayPlan {
    let points: [CLLocationCoordinate2D]
    /// metres from the start to each point
    let cumulative: [Double]
    let length: Double
    let center: CLLocationCoordinate2D
    /// largest side of the route's bounding box, in metres
    let extent: Double

    /// At most this many points (CPU of the per-frame work).
    private static let maxPoints = 900

    init?(coordinates: [CLLocationCoordinate2D]) {
        let valid = coordinates.filter { CLLocationCoordinate2DIsValid($0) && !($0.latitude == 0 && $0.longitude == 0) }
        guard valid.count >= 2 else { return nil }

        // Length of the raw track
        var rawCumulative: [Double] = [0]
        for index in 1..<valid.count {
            rawCumulative.append(rawCumulative[index - 1] + Self.meters(valid[index - 1], valid[index]))
        }
        guard let rawLength = rawCumulative.last, rawLength > 1 else { return nil }

        // 1. Resample every `spacing` metres along the track
        let spacing = max(4, rawLength / Double(Self.maxPoints - 1))
        var resampled: [CLLocationCoordinate2D] = []
        var segment = 0
        var target = 0.0
        while target < rawLength {
            while segment < valid.count - 2 && rawCumulative[segment + 1] < target { segment += 1 }
            let a = valid[segment]
            let b = valid[segment + 1]
            let span = rawCumulative[segment + 1] - rawCumulative[segment]
            let f = span > 0 ? (target - rawCumulative[segment]) / span : 0
            resampled.append(CLLocationCoordinate2D(latitude: a.latitude + (b.latitude - a.latitude) * f, longitude: a.longitude + (b.longitude - a.longitude) * f))
            target += spacing
        }
        resampled.append(valid[valid.count - 1])

        // 2. Moving average over ~25 m (ends kept where they are)
        let half = max(1, Int((12 / spacing).rounded()))
        var smoothed = resampled
        if resampled.count > 2 * half + 1 {
            for index in 1..<(resampled.count - 1) {
                let from = max(0, index - half)
                let to = min(resampled.count - 1, index + half)
                var lat = 0.0
                var lng = 0.0
                for k in from...to {
                    lat += resampled[k].latitude
                    lng += resampled[k].longitude
                }
                let count = Double(to - from + 1)
                smoothed[index] = CLLocationCoordinate2D(latitude: lat / count, longitude: lng / count)
            }
        }

        var distances: [Double] = [0]
        for index in 1..<smoothed.count {
            distances.append(distances[index - 1] + Self.meters(smoothed[index - 1], smoothed[index]))
        }
        guard let total = distances.last, total > 1 else { return nil }

        let lats = smoothed.map(\.latitude)
        let lngs = smoothed.map(\.longitude)
        let minLat = lats.min() ?? 0
        let maxLat = lats.max() ?? 0
        let minLng = lngs.min() ?? 0
        let maxLng = lngs.max() ?? 0
        let middleLat = (minLat + maxLat) / 2
        let height = (maxLat - minLat) * 111_320
        let width = (maxLng - minLng) * 111_320 * cos(middleLat * .pi / 180)

        points = smoothed
        cumulative = distances
        length = total
        center = CLLocationCoordinate2D(latitude: middleLat, longitude: (minLng + maxLng) / 2)
        extent = max(height, width, 200)
    }

    static func meters(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        CLLocation(latitude: a.latitude, longitude: a.longitude).distance(from: CLLocation(latitude: b.latitude, longitude: b.longitude))
    }

    /// Index of the segment that contains `distance`.
    private func segment(at distance: Double) -> Int {
        var low = 0
        var high = cumulative.count - 1
        while high - low > 1 {
            let middle = (low + high) / 2
            if cumulative[middle] <= distance { low = middle } else { high = middle }
        }
        return low
    }

    /// Where the runner is after `distance` metres.
    func coordinate(at distance: Double) -> CLLocationCoordinate2D {
        let d = min(max(0, distance), length)
        let index = segment(at: d)
        let a = points[index]
        let b = points[min(index + 1, points.count - 1)]
        let span = cumulative[min(index + 1, cumulative.count - 1)] - cumulative[index]
        let f = span > 0 ? (d - cumulative[index]) / span : 0
        return CLLocationCoordinate2D(latitude: a.latitude + (b.latitude - a.latitude) * f, longitude: a.longitude + (b.longitude - a.longitude) * f)
    }

    /// Direction of the route around `distance` (degrees from north), looking `window` metres behind
    /// and ahead so the camera turns with the street, not with every small bend.
    func bearing(at distance: Double, window: Double = 350) -> Double {
        let from = coordinate(at: distance - window * 0.4)
        let to = coordinate(at: distance + window)
        let lat1 = from.latitude * .pi / 180
        let lat2 = to.latitude * .pi / 180
        let dLng = (to.longitude - from.longitude) * .pi / 180
        let y = sin(dLng) * cos(lat2)
        let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLng)
        let degrees = atan2(y, x) * 180 / .pi
        return degrees < 0 ? degrees + 360 : degrees
    }
}

/// 2D (north up, seen from above) or 3D (tilted camera that turns with the route).
enum RouteReplayMode: String {
    case flat
    case threeD
}

/// Where the camera is.
struct ReplayCamera {
    var center: CLLocationCoordinate2D
    /// metres from the centre
    var distance: Double
    var pitch: Double
    /// degrees, not wrapped (so turns interpolate the short way)
    var heading: Double

    var mkCamera: MKMapCamera {
        MKMapCamera(lookingAtCenter: center, fromDistance: distance, pitch: CGFloat(pitch), heading: heading)
    }

    /// From `a` to `b`: position eased, distance in log scale (a natural zoom), pitch later in the move.
    static func interpolate(_ a: ReplayCamera, _ b: ReplayCamera, _ t: Double) -> ReplayCamera {
        let u = min(1, max(0, t))
        // Smootherstep: no jerk at either end
        let eased = u * u * u * (u * (u * 6 - 15) + 10)
        let pitchT = min(1, max(0, (u - 0.35) / 0.65))
        let pitchEased = pitchT * pitchT * (3 - 2 * pitchT)
        return ReplayCamera(
            center: CLLocationCoordinate2D(
                latitude: a.center.latitude + (b.center.latitude - a.center.latitude) * eased,
                longitude: a.center.longitude + (b.center.longitude - a.center.longitude) * eased
            ),
            distance: exp(log(max(1, a.distance)) + (log(max(1, b.distance)) - log(max(1, a.distance))) * eased),
            pitch: a.pitch + (b.pitch - a.pitch) * pitchEased,
            heading: a.heading + ReplayCamera.shortestTurn(from: a.heading, to: b.heading) * eased
        )
    }

    /// Signed degrees to turn from `from` to `to` the short way (-180...180).
    static func shortestTurn(from: Double, to: Double) -> Double {
        var delta = (to - from).truncatingRemainder(dividingBy: 360)
        if delta > 180 { delta -= 360 }
        if delta < -180 { delta += 360 }
        return delta
    }
}

/// Timing and cameras of one replay: overview → fly in to the start → follow the runner → reveal the whole route → slow turn.
struct RouteReplayTimeline {
    let plan: RouteReplayPlan
    let mode: RouteReplayMode
    /// Multiplies how long the runner takes (0.6 fast, 1 normal, 1.5 slow).
    var speed: Double = 1

    /// Seconds: the far view holds, then flies in to the start.
    let introHold: Double = 0.8
    let flyIn: Double = 4.2
    /// At the start before running.
    let startHold: Double = 0.8
    let finish: Double = 3.4
    /// 3D only: slow turn around the whole route after the finish.
    let orbit: Double = 14

    /// Longer routes play longer: 14 s for a short run, up to 32 s.
    var run: Double { min(32, max(14, 10 + plan.length / 1000 * 1.6)) * min(2, max(0.4, speed)) }

    var runStart: Double { introHold + flyIn + startHold }
    var runEnd: Double { runStart + run }
    var total: Double { runEnd + finish }

    /// Metres run after `time` seconds of the run phase: gentle start and stop, steady in between.
    func distance(atRunTime time: Double) -> Double {
        let u = min(1, max(0, time / run))
        let ramp = 0.16
        let top = 1 / (1 - ramp)
        let eased: Double
        if u < ramp {
            eased = 0.5 * top / ramp * u * u
        } else if u > 1 - ramp {
            eased = 1 - 0.5 * top / ramp * (1 - u) * (1 - u)
        } else {
            eased = top * (u - ramp / 2)
        }
        return plan.length * min(1, max(0, eased))
    }

    /// Metres run at `elapsed` seconds since the replay started.
    func distance(atElapsed elapsed: Double) -> Double {
        if elapsed <= runStart { return 0 }
        if elapsed >= runEnd { return plan.length }
        return distance(atRunTime: elapsed - runStart)
    }

    /// Camera following the runner: a bit far back so the surroundings show.
    func followCamera(at distance: Double, heading: Double) -> ReplayCamera {
        switch mode {
        case .threeD:
            return ReplayCamera(center: plan.coordinate(at: distance), distance: min(3200, max(1200, plan.length * 0.18)), pitch: 50, heading: heading)
        case .flat:
            return ReplayCamera(center: plan.coordinate(at: distance), distance: min(7000, max(2200, plan.length * 0.5)), pitch: 0, heading: 0)
        }
    }

    /// Far away, centred on the route: where the replay starts.
    var overviewCamera: ReplayCamera {
        ReplayCamera(center: plan.center, distance: max(revealDistance * 6, 15_000), pitch: 0, heading: 0)
    }

    /// The whole route in view.
    private var revealDistance: Double { max(1400, plan.extent * (mode == .threeD ? 3.3 : 2.8)) }

    func revealCamera(heading: Double) -> ReplayCamera {
        switch mode {
        case .threeD:
            return ReplayCamera(center: plan.center, distance: revealDistance, pitch: 42, heading: heading)
        case .flat:
            return ReplayCamera(center: plan.center, distance: revealDistance, pitch: 0, heading: 0)
        }
    }
}

/// How a replay looks when someone else controls it (the share editor): no chips on the map.
struct RouteReplayConfig: Equatable {
    var mode: RouteReplayMode = .threeD
    var satellite = true
    /// See RouteReplayTimeline.speed.
    var speed: Double = 1
}

/// Progress of the replay, published for the SwiftUI overlays (counters, chips, video titles).
@Observable
final class RouteReplayProgress {
    /// 0...1 of the route run so far
    var fraction: Double = 0
    var isFinished = false
}

// MARK: - View

/// Replays a run on the map: starts far away, flies in to the start, follows the runner (in 3D the
/// camera turns with the route) and ends showing the whole route and the area it encloses.
/// 2D / 3D and map / satellite can be switched, and it can be opened full screen.
struct RouteReplayView: View {
    let coordinates: [CLLocationCoordinate2D]
    let color: Color
    /// Reported distance and moving time of the run, for the counters (else measured on the route).
    var distance: Double?
    var duration: Int?
    /// nil fills the available space (full screen).
    var height: CGFloat?
    var allowsFullScreen: Bool
    /// Set by the share editor: fixed look, no chips.
    var config: RouteReplayConfig?
    /// Titles and figures drawn over the map in the shared video.
    var share: RouteShareOptions?
    /// Changing it plays the replay again from the start.
    var restartToken: Int
    /// Called when the runner reaches the finish and the whole route is shown.
    var onFinished: (() -> Void)?

    @AppStorage("routeReplayMode") private var modeRaw = RouteReplayMode.threeD.rawValue
    @AppStorage("routeReplaySatellite") private var satellite = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var playToken = 0
    @State private var showsFullScreen = false
    @State private var progress = RouteReplayProgress()
    /// Computed once per route.
    @State private var plan: RouteReplayPlan?

    init(
        coordinates: [CLLocationCoordinate2D],
        color: Color,
        distance: Double? = nil,
        duration: Int? = nil,
        height: CGFloat? = 240,
        allowsFullScreen: Bool = true,
        config: RouteReplayConfig? = nil,
        share: RouteShareOptions? = nil,
        restartToken: Int = 0,
        onFinished: (() -> Void)? = nil
    ) {
        self.coordinates = coordinates
        self.color = color
        self.distance = distance
        self.duration = duration
        self.height = height
        self.allowsFullScreen = allowsFullScreen
        self.config = config
        self.share = share
        self.restartToken = restartToken
        self.onFinished = onFinished
        _plan = State(initialValue: RouteReplayPlan(coordinates: coordinates))
    }

    private var mode: RouteReplayMode { config?.mode ?? RouteReplayMode(rawValue: modeRaw) ?? .threeD }
    private var isSatellite: Bool { config?.satellite ?? satellite }
    private var speed: Double { config?.speed ?? 1 }
    /// Rounded card with a border, except when the share editor frames it.
    private var isCard: Bool { height != nil && config == nil }

    var body: some View {
        ZStack {
            RouteReplayMapView(
                plan: plan,
                color: UIColor(color),
                colorKey: String(describing: color),
                mode: mode,
                satellite: isSatellite,
                speed: speed,
                playToken: playToken,
                reduceMotion: reduceMotion,
                progress: progress,
                onFinished: onFinished
            )
            .accessibilityLabel("Animación del recorrido")
            if let share {
                RouteShareOverlay(
                    options: share,
                    fraction: progress.fraction,
                    isFinished: progress.isFinished,
                    distance: distance ?? plan?.length ?? 0,
                    duration: duration
                )
            } else if config == nil {
                chrome
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .frame(maxHeight: height == nil ? .infinity : nil)
        .clipShape(RoundedRectangle(cornerRadius: isCard ? DS.Radius.card : 0, style: .continuous))
        .overlay {
            if isCard {
                RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous).strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline)
            }
        }
        .animation(.snappy, value: progress.isFinished)
        .onChange(of: coordinates.count) {
            // A different route in the same place on screen
            plan = RouteReplayPlan(coordinates: coordinates)
            playToken += 1
        }
        .onChange(of: restartToken) { playToken += 1 }
        .fullScreenCover(isPresented: $showsFullScreen) {
            RouteReplayFullScreen(coordinates: coordinates, color: color, distance: distance, duration: duration)
        }
    }

    // MARK: Chips, counters

    private var chrome: some View {
        let fraction = progress.fraction
        let finished = progress.isFinished
        return VStack {
            HStack(alignment: .top) {
                if fraction > 0 || finished {
                    ReplayCounter(
                        meters: (distance ?? plan?.length ?? 0) * (finished ? 1 : fraction),
                        seconds: duration.map { Double($0) * (finished ? 1 : fraction) }
                    )
                    .transition(.opacity)
                }
                Spacer(minLength: 0)
                if allowsFullScreen {
                    ReplayIconButton(systemImage: "arrow.up.left.and.arrow.down.right", label: "Pantalla completa") {
                        showsFullScreen = true
                    }
                }
            }
            Spacer(minLength: 0)
            HStack(spacing: DS.Spacing.s) {
                ReplaySegmented(
                    options: ["2D", "3D"],
                    selected: mode == .threeD ? 1 : 0,
                    label: "Vista"
                ) { index in
                    modeRaw = (index == 1 ? RouteReplayMode.threeD : .flat).rawValue
                }
                ReplaySegmented(
                    options: ["Mapa", "Satélite"],
                    selected: satellite ? 1 : 0,
                    label: "Tipo de mapa"
                ) { index in
                    satellite = index == 1
                }
                Spacer(minLength: 0)
                if finished {
                    ReplayIconButton(systemImage: "arrow.counterclockwise", label: "Repetir") {
                        playToken += 1
                    }
                    .transition(.opacity)
                }
            }
        }
        .padding(DS.Spacing.m)
        .padding(.top, height == nil ? DS.Spacing.xxxl + DS.Spacing.l : 0)
    }
}

// MARK: - Map (UIKit)

/// The map of the replay, driven frame by frame by one clock (CADisplayLink). The route, the area,
/// the start, the finish and the runner are drawn by us in a layer over the map (each point
/// projected with the current camera), not as MapKit overlays: MapKit redraws overlays tile by tile
/// and late while the camera moves, so a line updated every frame kept vanishing for moments.
private struct RouteReplayMapView: UIViewRepresentable {
    let plan: RouteReplayPlan?
    let color: UIColor
    /// Identifies the colour (UIColors made from SwiftUI colours aren't comparable)
    let colorKey: String
    let mode: RouteReplayMode
    let satellite: Bool
    let speed: Double
    let playToken: Int
    let reduceMotion: Bool
    let progress: RouteReplayProgress
    let onFinished: (() -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> MKMapView {
        let mapView = MKMapView(frame: .zero)
        mapView.delegate = context.coordinator
        mapView.showsCompass = false
        mapView.showsScale = false
        mapView.showsUserLocation = false
        mapView.isScrollEnabled = false
        mapView.isZoomEnabled = false
        mapView.isRotateEnabled = false
        mapView.isPitchEnabled = false
        context.coordinator.attach(to: mapView)
        update(context.coordinator, mapView: mapView, force: true)
        return mapView
    }

    func updateUIView(_ mapView: MKMapView, context: Context) {
        update(context.coordinator, mapView: mapView, force: false)
    }

    static func dismantleUIView(_ mapView: MKMapView, coordinator: Coordinator) {
        coordinator.stop()
    }

    private func update(_ coordinator: Coordinator, mapView: MKMapView, force: Bool) {
        coordinator.progress = progress
        coordinator.onFinished = onFinished
        coordinator.reduceMotion = reduceMotion
        coordinator.setStyle(satellite: satellite, mode: mode, on: mapView, force: force)
        let restart = force || coordinator.playToken != playToken || coordinator.mode != mode || coordinator.speed != speed || coordinator.colorKey != colorKey
        if restart, let plan {
            coordinator.playToken = playToken
            coordinator.colorKey = colorKey
            coordinator.play(plan: plan, mode: mode, speed: speed, color: color, on: mapView)
        }
    }

    @MainActor
    final class Coordinator: NSObject, MKMapViewDelegate {
        var progress: RouteReplayProgress?
        var onFinished: (() -> Void)?
        var reduceMotion = false
        var playToken = -1
        var colorKey = ""
        private(set) var mode: RouteReplayMode = .threeD
        private(set) var speed: Double = 1
        private var styleKey: String?

        private weak var mapView: MKMapView?
        private let drawing = ReplayDrawingView(frame: .zero)
        private var timeline: RouteReplayTimeline?
        /// Points drawn (at most ~400) and their distance along the route
        private var drawPoints: [CLLocationCoordinate2D] = []
        private var drawCumulative: [Double] = []
        private var displayLink: CADisplayLink?
        private var startTime: CFTimeInterval = 0
        private var lastTick: CFTimeInterval = 0
        /// Camera state smoothed frame by frame
        private var heading: Double = 0
        private var finishHeading: Double = 0
        private var smoothedCenter = CLLocationCoordinate2D(latitude: 0, longitude: 0)
        private var lastFollowCamera: ReplayCamera?
        /// What is drawn right now
        private var runDistance: Double = 0
        private var areaAlpha: CGFloat = 0
        private var reportedFinish = false
        private var lastPublished: CFTimeInterval = 0
        private var userTookOver = false

        func attach(to mapView: MKMapView) {
            self.mapView = mapView
            drawing.frame = mapView.bounds
            drawing.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            mapView.addSubview(drawing)
            // Any touch after the finish stops the slow turn and leaves the map to the user
            let pan = UIPanGestureRecognizer(target: self, action: #selector(userGesture(_:)))
            pan.delegate = self
            pan.cancelsTouchesInView = false
            mapView.addGestureRecognizer(pan)
            let pinch = UIPinchGestureRecognizer(target: self, action: #selector(userGesture(_:)))
            pinch.delegate = self
            pinch.cancelsTouchesInView = false
            mapView.addGestureRecognizer(pinch)
        }

        func setStyle(satellite: Bool, mode: RouteReplayMode, on mapView: MKMapView, force: Bool) {
            let key = "\(satellite)-\(mode.rawValue)"
            guard force || key != styleKey else { return }
            styleKey = key
            let elevation: MKMapConfiguration.ElevationStyle = mode == .threeD ? .realistic : .flat
            if satellite {
                let configuration = MKHybridMapConfiguration(elevationStyle: elevation)
                configuration.pointOfInterestFilter = .excludingAll
                mapView.preferredConfiguration = configuration
            } else {
                let configuration = MKStandardMapConfiguration(elevationStyle: elevation, emphasisStyle: .muted)
                configuration.pointOfInterestFilter = .excludingAll
                mapView.preferredConfiguration = configuration
            }
        }

        // MARK: Playback

        func play(plan: RouteReplayPlan, mode: RouteReplayMode, speed: Double, color: UIColor, on mapView: MKMapView) {
            stop()
            self.mode = mode
            self.speed = speed
            let timeline = RouteReplayTimeline(plan: plan, mode: mode, speed: speed)
            self.timeline = timeline
            reportedFinish = false
            userTookOver = false
            runDistance = 0
            areaAlpha = 0
            lastFollowCamera = nil
            setInteractive(false)
            drawing.setColor(color)
            mapView.bringSubviewToFront(drawing)

            // Points to draw: every route point up to ~400
            let step = max(1, plan.points.count / 400)
            var points: [CLLocationCoordinate2D] = []
            var cumulative: [Double] = []
            var index = 0
            while index < plan.points.count {
                points.append(plan.points[index])
                cumulative.append(plan.cumulative[index])
                index += step
            }
            if let last = plan.points.last, cumulative.last != plan.length {
                points.append(last)
                cumulative.append(plan.length)
            }
            drawPoints = points
            drawCumulative = cumulative

            heading = plan.bearing(at: 0)
            finishHeading = heading
            smoothedCenter = plan.coordinate(at: 0)
            publish(fraction: 0, finished: false, force: true)

            if reduceMotion {
                // No flying around: the whole route, drawn at once
                mapView.camera = timeline.revealCamera(heading: 0).mkCamera
                runDistance = plan.length
                areaAlpha = 1
                redraw()
                setInteractive(true)
                reportFinish()
                return
            }

            mapView.camera = timeline.overviewCamera.mkCamera
            redraw()
            startTime = CACurrentMediaTime()
            lastTick = startTime
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
            link.add(to: .main, forMode: .common)
            displayLink = link
        }

        func stop() {
            displayLink?.invalidate()
            displayLink = nil
        }

        @objc private func tick(_ link: CADisplayLink) {
            guard let mapView, let timeline else {
                stop()
                return
            }
            let now = CACurrentMediaTime()
            let elapsed = now - startTime
            let dt = min(0.1, max(0, now - lastTick))
            lastTick = now
            let plan = timeline.plan
            let run = timeline.distance(atElapsed: elapsed)

            // Heading: turns towards where the route goes next, slowly (time constant 2 s, at most 15°/s)
            if mode == .threeD && elapsed > timeline.introHold + timeline.flyIn * 0.5 && elapsed < timeline.runEnd {
                var turn = ReplayCamera.shortestTurn(from: heading, to: plan.bearing(at: run)) * (1 - exp(-dt / 2.0))
                let maxTurn = 15 * dt
                turn = min(maxTurn, max(-maxTurn, turn))
                heading += turn
                finishHeading = heading
            }
            // Centre: follows the runner with a little lag (time constant 0.7 s), so the camera glides
            if elapsed >= timeline.runStart && elapsed < timeline.runEnd + 0.5 {
                let target = plan.coordinate(at: run)
                let k = 1 - exp(-dt / 0.7)
                smoothedCenter = CLLocationCoordinate2D(
                    latitude: smoothedCenter.latitude + (target.latitude - smoothedCenter.latitude) * k,
                    longitude: smoothedCenter.longitude + (target.longitude - smoothedCenter.longitude) * k
                )
            }

            let camera: ReplayCamera
            if elapsed < timeline.introHold {
                camera = timeline.overviewCamera
            } else if elapsed < timeline.introHold + timeline.flyIn {
                let t = (elapsed - timeline.introHold) / timeline.flyIn
                camera = ReplayCamera.interpolate(timeline.overviewCamera, timeline.followCamera(at: 0, heading: heading), t)
            } else if elapsed < timeline.runEnd {
                var follow = timeline.followCamera(at: run, heading: heading)
                follow.center = smoothedCenter
                lastFollowCamera = follow
                camera = follow
            } else if elapsed < timeline.total {
                let t = (elapsed - timeline.runEnd) / timeline.finish
                let from = lastFollowCamera ?? timeline.followCamera(at: plan.length, heading: finishHeading)
                camera = ReplayCamera.interpolate(from, timeline.revealCamera(heading: finishHeading + 20), t)
            } else if mode == .threeD && elapsed < timeline.total + timeline.orbit && !userTookOver {
                // Slow turn around the route, speeding up gently
                let t = elapsed - timeline.total
                let ramp = min(1, t / 3)
                camera = timeline.revealCamera(heading: finishHeading + 20 + 5 * (t - 1.5 * (1 - ramp)))
            } else {
                // Done: the map is the user's
                runDistance = plan.length
                areaAlpha = 1
                redraw()
                if !reportedFinish { reportFinish() }
                setInteractive(true)
                stop()
                return
            }
            if !userTookOver {
                mapView.camera = camera.mkCamera
            }

            runDistance = run
            // The enclosed area fades in during the reveal
            areaAlpha = CGFloat(min(1, max(0, (elapsed - timeline.runEnd) / 1.6)))
            redraw()

            let finished = elapsed >= timeline.total
            if finished && !reportedFinish {
                reportFinish()
                setInteractive(true)
            }
            publish(fraction: run / plan.length, finished: finished, force: false)
        }

        /// Projects the route with the current camera and draws it.
        private func redraw() {
            guard let mapView, let timeline, !drawPoints.isEmpty else { return }
            let plan = timeline.plan
            let screen = drawPoints.map { mapView.convert($0, toPointTo: drawing) }
            let runner = mapView.convert(plan.coordinate(at: runDistance), toPointTo: drawing)

            let ghost = ReplayDrawingView.path(screen)
            var done: [CGPoint] = []
            for (index, point) in screen.enumerated() where drawCumulative[index] < runDistance {
                done.append(point)
            }
            if runDistance > 0 {
                done.append(runner)
            }
            let line = ReplayDrawingView.path(done)
            let area = areaAlpha > 0 ? ReplayDrawingView.path(screen, closed: true) : nil
            let finished = runDistance >= plan.length
            drawing.update(
                ghost: ghost,
                line: line,
                area: area,
                areaAlpha: areaAlpha,
                start: screen.first,
                runner: runDistance > 0 && !finished ? runner : nil,
                finish: finished ? screen.last : nil
            )
        }

        private func publish(fraction: Double, finished: Bool, force: Bool) {
            let now = CACurrentMediaTime()
            // SwiftUI overlays at ~15 Hz: enough for the counters, light on the main thread
            guard force || finished != (progress?.isFinished ?? false) || now - lastPublished > 1.0 / 15 else { return }
            lastPublished = now
            progress?.fraction = fraction
            progress?.isFinished = finished
        }

        private func reportFinish() {
            reportedFinish = true
            publish(fraction: 1, finished: true, force: true)
            onFinished?()
        }

        private func setInteractive(_ on: Bool) {
            guard let mapView else { return }
            mapView.isScrollEnabled = on
            mapView.isZoomEnabled = on
            mapView.isRotateEnabled = on
            mapView.isPitchEnabled = on
        }

        @objc private func userGesture(_ recognizer: UIGestureRecognizer) {
            if reportedFinish, recognizer.state == .began {
                userTookOver = true
            }
        }

        // MARK: MKMapViewDelegate

        /// The user moves the map after the replay (or the map settles): keep the drawing on the route.
        func mapViewDidChangeVisibleRegion(_ mapView: MKMapView) {
            redraw()
        }
    }
}

extension RouteReplayMapView.Coordinator: UIGestureRecognizerDelegate {
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        true
    }
}

// MARK: - Drawing over the map

/// The route (faint whole route, the part run so far with a white casing), the enclosed area and the
/// start, runner and finish markers, in screen coordinates. Never intercepts touches.
private final class ReplayDrawingView: UIView {
    private let areaLayer = CAShapeLayer()
    private let ghostLayer = CAShapeLayer()
    private let casingLayer = CAShapeLayer()
    private let lineLayer = CAShapeLayer()
    private let startView = UIView(frame: CGRect(x: 0, y: 0, width: 13, height: 13))
    private let runnerView = UIView(frame: CGRect(x: 0, y: 0, width: 40, height: 40))
    private let runnerDot = UIView(frame: CGRect(x: 12, y: 12, width: 16, height: 16))
    private let runnerHalo = CAShapeLayer()
    private let finishView = UIView(frame: CGRect(x: 0, y: 0, width: 26, height: 26))
    private var areaColor: UIColor = .systemGreen

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear

        for shape in [areaLayer, ghostLayer, casingLayer, lineLayer] {
            shape.fillColor = UIColor.clear.cgColor
            shape.lineCap = .round
            shape.lineJoin = .round
            layer.addSublayer(shape)
        }
        ghostLayer.lineWidth = 1.5
        ghostLayer.lineDashPattern = [2, 5]
        casingLayer.lineWidth = 4.5
        casingLayer.strokeColor = UIColor.white.withAlphaComponent(0.92).cgColor
        lineLayer.lineWidth = 2.6

        startView.backgroundColor = .white
        startView.layer.cornerRadius = 6.5
        startView.layer.borderWidth = 3
        addSubview(startView)

        runnerHalo.path = UIBezierPath(ovalIn: CGRect(x: 12, y: 12, width: 16, height: 16)).cgPath
        runnerHalo.frame = runnerView.bounds
        runnerView.layer.addSublayer(runnerHalo)
        runnerDot.layer.cornerRadius = 8
        runnerDot.layer.borderColor = UIColor.white.cgColor
        runnerDot.layer.borderWidth = 3
        runnerDot.layer.shadowColor = UIColor.black.cgColor
        runnerDot.layer.shadowOpacity = 0.3
        runnerDot.layer.shadowRadius = 3
        runnerDot.layer.shadowOffset = CGSize(width: 0, height: 1)
        runnerView.addSubview(runnerDot)
        runnerView.isHidden = true
        addSubview(runnerView)

        finishView.layer.cornerRadius = 13
        finishView.layer.borderColor = UIColor.white.cgColor
        finishView.layer.borderWidth = 2.5
        let flag = UIImageView(image: UIImage(systemName: "flag.checkered", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .bold)))
        flag.tintColor = .white
        flag.contentMode = .center
        flag.frame = finishView.bounds
        finishView.addSubview(flag)
        finishView.isHidden = true
        addSubview(finishView)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setColor(_ color: UIColor) {
        areaColor = color
        ghostLayer.strokeColor = color.withAlphaComponent(0.4).cgColor
        lineLayer.strokeColor = color.cgColor
        startView.layer.borderColor = color.cgColor
        runnerDot.backgroundColor = color
        runnerHalo.fillColor = color.withAlphaComponent(0.35).cgColor
        finishView.backgroundColor = color
        startPulse()
    }

    private func startPulse() {
        runnerHalo.removeAllAnimations()
        let pulse = CABasicAnimation(keyPath: "transform.scale")
        pulse.fromValue = 1
        pulse.toValue = 2.3
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.9
        fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [pulse, fade]
        group.duration = 1.4
        group.repeatCount = .infinity
        runnerHalo.add(group, forKey: "pulse")
    }

    /// A path through `points`, broken where the projection isn't usable (behind the camera).
    static func path(_ points: [CGPoint], closed: Bool = false) -> CGPath {
        let path = CGMutablePath()
        var drawing = false
        for point in points {
            guard point.x.isFinite, point.y.isFinite, abs(point.x) < 100_000, abs(point.y) < 100_000 else {
                drawing = false
                continue
            }
            if drawing {
                path.addLine(to: point)
            } else {
                path.move(to: point)
                drawing = true
            }
        }
        if closed { path.closeSubpath() }
        return path
    }

    func update(ghost: CGPath, line: CGPath, area: CGPath?, areaAlpha: CGFloat, start: CGPoint?, runner: CGPoint?, finish: CGPoint?) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ghostLayer.path = ghost
        casingLayer.path = line
        lineLayer.path = line
        areaLayer.path = area
        areaLayer.fillColor = areaColor.withAlphaComponent(0.2 * areaAlpha).cgColor
        areaLayer.strokeColor = areaColor.withAlphaComponent(0.45 * areaAlpha).cgColor
        areaLayer.lineWidth = 1
        place(startView, at: start)
        place(runnerView, at: runner)
        place(finishView, at: finish)
        CATransaction.commit()
    }

    private func place(_ view: UIView, at point: CGPoint?) {
        guard let point, point.x.isFinite, point.y.isFinite else {
            view.isHidden = true
            return
        }
        view.isHidden = false
        view.center = point
    }
}

/// The replay full screen.
struct RouteReplayFullScreen: View {
    let coordinates: [CLLocationCoordinate2D]
    let color: Color
    var distance: Double? = nil
    var duration: Int? = nil

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        RouteReplayView(coordinates: coordinates, color: color, distance: distance, duration: duration, height: nil, allowsFullScreen: false)
            .ignoresSafeArea()
            .overlay(alignment: .topTrailing) {
                GlassCircleButton(systemImage: "xmark", accessibilityLabel: "Cerrar") {
                    dismiss()
                }
                .padding(.trailing, DS.Spacing.l)
                .padding(.top, DS.Spacing.s)
            }
            .statusBarHidden()
    }
}

// MARK: - Pieces

/// Distance and time run so far.
private struct ReplayCounter: View {
    let meters: Double
    let seconds: Double?

    var body: some View {
        HStack(spacing: DS.Spacing.s) {
            Text(Format.distance(meters))
                .font(.subheadline.weight(.bold))
            if let seconds {
                Text(Format.duration(Int(seconds.rounded())))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
        .monospacedDigit()
        .padding(.horizontal, 12)
        .frame(height: 34)
        .glassSurface(Capsule())
        .accessibilityElement(children: .combine)
    }
}

/// Two-option switch on the map ("2D | 3D", "Mapa | Satélite"): the selected one is filled.
private struct ReplaySegmented: View {
    let options: [String]
    let selected: Int
    let label: String
    let onSelect: (Int) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(options.enumerated()), id: \.offset) { index, title in
                Button {
                    if index != selected { onSelect(index) }
                } label: {
                    Text(title)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(index == selected ? Color(uiColor: .systemBackground) : Color.primary)
                        .padding(.horizontal, 11)
                        .frame(height: 28)
                        .background {
                            if index == selected {
                                Capsule().fill(Color.primary)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(index == selected ? .isSelected : [])
            }
        }
        .padding(3)
        .glassSurface(Capsule(), interactive: true)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }
}

private struct ReplayIconButton: View {
    let systemImage: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.primary)
                .frame(width: 34, height: 34)
                .glassSurface(Circle(), interactive: true)
        }
        .buttonStyle(.pressable)
        .accessibilityLabel(label)
    }
}
