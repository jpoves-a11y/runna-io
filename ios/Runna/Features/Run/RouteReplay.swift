import SwiftUI
import MapKit
import UIKit

// MARK: - Geometry of the replay

/// The route prepared for the replay: resampled evenly and smoothed (GPS zigzags out, corners
/// rounded a little), with the distance along it, where the runner is after any distance and
/// which way the route goes there. It also has a much smoother copy of itself for the camera
/// to follow: the camera glides through turns but stays close to the runner, with no time lag.
struct RouteReplayPlan {
    let points: [CLLocationCoordinate2D]
    /// metres from the start to each point
    let cumulative: [Double]
    /// The route averaged over ±70-380 m, point by point with `points` (same distances): the camera's path
    let cameraPoints: [CLLocationCoordinate2D]
    let length: Double
    let center: CLLocationCoordinate2D
    /// largest side of the route's bounding box, in metres
    let extent: Double

    /// At most this many points (CPU of the per-frame work).
    private static let maxPoints = 900

    init?(coordinates: [CLLocationCoordinate2D]) {
        let usable = coordinates.filter { CLLocationCoordinate2DIsValid($0) && !($0.latitude == 0 && $0.longitude == 0) }
        // 0. Without the GPS's small loops (see withoutKnots)
        let valid = Self.withoutKnots(usable)
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

        // 2. Moving average over ~40 m (ends kept where they are)
        let half = max(1, Int((20 / spacing).rounded()))
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

        // 3. The camera's path: a moving average over ±2.5% of the route (70-380 m), with prefix sums;
        //    the window narrows near both ends so the camera starts and finishes on the route
        let cameraHalfWindow = min(380, max(70, total * 0.025))
        let cameraHalf = max(1, Int((cameraHalfWindow / spacing).rounded()))
        var prefixLat: [Double] = [0]
        var prefixLng: [Double] = [0]
        prefixLat.reserveCapacity(smoothed.count + 1)
        prefixLng.reserveCapacity(smoothed.count + 1)
        for point in smoothed {
            prefixLat.append(prefixLat[prefixLat.count - 1] + point.latitude)
            prefixLng.append(prefixLng[prefixLng.count - 1] + point.longitude)
        }
        var camera: [CLLocationCoordinate2D] = []
        camera.reserveCapacity(smoothed.count)
        for index in 0..<smoothed.count {
            let half = min(cameraHalf, index, smoothed.count - 1 - index)
            let from = index - half
            let to = index + half
            let count = Double(to - from + 1)
            camera.append(CLLocationCoordinate2D(
                latitude: (prefixLat[to + 1] - prefixLat[from]) / count,
                longitude: (prefixLng[to + 1] - prefixLng[from]) / count
            ))
        }

        points = smoothed
        cumulative = distances
        cameraPoints = camera
        length = total
        center = CLLocationCoordinate2D(latitude: middleLat, longitude: (minLng + maxLng) / 2)
        extent = max(height, width, 200)
    }

