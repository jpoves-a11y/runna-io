import CoreLocation
// Rain and snow are experimental in Mapbox Maps v11
@_spi(Experimental) import MapboxMaps
import UIKit

// MARK: - What the replay draws on the map (Mapbox)

/// The replay's map (Mapbox's view), for the files that don't import Mapbox.
typealias ReplayMapView = MapView

/// The replay's drawing on a Mapbox map: the look (satellite or map, 3D terrain in 3D), the faint
/// whole route, the route run so far (the same line trimmed to the runner's distance), the area it
/// encloses at the end, the start marker, and the runner's flag. The replay in the app and the video
/// renderer both use it, so they look the same.
///
/// The flag is a view annotation bound to the end of the line: Mapbox places it itself on its 3D
/// terrain (not on buildings), in step with the map it draws, so its foot stays on the line's end.
@MainActor
final class ReplayScene {
    let timeline: RouteReplayTimeline
    let color: UIColor
    /// The runner's flag, its foot on the end of the line
    let runnerFlag: RunnerFlagView

    private static let routeSource = "replay-route"
    private static let areaSource = "replay-area"
    private static let startSource = "replay-start"
    private static let demSource = "replay-dem"
    private static let satelliteSource = "replay-satellite"
    private static let satelliteLayer = "replay-satellite-photos"
    private static let ghostLayer = "replay-ghost"
    private static let casingLayer = "replay-casing"
    private static let lineLayer = "replay-line"
    private static let areaLayer = "replay-area-fill"
    private static let startLayer = "replay-start-dot"

    private weak var mapView: MapView?
    private let flagHolder: FlagHolderView
    private var flagAnnotation: ViewAnnotation?
    /// The style and the route's layers are in
    private(set) var isReady = false
    /// Mapbox's light: "day" or "night" (the app's dark mode)
    private var lightPreset = "day"
    /// Satellite imagery under the 3D buildings and trees, instead of the map's ground
    private var satellite = false
    private var drawn: Double = 0
    private var areaShown = false
    /// The flag's opacity, and where it's fading to (a quarter of a second)
    private var flagAlpha: CGFloat = 0
    private var flagAlphaTarget: CGFloat = 0
    /// The activity: when it was run sets the sun's light (and the weather) as the runner goes
    var activity: ReplayActivity?
    /// The pace of each km and the weather of that day (they may arrive after the replay starts)
    private(set) var extras = ReplayExtras()
    /// The weather effect on the map now (to change it only when it changes)
    private var weatherKey = ""
    /// A marker at each km (or 5 km on long routes): its distance along the route and its view
    private var kmMarkers: [(distance: Double, view: KmMarkerView, annotation: ViewAnnotation)] = []

    var plan: RouteReplayPlan { timeline.plan }

    init(timeline: RouteReplayTimeline, color: UIColor, runner: ReplayRunner) {
        self.timeline = timeline
        self.color = color
        runnerFlag = RunnerFlagView(runner: runner)
        flagHolder = FlagHolderView(flag: runnerFlag)
    }

    /// A map for the replay: no ornaments but the logo and attribution Mapbox requires, no gestures.
    static func makeMapView(frame: CGRect) -> MapView {
        let mapView = MapView(frame: frame)
        mapView.ornaments.options.scaleBar.visibility = .hidden
        mapView.ornaments.options.compass.visibility = .hidden
        setInteractive(false, on: mapView)
        return mapView
    }

    static func setInteractive(_ on: Bool, on mapView: MapView) {
        mapView.gestures.options.panEnabled = on
        mapView.gestures.options.pinchEnabled = on
        mapView.gestures.options.rotateEnabled = on
        mapView.gestures.options.pitchEnabled = on
        mapView.gestures.options.doubleTapToZoomInEnabled = on
        mapView.gestures.options.doubleTouchToZoomOutEnabled = on
        mapView.gestures.options.quickZoomEnabled = on
    }

