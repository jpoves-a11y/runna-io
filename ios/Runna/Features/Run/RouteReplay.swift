import SwiftUI
import MapKit

// MARK: - Geometry of the replay

/// The route prepared for the replay: evenly downsampled points, distance along the route,
/// where the runner is after any distance and which way they face.
struct RouteReplayPlan {
    let points: [CLLocationCoordinate2D]
    /// metres from the start to each point
    let cumulative: [Double]
    let length: Double
    let center: CLLocationCoordinate2D
    /// largest side of the route's bounding box, in metres
    let extent: Double

    private static let maxPoints = 500

    init?(coordinates: [CLLocationCoordinate2D]) {
        let valid = coordinates.filter { CLLocationCoordinate2DIsValid($0) && !($0.latitude == 0 && $0.longitude == 0) }
        guard valid.count >= 2 else { return nil }
        var sampled = valid
        if valid.count > Self.maxPoints {
            let step = Double(valid.count - 1) / Double(Self.maxPoints - 1)
            sampled = (0..<Self.maxPoints).map { valid[Int((Double($0) * step).rounded())] }
        }
        var distances: [Double] = [0]
        for index in 1..<sampled.count {
            distances.append(distances[index - 1] + Self.meters(sampled[index - 1], sampled[index]))
        }
        guard let total = distances.last, total > 1 else { return nil }

        let lats = sampled.map(\.latitude)
        let lngs = sampled.map(\.longitude)
        let minLat = lats.min() ?? 0
        let maxLat = lats.max() ?? 0
        let minLng = lngs.min() ?? 0
        let maxLng = lngs.max() ?? 0
        let middleLat = (minLat + maxLat) / 2
        let height = (maxLat - minLat) * 111_320
        let width = (maxLng - minLng) * 111_320 * cos(middleLat * .pi / 180)

        points = sampled
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

    /// The route run so far, ending exactly at the runner.
    func path(upTo distance: Double) -> [CLLocationCoordinate2D] {
        let d = min(max(0, distance), length)
        let index = segment(at: d)
        var path = Array(points.prefix(index + 1))
        path.append(coordinate(at: d))
        return path
    }

    /// Direction of the route around `distance` (degrees from north), looking ±120 m around it so GPS zigzags don't shake the camera.
    func bearing(at distance: Double) -> Double {
        let from = coordinate(at: distance - 120)
        let to = coordinate(at: distance + 120)
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

/// Timing and cameras of one replay: overview → fly in to the start → follow the runner → reveal the whole route.
struct RouteReplayTimeline {
    let plan: RouteReplayPlan
    let mode: RouteReplayMode

    /// Seconds: the far view holds, then flies in to the start.
    let introHold: Double = 0.7
    let flyIn: Double = 2.8
    /// At the start before running.
    let startHold: Double = 0.5
    let finish: Double = 2.4

    /// Longer routes play longer, between 7 and 16 seconds.
    var run: Double { min(16, max(7, 5 + plan.length / 1000 * 0.8)) }

    var runStart: Double { introHold + flyIn + startHold }
    var runEnd: Double { runStart + run }
    var total: Double { runEnd + finish }

    /// Metres run after `time` seconds of the run phase: smooth start and stop, steady in between.
    func distance(atRunTime time: Double) -> Double {
        let u = min(1, max(0, time / run))
        let ramp = 0.1
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
    func followCamera(at distance: Double, heading: Double) -> MapCamera {
        switch mode {
        case .threeD:
            return MapCamera(
                centerCoordinate: plan.coordinate(at: distance),
                distance: min(1500, max(600, plan.length * 0.1)),
                heading: heading,
                pitch: 62
            )
        case .flat:
            return MapCamera(
                centerCoordinate: plan.coordinate(at: distance),
                distance: min(4000, max(1200, plan.length * 0.3)),
                heading: 0,
                pitch: 0
            )
        }
    }

    /// Far away, centred on the route: where the replay starts.
    var overviewCamera: MapCamera {
        MapCamera(centerCoordinate: plan.center, distance: max(revealDistance * 6, 15_000), heading: 0, pitch: 0)
    }

    /// The whole route in view.
    private var revealDistance: Double { max(900, plan.extent * (mode == .threeD ? 3.0 : 2.6)) }

    func revealCamera(heading: Double) -> MapCamera {
        switch mode {
        case .threeD:
            return MapCamera(centerCoordinate: plan.center, distance: revealDistance, heading: heading, pitch: 40)
        case .flat:
            return MapCamera(centerCoordinate: plan.center, distance: revealDistance, heading: 0, pitch: 0)
        }
    }
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

    @AppStorage("routeReplayMode") private var modeRaw = RouteReplayMode.threeD.rawValue
    @AppStorage("routeReplaySatellite") private var satellite = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var position: MapCameraPosition = .automatic
    @State private var startDate: Date?
    @State private var playToken = 0
    @State private var isFinished = false
    @State private var showsFullScreen = false
    /// Computed once (the body is evaluated every frame while playing).
    @State private var plan: RouteReplayPlan?

    init(coordinates: [CLLocationCoordinate2D], color: Color, distance: Double? = nil, duration: Int? = nil, height: CGFloat? = 240, allowsFullScreen: Bool = true) {
        self.coordinates = coordinates
        self.color = color
        self.distance = distance
        self.duration = duration
        self.height = height
        self.allowsFullScreen = allowsFullScreen
        _plan = State(initialValue: RouteReplayPlan(coordinates: coordinates))
    }

    private var mode: RouteReplayMode { RouteReplayMode(rawValue: modeRaw) ?? .threeD }

    var body: some View {
        let replayPlan = self.plan
        let timeline = replayPlan.map { RouteReplayTimeline(plan: $0, mode: mode) }
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: isFinished || startDate == nil)) { context in
            let elapsed = startDate.map { context.date.timeIntervalSince($0) } ?? 0
            ZStack {
                replayMap(plan: replayPlan, timeline: timeline, elapsed: elapsed)
                overlays(plan: replayPlan, timeline: timeline, elapsed: elapsed)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .frame(maxHeight: height == nil ? .infinity : nil)
        .clipShape(RoundedRectangle(cornerRadius: height == nil ? 0 : DS.Radius.card, style: .continuous))
        .overlay {
            if height != nil {
                RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous).strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline)
            }
        }
        .animation(.snappy, value: isFinished)
        .task(id: playToken) { await play() }
        .onChange(of: coordinates.count) {
            // A different route in the same place on screen
            plan = RouteReplayPlan(coordinates: coordinates)
            playToken += 1
        }
        .fullScreenCover(isPresented: $showsFullScreen) {
            RouteReplayFullScreen(coordinates: coordinates, color: color, distance: distance, duration: duration)
        }
    }

    // MARK: Map

    @ViewBuilder
    private func replayMap(plan: RouteReplayPlan?, timeline: RouteReplayTimeline?, elapsed: Double) -> some View {
        let run = timeline?.distance(atElapsed: elapsed) ?? 0
        let path = plan?.path(upTo: run) ?? []
        let areaOpacity = isFinished ? 1 : min(1, max(0, (elapsed - (timeline?.runEnd ?? .infinity)) / 1.2))
        Map(position: $position, interactionModes: isFinished ? .all : []) {
            if let plan {
                // The whole route faintly, so its shape shows from far away
                MapPolyline(coordinates: plan.points)
                    .stroke(color.opacity(0.28), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round, dash: [2, 6]))
                if areaOpacity > 0, plan.points.count >= 3 {
                    MapPolygon(coordinates: plan.points)
                        .foregroundStyle(color.opacity(0.2 * areaOpacity))
                }
                if path.count >= 2 {
                    MapPolyline(coordinates: path)
                        .stroke(color.opacity(0.25), style: StrokeStyle(lineWidth: 14, lineCap: .round, lineJoin: .round))
                    MapPolyline(coordinates: path)
                        .stroke(Color.white, style: StrokeStyle(lineWidth: 7, lineCap: .round, lineJoin: .round))
                    MapPolyline(coordinates: path)
                        .stroke(color, style: StrokeStyle(lineWidth: 4.5, lineCap: .round, lineJoin: .round))
                }
                if let start = plan.points.first {
                    Annotation("Salida", coordinate: start) {
                        ReplayStartMarker(color: color)
                    }
                    .annotationTitles(.hidden)
                }
                if run >= plan.length, let end = plan.points.last {
                    Annotation("Meta", coordinate: end) {
                        ReplayFinishMarker(color: color)
                    }
                    .annotationTitles(.hidden)
                } else if run > 0 {
                    Annotation("", coordinate: plan.coordinate(at: run)) {
                        ReplayRunnerMarker(color: color, phase: elapsed)
                    }
                    .annotationTitles(.hidden)
                }
            }
        }
        .mapStyle(mapStyle)
        .mapControls {
            MapCompass().mapControlVisibility(.hidden)
        }
        .accessibilityLabel("Animación del recorrido")
    }

    private var mapStyle: MapStyle {
        let elevation: MapStyle.Elevation = mode == .threeD ? .realistic : .flat
        return satellite
            ? MapStyle.hybrid(elevation: elevation, pointsOfInterest: .excludingAll)
            : MapStyle.standard(elevation: elevation, emphasis: .muted, pointsOfInterest: .excludingAll)
    }

    // MARK: Overlays

    @ViewBuilder
    private func overlays(plan: RouteReplayPlan?, timeline: RouteReplayTimeline?, elapsed: Double) -> some View {
        let run = timeline?.distance(atElapsed: elapsed) ?? 0
        let fraction = plan.map { run / $0.length } ?? 0
        VStack {
            HStack(alignment: .top) {
                if fraction > 0 || isFinished {
                    ReplayCounter(
                        meters: (distance ?? plan?.length ?? 0) * (isFinished ? 1 : fraction),
                        seconds: duration.map { Double($0) * (isFinished ? 1 : fraction) }
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
                ReplayChip(title: mode == .threeD ? "3D" : "2D", systemImage: mode == .threeD ? "view.3d" : "map") {
                    modeRaw = (mode == .threeD ? RouteReplayMode.flat : .threeD).rawValue
                    playToken += 1
                }
                ReplayChip(title: satellite ? "Satélite" : "Mapa", systemImage: satellite ? "globe.europe.africa.fill" : "map.fill") {
                    satellite.toggle()
                }
                Spacer(minLength: 0)
                if isFinished {
                    ReplayChip(title: "Repetir", systemImage: "arrow.counterclockwise") {
                        playToken += 1
                    }
                    .transition(.opacity)
                }
            }
        }
        .padding(DS.Spacing.m)
        .padding(.top, height == nil ? DS.Spacing.xxxl + DS.Spacing.l : 0)
    }

    // MARK: Sequence

    private func play() async {
        guard let plan = self.plan else {
            isFinished = true
            return
        }
        let timeline = RouteReplayTimeline(plan: plan, mode: mode)
        isFinished = false
        let firstHeading = plan.bearing(at: 0)

        if reduceMotion {
            // No flying around: the whole route, drawn at once
            position = .camera(timeline.revealCamera(heading: 0))
            startDate = Date().addingTimeInterval(-timeline.total)
            isFinished = true
            return
        }

        // 1. Far away, centred on the route
        position = .camera(timeline.overviewCamera)
        let start = Date()
        startDate = start
        guard await wait(until: timeline.introHold, from: start) else { return }

        // 2. Fly in to the start, already facing the way the run goes
        withAnimation(.easeInOut(duration: timeline.flyIn)) {
            position = .camera(timeline.followCamera(at: 0, heading: firstHeading))
        }
        guard await wait(until: timeline.runStart, from: start) else { return }

        // 3. Follow the runner (camera moves in short linear steps to where the runner will be)
        var heading = firstHeading
        let step = 0.25
        while true {
            let now = Date().timeIntervalSince(start) - timeline.runStart
            if now >= timeline.run { break }
            let next = min(timeline.run, now + step)
            let meters = timeline.distance(atRunTime: next)
            if mode == .threeD {
                // Turn smoothly towards the route's direction (shortest way round; heading isn't wrapped)
                var delta = plan.bearing(at: meters) - heading.truncatingRemainder(dividingBy: 360)
                while delta > 180 { delta -= 360 }
                while delta < -180 { delta += 360 }
                heading += delta * 0.3
            }
            withAnimation(.linear(duration: next - now)) {
                position = .camera(timeline.followCamera(at: meters, heading: heading))
            }
            guard await wait(until: timeline.runStart + next, from: start) else { return }
        }

        // 4. Pull back to show the whole route and the area it encloses
        withAnimation(.easeInOut(duration: timeline.finish)) {
            position = .camera(timeline.revealCamera(heading: heading + 20))
        }
        guard await wait(until: timeline.total, from: start) else { return }
        isFinished = true

        // 5. In 3D, a slow turn around the route
        if mode == .threeD {
            withAnimation(.linear(duration: 12)) {
                position = .camera(timeline.revealCamera(heading: heading + 110))
            }
        }
    }

    /// Sleeps until `seconds` after `start`. False if the replay was cancelled (restarted or left).
    private func wait(until seconds: Double, from start: Date) async -> Bool {
        let remaining = seconds - Date().timeIntervalSince(start)
        if remaining > 0 {
            try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
        }
        return !Task.isCancelled
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

private struct ReplayStartMarker: View {
    let color: Color

    var body: some View {
        Circle()
            .fill(Color.white)
            .frame(width: 14, height: 14)
            .overlay(Circle().strokeBorder(color, lineWidth: 3.5))
            .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
    }
}

/// The runner: a dot with a halo that breathes.
private struct ReplayRunnerMarker: View {
    let color: Color
    /// seconds, drives the halo
    let phase: Double

    var body: some View {
        let pulse = 0.5 + 0.5 * sin(phase * 5)
        ZStack {
            Circle()
                .fill(color.opacity(0.25 * (1 - pulse) + 0.1))
                .frame(width: 22 + 14 * pulse, height: 22 + 14 * pulse)
            Circle()
                .fill(color)
                .frame(width: 16, height: 16)
                .overlay(Circle().stroke(Color.white, lineWidth: 3))
                .shadow(color: .black.opacity(0.3), radius: 3, y: 1)
        }
        .frame(width: 40, height: 40)
    }
}

private struct ReplayFinishMarker: View {
    let color: Color

    var body: some View {
        Image(systemName: "flag.checkered")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(Color.white)
            .frame(width: 28, height: 28)
            .background(color, in: Circle())
            .overlay(Circle().stroke(Color.white, lineWidth: 2.5))
            .shadow(color: .black.opacity(0.3), radius: 3, y: 1)
    }
}

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

private struct ReplayChip: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.primary)
                .padding(.horizontal, 12)
                .frame(height: 34)
                .glassSurface(Capsule(), interactive: true)
        }
        .buttonStyle(.pressable)
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