    /// The track without the GPS's knots. Where the runner stopped (a traffic light) or the signal
    /// was bad, the track wanders in small loops of 10-30 m; replayed at hundreds of metres a second
    /// they made the runner's dot jitter in little circles. Points under 3 m from the last one kept
    /// are dropped, and a stretch that comes back within 12 m of a point of the last 100 m, having
    /// stayed within 20 m of it while covering more than 25 m and three times that spread, is cut
    /// out. Real turns (a U-turn, a roundabout, laps) cover far less than three times their spread,
    /// so they stay. Tuned by simulation.
    static func withoutKnots(_ coordinates: [CLLocationCoordinate2D]) -> [CLLocationCoordinate2D] {
        guard coordinates.count > 2 else { return coordinates }
        // Flat metres around the start: plenty for distances of a few hundred metres
        let kx = cos(coordinates[0].latitude * .pi / 180) * 111_320
        let ky = 110_574.0
        func flat(_ c: CLLocationCoordinate2D) -> (x: Double, y: Double) {
            (c.longitude * kx, c.latitude * ky)
        }
        func gap(_ a: (x: Double, y: Double), _ b: (x: Double, y: Double)) -> Double {
            ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).squareRoot()
        }
        var kept: [CLLocationCoordinate2D] = [coordinates[0]]
        var keptFlat = [flat(coordinates[0])]
        /// metres along the kept track to each kept point
        var along: [Double] = [0]
        for coordinate in coordinates.dropFirst() {
            let point = flat(coordinate)
            guard let last = keptFlat.last, gap(point, last) >= 3 else { continue }
            let here = along[along.count - 1] + gap(last, point)
            var cut: Int?
            var j = keptFlat.count - 2
            while j >= 0 && here - along[j] <= 100 {
                let back = gap(keptFlat[j], point)
                let path = here - along[j]
                if back < 12 && path > 25 {
                    var spread = back
                    for k in (j + 1)..<keptFlat.count {
                        spread = max(spread, gap(keptFlat[k], keptFlat[j]))
                    }
                    if spread <= 20 && path > 3 * spread {
                        cut = j
                    }
                }
                j -= 1
            }
            if let cut {
                kept.removeSubrange((cut + 1)...)
                keptFlat.removeSubrange((cut + 1)...)
                along.removeSubrange((cut + 1)...)
            }
            guard let end = keptFlat.last, gap(point, end) >= 3 else { continue }
            along.append(along[along.count - 1] + gap(end, point))
            kept.append(coordinate)
            keptFlat.append(point)
        }
        // The finish exactly where the run ended
        if let finish = coordinates.last, kept.count >= 2 {
            kept[kept.count - 1] = finish
        }
        return kept
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

    /// `along` at `distance` metres (linear between its points).
    private func interpolate(_ along: [CLLocationCoordinate2D], at distance: Double) -> CLLocationCoordinate2D {
        let d = min(max(0, distance), length)
        let index = segment(at: d)
        let a = along[index]
        let b = along[min(index + 1, along.count - 1)]
        let span = cumulative[min(index + 1, cumulative.count - 1)] - cumulative[index]
        let f = span > 0 ? (d - cumulative[index]) / span : 0
        return CLLocationCoordinate2D(latitude: a.latitude + (b.latitude - a.latitude) * f, longitude: a.longitude + (b.longitude - a.longitude) * f)
    }

    /// Where the runner is after `distance` metres.
    func coordinate(at distance: Double) -> CLLocationCoordinate2D {
        interpolate(points, at: distance)
    }

    /// Where the camera looks when the runner is at `distance` metres (on the smoothed route).
    func cameraCoordinate(at distance: Double) -> CLLocationCoordinate2D {
        interpolate(cameraPoints, at: distance)
    }

    /// Direction of the route around `distance` (degrees from north), looking `window` metres behind
    /// and ahead so the camera turns with the street, not with every small bend.
    func bearing(at distance: Double, window: Double = 350) -> Double {
        Self.bearing(from: coordinate(at: distance - window * 0.4), to: coordinate(at: distance + window))
    }

    /// Direction the camera faces when the runner is at `distance` metres: along the smoothed route,
    /// looking well ahead so turns are anticipated.
    func cameraBearing(at distance: Double) -> Double {
        Self.bearing(from: cameraCoordinate(at: distance - 100), to: cameraCoordinate(at: distance + 350))
    }

    /// Where the wind of running blows the runner's flag at `distance` metres: opposite to their way
    /// over the last tens of metres.
    func windBearing(at distance: Double) -> Double {
        bearing(at: min(max(distance, 30), length - 30), window: 80) + 180
    }