    /// Loads the look (satellite with roads and names, or the standard map with its 3D buildings;
    /// 3D terrain in 3D) and puts the route on it. `isReady` once done.
    func install(on mapView: MapView, satellite: Bool, mode: RouteReplayMode, dark: Bool, activity: ReplayActivity?) {
        self.activity = activity
        self.mapView = mapView
        isReady = false
        drawn = 0
        areaShown = false
        // Every flag and km marker of an earlier replay goes (it would stay where that replay stopped)
        mapView.viewAnnotations.removeAll()
        flagAnnotation = nil
        kmMarkers = []
        weatherKey = ""
        // The sun's light where and when the run started; without a date, light or dark like the
        // app (satellite imagery then always in daylight)
        if let preset = sunPreset(atFraction: 0) {
            lightPreset = preset
        } else {
            lightPreset = dark && !satellite ? "night" : "day"
        }
        self.satellite = satellite
        // Mapbox Standard, with its 3D buildings, landmarks and trees: as a map, or with the
        // satellite imagery under them (see addRoute)
        let style: StyleURI = .standard
        if mapView.mapboxMap.styleURI == style && mapView.mapboxMap.isStyleLoaded {
            // The same look, loaded already: only the route again
            addRoute(to: mapView, mode: mode)
            return
        }
        mapView.mapboxMap.loadStyle(style) { [weak self, weak mapView] _ in
            MainActor.assumeIsolated {
                guard let self, let mapView, self.mapView === mapView else { return }
                self.addRoute(to: mapView, mode: mode)
            }
        }
    }

    private func addRoute(to mapView: MapView, mode: RouteReplayMode) {
        let map = mapView.mapboxMap!
        // Standard's look: its light, 3D buildings, landmarks and trees (with facades in 3D), no
        // points of interest
        let config: [String: Any] = [
            "lightPreset": lightPreset,
            "show3dObjects": true,
            "show3dBuildings": true,
            "show3dLandmarks": true,
            "show3dTrees": true,
            "show3dFacades": mode == .threeD,
            "showPointOfInterestLabels": false,
            "showTransitLabels": false,
            "showPedestrianRoads": !satellite,
        ]
        // The light changes smoothly (the sun setting as the runner goes)
        map.styleTransition = TransitionOptions(duration: 2.5, delay: 0)
        for (key, value) in config {
            try? map.setStyleImportConfigProperty(for: "basemap", config: key, value: value)
        }
        // Satellite: Mapbox's imagery over the map's ground (land, water), under its roads, labels and
        // 3D buildings and trees, so they stand on the photos
        if satellite {
            if !map.sourceExists(withId: Self.satelliteSource) {
                var imagery = RasterSource(id: Self.satelliteSource)
                imagery.url = "mapbox://mapbox.satellite"
                imagery.tileSize = 512
                try? map.addSource(imagery)
            }
            if !map.layerExists(withId: Self.satelliteLayer) {
                var photos = RasterLayer(id: Self.satelliteLayer, source: Self.satelliteSource)
                photos.slot = .bottom
                photos.rasterEmissiveStrength = .constant(1)
                try? map.addLayer(photos)
            }
            try? map.setLayerProperty(for: Self.satelliteLayer, property: "raster-brightness-max", value: Self.photoBrightness(for: lightPreset))
        } else if map.layerExists(withId: Self.satelliteLayer) {
            try? map.removeLayer(withId: Self.satelliteLayer)
        }
        for layer in [Self.startLayer, Self.lineLayer, Self.casingLayer, Self.ghostLayer, Self.areaLayer] where map.layerExists(withId: layer) {
            try? map.removeLayer(withId: layer)
        }
        for source in [Self.routeSource, Self.areaSource, Self.startSource] where map.sourceExists(withId: source) {
            try? map.removeSource(withId: source)
        }

        // 3D terrain in 3D (the line lies on it); flat in 2D
        if mode == .threeD {
            if !map.sourceExists(withId: Self.demSource) {
                var dem = RasterDemSource(id: Self.demSource)
                dem.url = "mapbox://mapbox.mapbox-terrain-dem-v1"
                dem.tileSize = 514
                try? map.addSource(dem)
            }
            try? map.setTerrain(Terrain(sourceId: Self.demSource))
        } else {
            map.removeTerrain()
        }

        let coordinates = plan.points
        var route = GeoJSONSource(id: Self.routeSource)
        route.data = .geometry(.lineString(LineString(coordinates)))
        route.lineMetrics = true
        try? map.addSource(route)

        // The whole route, faint and dashed
        var ghost = LineLayer(id: Self.ghostLayer, source: Self.routeSource)
        ghost.lineColor = .constant(StyleColor(color.withAlphaComponent(0.4)))
        ghost.lineWidth = .constant(2)
        ghost.lineCap = .constant(.round)
        ghost.lineDasharray = .constant([1, 2.5])
        ghost.lineEmissiveStrength = .constant(1)
        try? map.addLayer(ghost)

        // The route run so far: white casing and the coloured line, trimmed to the runner's distance
        var casing = LineLayer(id: Self.casingLayer, source: Self.routeSource)
        casing.lineColor = .constant(StyleColor(UIColor.white.withAlphaComponent(0.92)))
        casing.lineWidth = .constant(7)
        casing.lineCap = .constant(.round)
        casing.lineJoin = .constant(.round)
        casing.lineTrimOffset = .constant([0, 1])
        casing.lineEmissiveStrength = .constant(1)
        try? map.addLayer(casing)
        var line = LineLayer(id: Self.lineLayer, source: Self.routeSource)
        line.lineColor = .constant(StyleColor(color))
        line.lineWidth = .constant(4.5)
        line.lineCap = .constant(.round)
        line.lineJoin = .constant(.round)
        line.lineTrimOffset = .constant([0, 1])
        // Its own colour, not shaded by the map's light (day or night)
        line.lineEmissiveStrength = .constant(1)
        try? map.addLayer(line)

        // The start: a white dot ringed in the runner's colour
        var start = GeoJSONSource(id: Self.startSource)
        start.data = .geometry(.point(Point(coordinates.first ?? plan.center)))
        try? map.addSource(start)
        var dot = CircleLayer(id: Self.startLayer, source: Self.startSource)
        dot.circleRadius = .constant(5)
        dot.circleColor = .constant(StyleColor(.white))
        dot.circleStrokeColor = .constant(StyleColor(color))
        dot.circleStrokeWidth = .constant(3)
        dot.circlePitchAlignment = .constant(.viewport)
        dot.circleEmissiveStrength = .constant(1)
        try? map.addLayer(dot)

        // The runner's flag, bound to the end of the line
        let annotation = ViewAnnotation(coordinate: coordinates.first ?? plan.center, view: flagHolder)
        annotation.variableAnchors = [ViewAnnotationAnchorConfig(anchor: .bottom)]
        annotation.allowOverlap = true
        mapView.viewAnnotations.add(annotation)
        flagAnnotation = annotation
        flagHolder.alpha = flagAlpha

        isReady = true
        addKmMarkers(to: mapView)
        applyWeather(at: activity?.date(atFraction: 0))
        let distance = drawn
        drawn = -1
        drawTrail(to: distance)
    }

    /// Points the camera (the replay's camera: distance from the centre, pitch and heading).
    func setCamera(_ camera: ReplayCamera) {
        guard let mapView else { return }
        mapView.mapboxMap.setCamera(to: Self.cameraOptions(for: camera, viewHeight: mapView.bounds.height))
    }

    /// Mapbox's camera for one of the replay's: the zoom at which the centre is `distance` metres
    /// from the camera (Mapbox's field of view is about 36.87° high: the camera is 1.5 view heights
    /// away from the centre, in pixels).
    static func cameraOptions(for camera: ReplayCamera, viewHeight: CGFloat) -> CameraOptions {
        let height = Double(max(100, viewHeight))
        let metresPerPointAtZoomZero = 40_075_016.686 * cos(camera.center.latitude * .pi / 180) / 512
        let zoom = log2(metresPerPointAtZoomZero * 1.5 * height / max(1, camera.distance))
        return CameraOptions(
            center: camera.center,
            zoom: CGFloat(min(22, max(0, zoom))),
            bearing: camera.heading,
            pitch: CGFloat(min(85, max(0, camera.pitch)))
        )
    }

    /// Draws the route up to `distance` metres (the line trimmed past it).
    func drawTrail(to distance: Double) {
        let target = min(max(0, distance), plan.length)
        guard isReady, let map = mapView?.mapboxMap, abs(target - drawn) > 0.01 else {
            if !isReady { drawn = target }
            return
        }
        drawn = target
        let fraction = plan.length > 0 ? target / plan.length : 0
        // Trimmed from the runner's distance to the end (nothing trimmed at the end)
        let trim: [Double] = fraction >= 1 ? [1, 1] : [fraction, 1]
        try? map.setLayerProperty(for: Self.casingLayer, property: "line-trim-offset", value: trim)
        try? map.setLayerProperty(for: Self.lineLayer, property: "line-trim-offset", value: trim)
        showKmMarkers(upTo: target)
    }