    static func bearing(from: CLLocationCoordinate2D, to: CLLocationCoordinate2D) -> Double {
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

    /// Easing of the following camera (seconds, each of its two stages): 0.2 s, less on very fast
    /// replays (long routes) so the runner stays well inside the frame.
    var cameraEasing: Double { min(0.2, max(0.1, 120 / max(1, plan.length / run))) }

    /// How far the following camera is from the ground point it looks at (metres).
    var followDistance: Double {
        switch mode {
        case .threeD: return min(3200, max(1200, plan.length * 0.18))
        case .flat: return min(7000, max(2200, plan.length * 0.5))
        }
    }

    /// Camera following the runner (looking at the smoothed route): a bit far back so the surroundings show.
    func followCamera(at distance: Double, heading: Double) -> ReplayCamera {
        switch mode {
        case .threeD:
            return ReplayCamera(center: plan.cameraCoordinate(at: distance), distance: followDistance, pitch: 50, heading: heading)
        case .flat:
            return ReplayCamera(center: plan.cameraCoordinate(at: distance), distance: followDistance, pitch: 0, heading: 0)
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

/// One moment of a replay: the camera, the runner and how much of the route is drawn.
struct ReplayFrame {
    var camera: ReplayCamera
    /// metres run
    var run: Double
    var runner: CLLocationCoordinate2D
    /// metres of the route drawn: up to the runner, the whole route once it has finished
    var trail: Double
    var showsRunner: Bool
    var showsFinish: Bool
    /// The run is over: the whole route is drawn and its area shown
    var isRevealed: Bool
    /// The finish phase is over: the whole route is in view (in 3D the slow turn goes on)
    var isFinished: Bool
    /// Nothing moves any more
    var isOver: Bool
}

/// Computes a replay frame after frame for any clock: the screen's while it plays in the app, a
/// fixed frame rate while a video is made, so both are exactly the same animation. Holds the
/// camera's eased state (the heading, and the centre in two stages: a critically damped glide).
struct ReplayDirector {
    let timeline: RouteReplayTimeline
    private var heading: Double
    private var finishHeading: Double
    private var cameraCenterStage: CLLocationCoordinate2D
    private var cameraCenter: CLLocationCoordinate2D
    private var lastFollowCamera: ReplayCamera?

    init(timeline: RouteReplayTimeline) {
        self.timeline = timeline
        heading = timeline.plan.cameraBearing(at: 0)
        finishHeading = heading
        cameraCenter = timeline.plan.cameraCoordinate(at: 0)
        cameraCenterStage = cameraCenter
    }

    /// When nothing moves any more: after the finish in 2D, after the slow turn in 3D.
    var end: Double { timeline.total + (timeline.mode == .threeD ? timeline.orbit : 0) }

    /// The frame `elapsed` seconds after the start, `dt` seconds after the previous one. The line
    /// ends exactly at the runner (its end hides under the runner's dot).
    mutating func frame(at elapsed: Double, dt: Double) -> ReplayFrame {
        let plan = timeline.plan
        let run = timeline.distance(atElapsed: elapsed)
        let runner = plan.coordinate(at: run)

        // Heading (3D): towards where the smoothed route goes next, eased (time constant 1.4 s, at most 24°/s)
        if timeline.mode == .threeD && elapsed > timeline.introHold + timeline.flyIn * 0.5 && elapsed < timeline.runEnd {
            var turn = ReplayCamera.shortestTurn(from: heading, to: plan.cameraBearing(at: run)) * (1 - exp(-dt / 1.4))
            let maxTurn = 24 * dt
            turn = min(maxTurn, max(-maxTurn, turn))
            heading += turn
            finishHeading = heading
        }
        // Centre: the smoothed route, eased in two stages (its velocity changes smoothly, no jolts
        // at turns) and aimed where the runner will be after the easing delay, so on straights it
        // sits on the runner; never more than 12% of the camera distance from the runner, so the
        // runner can't leave the frame (tuned by simulation: the runner stays within 70% of that)
        if elapsed >= timeline.runStart && elapsed < timeline.runEnd {
            let easing = timeline.cameraEasing
            let target = plan.cameraCoordinate(at: timeline.distance(atElapsed: elapsed + 2 * easing))
            let k = 1 - exp(-dt / easing)
            cameraCenterStage = CLLocationCoordinate2D(
                latitude: cameraCenterStage.latitude + (target.latitude - cameraCenterStage.latitude) * k,
                longitude: cameraCenterStage.longitude + (target.longitude - cameraCenterStage.longitude) * k
            )
            cameraCenter = CLLocationCoordinate2D(
                latitude: cameraCenter.latitude + (cameraCenterStage.latitude - cameraCenter.latitude) * k,
                longitude: cameraCenter.longitude + (cameraCenterStage.longitude - cameraCenter.longitude) * k
            )
            cameraCenter = Self.limit(cameraCenter, within: timeline.followDistance * 0.12, of: runner)
        }

        let camera: ReplayCamera
        if elapsed < timeline.introHold {
            camera = timeline.overviewCamera
        } else if elapsed < timeline.introHold + timeline.flyIn {
            let t = (elapsed - timeline.introHold) / timeline.flyIn
            camera = ReplayCamera.interpolate(timeline.overviewCamera, timeline.followCamera(at: 0, heading: heading), t)
        } else if elapsed < timeline.runStart {
            camera = timeline.followCamera(at: 0, heading: heading)
        } else if elapsed < timeline.runEnd {
            var follow = timeline.followCamera(at: run, heading: heading)
            follow.center = cameraCenter
            lastFollowCamera = follow
            camera = follow
        } else if elapsed < timeline.total {
            let t = (elapsed - timeline.runEnd) / timeline.finish
            let from = lastFollowCamera ?? timeline.followCamera(at: plan.length, heading: finishHeading)
            camera = ReplayCamera.interpolate(from, timeline.revealCamera(heading: finishHeading + 20), t)
        } else if timeline.mode == .threeD {
            // Slow turn around the route: from still (where the reveal stopped) up to 5°/s in 3 s
            let t = min(elapsed, end) - timeline.total
            let turned = t < 3 ? 5 * t * t / 6 : 5 * (t - 1.5)
            camera = timeline.revealCamera(heading: finishHeading + 20 + turned)
        } else {
            camera = timeline.revealCamera(heading: finishHeading + 20)
        }

        let revealed = elapsed >= timeline.runEnd
        return ReplayFrame(
            camera: camera,
            run: run,
            runner: runner,
            trail: revealed ? plan.length : run,
            showsRunner: run > 0 && run < plan.length,
            showsFinish: run >= plan.length,
            isRevealed: revealed,
            isFinished: elapsed >= timeline.total,
            isOver: elapsed >= end
        )
    }

    /// The cameras a replay goes through, to load the map before it plays: the animation's own
    /// camera path, frame by frame, sampled so every zoom and every area it shows gets loaded: a view
    /// each half zoom level (fly-in, zoom out at the end), each 15° of pitch, each 20° of turn (also
    /// the slow turn of 3D) and, while running, each quarter of the camera's distance along the
    /// route (at most ~60 views, a marathon), plus the last view.
    static func preloadCameras(for timeline: RouteReplayTimeline) -> [ReplayCamera] {
        var director = ReplayDirector(timeline: timeline)
        let end = director.end
        let spacing = max(timeline.followDistance * (timeline.mode == .threeD ? 0.25 : 0.35), timeline.plan.length / 60)
        let halfZoom = log(1.4)
        let step = 1.0 / 30
        var cameras: [ReplayCamera] = []
        var taken: ReplayCamera?
        var takenRun = 0.0
        var current: ReplayCamera?
        var elapsed = 0.0
        var previous = 0.0
        while elapsed <= end {
            let frame = director.frame(at: elapsed, dt: elapsed - previous)
            previous = elapsed
            let camera = frame.camera
            current = camera
            var take = true
            if let taken {
                let zoomed = abs(log(max(1, camera.distance) / max(1, taken.distance))) >= halfZoom
                let tilted = abs(camera.pitch - taken.pitch) >= 15
                let turned = abs(ReplayCamera.shortestTurn(from: taken.heading, to: camera.heading)) >= 20
                let ran = elapsed > timeline.runStart && elapsed < timeline.runEnd && frame.run - takenRun >= spacing
                take = zoomed || tilted || turned || ran
            }
            if take {
                cameras.append(camera)
                taken = camera
                takenRun = frame.run
            }
            elapsed += step
        }
        if let current {
            cameras.append(current)
        }
        return cameras
    }

    /// `center` moved towards `runner` so it's at most `maxMeters` from it.
    private static func limit(_ center: CLLocationCoordinate2D, within maxMeters: Double, of runner: CLLocationCoordinate2D) -> CLLocationCoordinate2D {
        let kx = cos(runner.latitude * .pi / 180) * 111_320
        let ky = 110_574.0
        let dx = (center.longitude - runner.longitude) * kx
        let dy = (center.latitude - runner.latitude) * ky
        let offset = (dx * dx + dy * dy).squareRoot()
        guard offset > maxMeters, offset > 0 else { return center }
        let f = maxMeters / offset
        return CLLocationCoordinate2D(
            latitude: runner.latitude + (center.latitude - runner.latitude) * f,
            longitude: runner.longitude + (center.longitude - runner.longitude) * f
        )
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
    /// 0...1 while the map loads the views of the replay before it plays; nil once it plays
    var loading: Double?
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
    /// Whose flag runs the route (photo and colour); nil: the signed-in user.
    var runner: ReplayRunner?

    @AppStorage("routeReplayMode") private var modeRaw = RouteReplayMode.threeD.rawValue
    @AppStorage("routeReplaySatellite") private var satellite = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Environment(SessionStore.self) private var session: SessionStore?

    @State private var playToken = 0
    @State private var showsFullScreen = false
    @State private var progress = RouteReplayProgress()
    @State private var runnerPhoto: UIImage?
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
        onFinished: (() -> Void)? = nil,
        runner: ReplayRunner? = nil
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
        self.runner = runner
        _plan = State(initialValue: RouteReplayPlan(coordinates: coordinates))
    }

    /// The flag's runner: the one given, else the signed-in user.
    private var flagRunner: ReplayRunner {
        if let runner { return runner }
        if let user = session?.user { return ReplayRunner(user: user) }
        return ReplayRunner(name: "", avatar: nil, color: "#16A34A")
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
                onFinished: onFinished,
                runner: flagRunner,
                runnerPhoto: runnerPhoto
            )
            .accessibilityLabel("Animación del recorrido")
            // The views that read the progress (several times a second) are separate views, so
            // SwiftUI re-renders only them while the replay plays, never the map
            ReplayLoadingCover(progress: progress)
            if let share {
                ReplayShareLayer(
                    progress: progress,
                    options: share,
                    distance: distance ?? plan?.length ?? 0,
                    duration: duration
                )
            } else if config == nil {
                ReplayChrome(
                    progress: progress,
                    totalDistance: distance ?? plan?.length ?? 0,
                    duration: duration,
                    allowsFullScreen: allowsFullScreen,
                    topInset: height == nil ? DS.Spacing.xxxl + DS.Spacing.l : 0,
                    mode: mode,
                    satellite: satellite,
                    onFullScreen: { showsFullScreen = true },
                    onMode: { newMode in modeRaw = newMode.rawValue },
                    onSatellite: { on in satellite = on },
                    onReplay: { playToken += 1 }
                )
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
        .onChange(of: coordinates.count) {
            // A different route in the same place on screen
            plan = RouteReplayPlan(coordinates: coordinates)
            playToken += 1
        }
        .onChange(of: restartToken) { playToken += 1 }
        .task(id: flagRunner) {
            runnerPhoto = await flagRunner.loadPhoto()
        }
        .fullScreenCover(isPresented: $showsFullScreen) {
            RouteReplayFullScreen(coordinates: coordinates, color: color, distance: distance, duration: duration, runner: runner)
        }
    }
}

/// Counters and switches over the map. Reads the replay's progress in its own body, so these
/// re-render several times a second while playing and the map doesn't.
private struct ReplayChrome: View {
    let progress: RouteReplayProgress
    let totalDistance: Double
    let duration: Int?
    let allowsFullScreen: Bool
    let topInset: CGFloat
    let mode: RouteReplayMode
    let satellite: Bool
    let onFullScreen: () -> Void
    let onMode: (RouteReplayMode) -> Void
    let onSatellite: (Bool) -> Void
    let onReplay: () -> Void

    var body: some View {
        let fraction = progress.fraction
        let finished = progress.isFinished
        VStack {
            HStack(alignment: .top) {
                if fraction > 0 || finished {
                    ReplayCounter(
                        meters: totalDistance * (finished ? 1 : fraction),
                        seconds: duration.map { Double($0) * (finished ? 1 : fraction) }
                    )
                    .transition(.opacity)
                }
                Spacer(minLength: 0)
                if allowsFullScreen {
                    ReplayIconButton(systemImage: "arrow.up.left.and.arrow.down.right", label: "Pantalla completa", action: onFullScreen)
                }
            }
            Spacer(minLength: 0)
            HStack(spacing: DS.Spacing.s) {
                ReplaySegmented(
                    options: ["2D", "3D"],
                    selected: mode == .threeD ? 1 : 0,
                    label: "Vista"
                ) { index in
                    onMode(index == 1 ? .threeD : .flat)
                }
                ReplaySegmented(
                    options: ["Mapa", "Satélite"],
                    selected: satellite ? 1 : 0,
                    label: "Tipo de mapa"
                ) { index in
                    onSatellite(index == 1)
                }
                Spacer(minLength: 0)
                if finished {
                    ReplayIconButton(systemImage: "arrow.counterclockwise", label: "Repetir", action: onReplay)
                        .transition(.opacity)
                }
            }
        }
        .padding(DS.Spacing.m)
        .padding(.top, topInset)
        .animation(.snappy, value: finished)
    }
}

/// Titles and figures of the shared video, reading the progress in its own body (see ReplayChrome).
private struct ReplayShareLayer: View {
    let progress: RouteReplayProgress
    let options: RouteShareOptions
    let distance: Double
    let duration: Int?

    var body: some View {
        RouteShareOverlay(
            options: options,
            fraction: progress.fraction,
            isFinished: progress.isFinished,
            distance: distance,
            duration: duration
        )
    }
}

// MARK: - Map (UIKit, Mapbox)

/// The map of the replay (Mapbox), driven frame by frame by one clock (CADisplayLink, at the
/// screen's refresh rate). Each frame is computed for the moment it will be on screen, and the
/// runner, the camera and the route line advance together:
/// - Before it plays, the camera goes through the views the replay will show, behind a "loading"
///   cover, until Mapbox has loaded and drawn each of them: no area is missing while it plays.
/// - The route run so far is the route's line trimmed at the runner's distance, lying on the 3D
///   terrain; on its end stands the runner's flag, a view annotation Mapbox places itself on the
///   terrain, in step with the map. At the finish it stays planted, waving.
/// - The camera looks at a much smoother copy of the route at the runner's distance (it glides
///   through turns, with no time lag) and is never more than 12% of its distance from the runner,
///   so the runner can't leave the frame.
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
    let runner: ReplayRunner
    let runnerPhoto: UIImage?

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> ReplayMapView {
        let mapView = ReplayScene.makeMapView(frame: .zero)
        context.coordinator.attach(to: mapView)
        update(context.coordinator, mapView: mapView, force: true)
        return mapView
    }

    func updateUIView(_ mapView: ReplayMapView, context: Context) {
        update(context.coordinator, mapView: mapView, force: false)
    }

    static func dismantleUIView(_ mapView: ReplayMapView, coordinator: Coordinator) {
        coordinator.stop()
    }

    private func update(_ coordinator: Coordinator, mapView: ReplayMapView, force: Bool) {
        coordinator.progress = progress
        coordinator.onFinished = onFinished
        coordinator.reduceMotion = reduceMotion
        coordinator.setRunnerPhoto(runnerPhoto)
        // A new look (2D / 3D, map / satellite) plays again from the start, loading its views first
        let styleKey = "\(satellite)-\(mode.rawValue)"
        let restart = force || coordinator.styleKey != styleKey || coordinator.playToken != playToken || coordinator.speed != speed
            || coordinator.colorKey != colorKey || coordinator.runner != runner
        if restart, let plan {
            coordinator.playToken = playToken
            coordinator.colorKey = colorKey
            coordinator.styleKey = styleKey
            coordinator.play(plan: plan, mode: mode, satellite: satellite, speed: speed, color: color, runner: runner, on: mapView)
        }
    }

    @MainActor
    final class Coordinator: NSObject {
        var progress: RouteReplayProgress?
        var onFinished: (() -> Void)?
        var reduceMotion = false
        var playToken = -1
        var colorKey = ""
        var styleKey: String?
        private(set) var speed: Double = 1
        private(set) var runner: ReplayRunner?
        private var runnerPhoto: UIImage?
        /// The replay is over: the flag stays planted at the finish (and waves) while the map is the user's
        private var planted = false

        private weak var mapView: ReplayMapView?
        private var scene: ReplayScene?
        private var director: ReplayDirector?
        private let loadState = MapLoadState()
        private var preloadTask: Task<Void, Never>?
        /// Route, view and map whose views are loaded already (playing it again needn't wait)
        private var preloadedKey: String?
        private var displayLink: CADisplayLink?
        private var startTime: CFTimeInterval = 0
        private var lastTick: CFTimeInterval = 0
        private var reportedFinish = false
        private var lastPublished: CFTimeInterval = 0
        private var userTookOver = false

        func attach(to mapView: ReplayMapView) {
            self.mapView = mapView
            loadState.attach(to: mapView)
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

        /// The runner's photo for the flag (it may arrive after the replay started).
        func setRunnerPhoto(_ photo: UIImage?) {
            guard let photo, photo !== runnerPhoto else { return }
            runnerPhoto = photo
            scene?.runnerFlag.setPhoto(photo)
        }

        // MARK: Playback

        /// Plays the replay from the start: loads the look and the route, then the map for every
        /// view it goes through (behind the cover); then flies.
        func play(plan: RouteReplayPlan, mode: RouteReplayMode, satellite: Bool, speed: Double, color: UIColor, runner: ReplayRunner, on mapView: ReplayMapView) {
            stop()
            self.speed = speed
            self.runner = runner
            planted = false
            let timeline = RouteReplayTimeline(plan: plan, mode: mode, speed: speed)
            let scene = ReplayScene(timeline: timeline, color: color, runner: runner)
            scene.runnerFlag.setPhoto(runnerPhoto)
            self.scene = scene
            director = ReplayDirector(timeline: timeline)
            reportedFinish = false
            userTookOver = false
            setInteractive(false)
            scene.install(on: mapView, satellite: satellite, mode: mode)
            publish(fraction: 0, finished: false, force: true)
            progress?.loading = 0

            let key = "\(plan.points.count)-\(Int(plan.length))-\(mode.rawValue)-\(satellite)"
            var cameras: [ReplayCamera]
            if reduceMotion {
                cameras = [timeline.revealCamera(heading: 0)]
            } else if preloadedKey == key {
                // Loaded already: only the first view, so it's on screen when the cover goes
                cameras = [timeline.overviewCamera]
            } else {
                // Every view, then back to the first one
                cameras = ReplayDirector.preloadCameras(for: timeline)
                cameras.append(timeline.overviewCamera)
            }
            let loadState = self.loadState
            preloadTask = Task { [weak self, cameras] in
                let loaded = await loadState.preload(cameras, on: mapView, scene: scene, onProgress: { fraction in
                    self?.progress?.loading = fraction
                })
                guard loaded, !Task.isCancelled, let self, self.scene === scene else { return }
                self.preloadedKey = key
                self.start(timeline: timeline, scene: scene)
            }
        }

        /// The map is loaded: the cover goes and the replay plays (without motion: the whole route at once).
        private func start(timeline: RouteReplayTimeline, scene: ReplayScene) {
            preloadTask = nil
            progress?.loading = nil
            let plan = timeline.plan
            startTime = CACurrentMediaTime()
            lastTick = startTime
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            // Every frame the screen shows (120 Hz on ProMotion iPhones)
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
            link.add(to: .main, forMode: .common)
            displayLink = link
            if reduceMotion {
                // The whole route at once, the flag planted at the finish (still)
                scene.setCamera(timeline.revealCamera(heading: 0))
                scene.drawTrail(to: plan.length)
                scene.addArea()
                scene.setFlagAlpha(1, animated: false)
                setInteractive(true)
                reportFinish()
                plant(link: link)
                return
            }
            scene.setCamera(timeline.overviewCamera)
        }

        /// The flag stays planted at the finish, waving, as the user moves the map (at 60 Hz at most
        /// from now on).
        private func plant(link: CADisplayLink) {
            planted = true
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        }

        func stop() {
            preloadTask?.cancel()
            preloadTask = nil
            displayLink?.invalidate()
            displayLink = nil
        }

        @objc private func tick(_ link: CADisplayLink) {
            guard let scene, var director = self.director else {
                stop()
                return
            }
            // Computed for the moment this frame will be on screen, so motion is even frame to frame
            let now = link.targetTimestamp
            let dt = min(0.1, max(0, now - lastTick))
            lastTick = now
            if planted {
                // Planted: at the finish, in a breeze (still without motion)
                scene.updateFlag(streamBearing: nil, moving: false, dt: reduceMotion ? 0 : dt)
                return
            }
            let frame = director.frame(at: now - startTime, dt: dt)
            self.director = director
            let plan = scene.plan

            if frame.isOver || (frame.isFinished && userTookOver) {
                // Done: the map is the user's, the flag stays planted at the finish
                scene.drawTrail(to: plan.length)
                scene.addArea()
                if !reportedFinish { reportFinish() }
                setInteractive(true)
                plant(link: link)
                return
            }

            // The camera, the line and the flag at its end, all for the same frame. The flag shows
            // once the runner sets off and stays (planted at the finish when they get there), its
            // cloth blown back from where they're going.
            scene.setFlagAlpha(frame.run > 0 ? 1 : 0, animated: true)
            if !userTookOver {
                scene.setCamera(frame.camera)
            }
            scene.drawTrail(to: frame.trail)
            scene.updateFlag(streamBearing: plan.windBearing(at: frame.trail), moving: frame.showsRunner, dt: dt)
            if frame.isRevealed {
                scene.addArea()
            }

            if frame.isFinished && !reportedFinish {
                reportFinish()
                setInteractive(true)
            }
            publish(fraction: frame.run / plan.length, finished: frame.isFinished, force: false)
        }

        private func publish(fraction: Double, finished: Bool, force: Bool) {
            let now = CACurrentMediaTime()
            // SwiftUI overlays at ~12 Hz: enough for the counters, light on the main thread
            guard force || finished != (progress?.isFinished ?? false) || now - lastPublished > 1.0 / 12 else { return }
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
            ReplayScene.setInteractive(on, on: mapView)
        }

        @objc private func userGesture(_ recognizer: UIGestureRecognizer) {
            if reportedFinish, recognizer.state == .began {
                userTookOver = true
            }
        }
    }
}

extension RouteReplayMapView.Coordinator: UIGestureRecognizerDelegate {
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        true
    }
}

// MARK: - Waiting for the map

/// Screen refreshes to wait for (`await clock.next()`), from a display link at 60 Hz.
@MainActor
final class FrameClock: NSObject {
    private var link: CADisplayLink?
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func start() {
        guard link == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    func stop() {
        link?.invalidate()
        link = nil
        resumeAll()
    }

    /// Returns at the next screen refresh (at once if the clock isn't running).
    func next() async {
        guard link != nil else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            waiting.append(continuation)
        }
    }

    @objc private func tick() {
        resumeAll()
    }

    private func resumeAll() {
        let continuations = waiting
        waiting = []
        for continuation in continuations {
            continuation.resume()
        }
    }
}

/// The replay full screen.
struct RouteReplayFullScreen: View {
    let coordinates: [CLLocationCoordinate2D]
    let color: Color
    var distance: Double? = nil
    var duration: Int? = nil
    /// Whose flag (nil: the signed-in user)
    var runner: ReplayRunner? = nil

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        RouteReplayView(coordinates: coordinates, color: color, distance: distance, duration: duration, height: nil, allowsFullScreen: false, runner: runner)
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

/// Covers the map while it loads every view of the replay before playing it (the camera jumps
/// from one to the next meanwhile), with how much is loaded.
private struct ReplayLoadingCover: View {
    let progress: RouteReplayProgress

    var body: some View {
        let loading = progress.loading
        ZStack {
            if let loading {
                ZStack {
                    Rectangle().fill(.thickMaterial)
                    VStack(spacing: DS.Spacing.s) {
                        ProgressRing(fraction: loading, lineWidth: 3.5)
                            .frame(width: 34, height: 34)
                        Text("Cargando el mapa…")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                // On at once (the camera starts jumping right away), fading out when the replay starts
                .transition(.asymmetric(insertion: .identity, removal: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.35), value: loading == nil)
        .allowsHitTesting(false)
        .accessibilityHidden(loading == nil)
    }
}

/// A ring that fills clockwise from the top.
struct ProgressRing: View {
    let fraction: Double
    var lineWidth: CGFloat = 4
    var tint: Color = .brand
    var track: Color = Color.primary.opacity(0.12)

    var body: some View {
        ZStack {
            Circle()
                .stroke(track, lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: min(1, max(0.01, fraction)))
                .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.linear(duration: 0.2), value: fraction)
        }
        .padding(lineWidth / 2)
        .accessibilityElement()
        .accessibilityValue("\(Int((fraction * 100).rounded())) %")
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