    // MARK: Sun, weather and km markers

    /// The pace of each km and the weather of that day, once loaded: the km markers get their pace
    /// and the weather shows.
    func setExtras(_ extras: ReplayExtras) {
        guard extras != self.extras else { return }
        self.extras = extras
        guard isReady, let mapView else { return }
        addKmMarkers(to: mapView)
        weatherKey = ""
        applyWeather(at: activity?.date(atFraction: drawn / max(1, plan.length)))
    }

    /// The sun's light (and the weather) when the runner had run `fraction` of the route: dawn, day,
    /// dusk or night, changing smoothly.
    func updateSky(fraction: Double) {
        guard isReady, let map = mapView?.mapboxMap else { return }
        if let preset = sunPreset(atFraction: fraction), preset != lightPreset {
            lightPreset = preset
            try? map.setStyleImportConfigProperty(for: "basemap", config: "lightPreset", value: preset)
            if satellite {
                try? map.setLayerProperty(for: Self.satelliteLayer, property: "raster-brightness-max", value: Self.photoBrightness(for: preset))
            }
        }
        applyWeather(at: activity?.date(atFraction: fraction))
    }

    /// Mapbox's light for the sun where the route is, when the runner had run `fraction` of it.
    private func sunPreset(atFraction fraction: Double) -> String? {
        guard let date = activity?.date(atFraction: fraction) else { return nil }
        return SunPosition.lightPreset(at: plan.coordinate(at: plan.length * fraction), date: date)
    }

    /// How bright the satellite photos are in each light (darker at night, never black).
    private static func photoBrightness(for preset: String) -> Double {
        switch preset {
        case "night": return 0.45
        case "dawn", "dusk": return 0.75
        default: return 1
        }
    }

    /// Rain or snow if it rained or snowed at `date`, as heavy as it was.
    private func applyWeather(at date: Date?) {
        guard let map = mapView?.mapboxMap else { return }
        let hour = date.flatMap { extras.weather(at: $0) }
        let level = hour.map { min(1, 0.3 + $0.amount / 5) } ?? 0
        let key = "\(String(describing: hour?.kind))-\(Int((level * 4).rounded()))"
        guard key != weatherKey else { return }
        weatherKey = key
        try? map.removeRain()
        try? map.removeSnow()
        guard let hour else { return }
        switch hour.kind {
        case .rain:
            var rain = Rain()
            rain.density = .constant(level)
            rain.intensity = .constant(level)
            try? map.setRain(rain)
        case .snow:
            var snow = Snow()
            snow.density = .constant(level)
            snow.intensity = .constant(level)
            try? map.setSnow(snow)
        case .dry:
            break
        }
    }

    /// A marker at each km of the route (each 5 km on routes over 15 km), with that km's pace if
    /// known; each one shows as the line gets there.
    private func addKmMarkers(to mapView: MapView) {
        for marker in kmMarkers {
            marker.annotation.remove()
        }
        kmMarkers = []
        let step = plan.length > 15_000 ? 5 : 1
        let count = Int(plan.length / 1000)
        guard count >= 1 else { return }
        for km in stride(from: step, through: count, by: step) {
            let distance = Double(km) * 1000
            guard distance < plan.length - 50 else { continue }
            let pace = km <= extras.kmPaces.count ? extras.kmPaces[km - 1] : nil
            let view = KmMarkerView(km: km, pace: pace, color: color)
            let annotation = ViewAnnotation(coordinate: plan.coordinate(at: distance), view: view)
            annotation.variableAnchors = [ViewAnnotationAnchorConfig(anchor: .bottom)]
            annotation.allowOverlap = true
            mapView.viewAnnotations.add(annotation)
            kmMarkers.append((distance, view, annotation))
        }
        showKmMarkers(upTo: drawn)
    }

    /// Fades each km marker in as the line passes it (over about a quarter of a second of running).
    private func showKmMarkers(upTo distance: Double) {
        guard !kmMarkers.isEmpty else { return }
        let fade = max(20, 0.25 * plan.length / max(1, timeline.run))
        for marker in kmMarkers {
            let alpha = CGFloat(min(1, max(0, (distance - marker.distance) / fade)))
            if marker.view.alpha != alpha {
                marker.view.alpha = alpha
            }
        }
    }

    /// The area the route encloses, under the lines (once, at the reveal).
    func addArea() {
        guard isReady, !areaShown, let map = mapView?.mapboxMap else { return }
        areaShown = true
        var points = plan.points
        if let first = points.first { points.append(first) }
        var area = GeoJSONSource(id: Self.areaSource)
        area.data = .geometry(.polygon(Polygon([points])))
        try? map.addSource(area)
        var fill = FillLayer(id: Self.areaLayer, source: Self.areaSource)
        fill.fillColor = .constant(StyleColor(color.withAlphaComponent(0.2)))
        fill.fillOutlineColor = .constant(StyleColor(color.withAlphaComponent(0.45)))
        fill.fillEmissiveStrength = .constant(1)
        try? map.addLayer(fill, layerPosition: .below(Self.ghostLayer))
    }

    /// Moves the flag to the end of the line and on by `dt` (`streamBearing`: where its cloth is
    /// blown, nil: planted, it keeps its way). Call it after `drawTrail`.
    func updateFlag(streamBearing: Double?, moving: Bool, dt: Double) {
        guard let mapView else { return }
        if flagAlpha != flagAlphaTarget {
            let step = CGFloat(max(0, dt) / 0.25)
            flagAlpha = flagAlpha < flagAlphaTarget ? min(flagAlphaTarget, flagAlpha + step) : max(flagAlphaTarget, flagAlpha - step)
        }
        flagHolder.alpha = flagAlpha
        if let flagAnnotation {
            let end = plan.coordinate(at: drawn)
            flagAnnotation.annotatedFeature = .geometry(Point(end))
        }
        let camera = mapView.mapboxMap.cameraState
        runnerFlag.update(streamBearing: streamBearing, moving: moving, cameraHeading: camera.bearing, cameraPitch: Double(camera.pitch), dt: dt)
    }

    /// Shows the flag; `animated` fades it in a quarter of a second (as `updateFlag` goes).
    func setFlagAlpha(_ alpha: CGFloat, animated: Bool) {
        flagAlphaTarget = alpha
        if !animated {
            flagAlpha = alpha
            flagHolder.alpha = alpha
        }
    }
}

/// Holds the flag for Mapbox's view annotation: its size is the flag's, the foot of the pole the
/// middle of its bottom edge (the annotation's anchor).
final class FlagHolderView: UIView {
    private let flag: RunnerFlagView

    init(flag: RunnerFlagView) {
        self.flag = flag
        super.init(frame: CGRect(origin: .zero, size: RunnerFlagView.flagSize))
        isUserInteractionEnabled = false
        clipsToBounds = false
        flag.alpha = 1
        addSubview(flag)
        flag.stand(at: CGPoint(x: bounds.midX, y: bounds.maxY))
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var intrinsicContentSize: CGSize { RunnerFlagView.flagSize }

    override func sizeThatFits(_ size: CGSize) -> CGSize { RunnerFlagView.flagSize }

    override func systemLayoutSizeFitting(_ targetSize: CGSize) -> CGSize { RunnerFlagView.flagSize }

    override func systemLayoutSizeFitting(_ targetSize: CGSize, withHorizontalFittingPriority horizontalFittingPriority: UILayoutPriority, verticalFittingPriority: UILayoutPriority) -> CGSize {
        RunnerFlagView.flagSize
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        flag.stand(at: CGPoint(x: bounds.midX, y: bounds.maxY))
    }
}

// MARK: - Waiting for Mapbox

/// When Mapbox has drawn the map completely (every tile, no transition going on), from its render
/// events, and ways to wait for it.
@MainActor
final class MapLoadState {
    /// Frames Mapbox has finished drawing, and those drawn with everything they need and nothing moving
    private var frames = 0
    private var completeFrames = 0
    private var idles = 0
    private var observers: [AnyCancelable] = []

    func attach(to mapView: MapView) {
        observers = [
            mapView.mapboxMap.onRenderFrameFinished.observe { [weak self] event in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.frames += 1
                    // Drawn with every tile it needs (terrain transitions may keep it repainting)
                    if event.renderMode == .full {
                        self.completeFrames += 1
                    }
                }
            },
            mapView.mapboxMap.onMapIdle.observe { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.idles += 1
                }
            },
        ]
    }

    /// Waits until the map shows what was just set (camera, line): at least `minRefreshes` screen
    /// refreshes, then until Mapbox has drawn a complete frame since (or gone idle, or drawn nothing
    /// at all for a few refreshes: nothing changed), and `isReady` holds. Gives up after
    /// `maxRefreshes`; whether it settled.
    func settle(
        clock: FrameClock,
        maxRefreshes: Int,
        minRefreshes: Int = 2,
        isReady: (Int) -> Bool = { _ in true }
    ) async -> Bool {
        let startFrames = frames
        let startComplete = completeFrames
        let startIdles = idles
        var refreshes = 0
        while refreshes < maxRefreshes {
            await clock.next()
            if Task.isCancelled { return false }
            refreshes += 1
            guard refreshes >= minRefreshes, isReady(refreshes) else { continue }
            let complete = completeFrames > startComplete + 1 || idles > startIdles
            let untouched = frames == startFrames && refreshes >= minRefreshes + 3
            if complete || untouched { return true }
        }
        return false
    }

    /// Puts the map through `cameras` (via `scene`), each until Mapbox has loaded and drawn it
    /// completely (at most 1.5 s; the first, a wide view, up to 4 s), so they are all cached when the
    /// replay plays. Waits first for the map to be on screen and its style and route in.
    /// `onProgress` gets 0...1. False if cancelled.
    func preload(_ cameras: [ReplayCamera], on mapView: MapView, scene: ReplayScene, onProgress: (Double) -> Void) async -> Bool {
        let clock = FrameClock()
        clock.start()
        defer { clock.stop() }
        var waited = 0
        while mapView.window == nil || mapView.bounds.width < 1 || (!scene.isReady && waited < 900) {
            await clock.next()
            if Task.isCancelled { return false }
            waited += 1
        }
        for (index, camera) in cameras.enumerated() {
            scene.setCamera(camera)
            _ = await settle(clock: clock, maxRefreshes: index == 0 ? 240 : 90, minRefreshes: 2)
            if Task.isCancelled { return false }
            onProgress(Double(index + 1) / Double(cameras.count))
        }
        return true
    }
}

/// A km marker: "3 km · 5:12" in a small dark capsule, over a dot on the route.
final class KmMarkerView: UIView {
    private static let dotSize: CGFloat = 7
    private let size: CGSize

    init(km: Int, pace: Double?, color: UIColor) {
        var text = "\(km) km"
        if let pace, pace.isFinite, pace > 0 {
            let seconds = Int(pace.rounded())
            text += String(format: " · %d:%02d", seconds / 60, seconds % 60)
        }
        let label = UILabel()
        label.text = text
        label.font = .systemFont(ofSize: 11, weight: .bold)
        label.textColor = .white
        label.textAlignment = .center
        let textSize = label.intrinsicContentSize
        let capsule = CGSize(width: ceil(textSize.width) + 14, height: 20)
        size = CGSize(width: capsule.width, height: capsule.height + 3 + Self.dotSize)
        super.init(frame: CGRect(origin: .zero, size: size))
        isUserInteractionEnabled = false
        alpha = 0

        let background = UIView(frame: CGRect(origin: .zero, size: capsule))
        background.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        background.layer.cornerRadius = capsule.height / 2
        background.layer.borderWidth = 1
        background.layer.borderColor = UIColor.white.withAlphaComponent(0.25).cgColor
        addSubview(background)
        label.frame = background.bounds
        addSubview(label)

        let dot = UIView(frame: CGRect(x: (size.width - Self.dotSize) / 2, y: size.height - Self.dotSize, width: Self.dotSize, height: Self.dotSize))
        dot.backgroundColor = .white
        dot.layer.cornerRadius = Self.dotSize / 2
        dot.layer.borderWidth = 2
        dot.layer.borderColor = color.cgColor
        addSubview(dot)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var intrinsicContentSize: CGSize { size }

    override func sizeThatFits(_ size: CGSize) -> CGSize { self.size }

    override func systemLayoutSizeFitting(_ targetSize: CGSize) -> CGSize { size }

    override func systemLayoutSizeFitting(_ targetSize: CGSize, withHorizontalFittingPriority horizontalFittingPriority: UILayoutPriority, verticalFittingPriority: UILayoutPriority) -> CGSize {
        size
    }
}
