import MapKit
import UIKit

/// Where a coordinate is on screen *on the ground*, as MapKit drapes the route's line over the 3D
/// terrain, so the runner's flag stands exactly at the end of the line.
///
/// MapKit doesn't tell: `convert` projects at sea level (on high ground the line is far from it:
/// ~90 points in Turin) and annotations sit on the 3D model of buildings and trees. So MapKit's 3D
/// camera is worked out from `convert` itself:
/// - Lens: on still frames (while the map loads its views behind the cover, and each frame of a
///   video once it's drawn), `convert` of sea-level points across the view is matched by a camera
///   with MapKit's pitch, heading and distance, solving its lens, the screen point it looks through
///   and the height of the ground under the centre (MapKit looks at the centre on the ground).
///   Checked in a simulation of such a camera at any height, heading, pitch and screen centre.
/// - Ground: those heights, and a survey of the whole route behind the cover (the camera stopping
///   every few tens of metres along it), make a map of the ground's height along the route.
/// - Each frame: the ground the camera looks at is measured again with the lens known (MapKit may
///   ease its camera over the terrain), and the coordinate is projected at its own height in the map,
///   not the camera's (the runner can be well off the centre, higher or lower).
@MainActor
final class ReplayGroundModel {
    private struct Sample {
        let coordinate: CLLocationCoordinate2D
        let height: Double
    }

    private struct Lens {
        /// points
        let focal: Double
        /// Screen point the camera looks through, from the view's middle (points)
        let principal: (x: Double, y: Double)
    }

    /// A sea-level point (metres from the camera's centre) and where `convert` puts it (points from
    /// the view's middle).
    private struct Observation {
        let east: Double
        let north: Double
        let x: Double
        let y: Double
    }

    /// MapKit's camera now, in the model's terms.
    private struct Shot {
        let frame: LocalFrame
        let geometry: CameraGeometry
        let middle: (x: Double, y: Double)
        let size: CGSize

        @MainActor
        init?(_ mapView: MKMapView) {
            let camera = mapView.camera
            let bounds = mapView.bounds
            let center = camera.centerCoordinate
            guard bounds.width > 0, bounds.height > 0, camera.centerCoordinateDistance > 1, CLLocationCoordinate2DIsValid(center) else { return nil }
            frame = LocalFrame(center: center)
            geometry = CameraGeometry(distance: camera.centerCoordinateDistance, pitch: Double(camera.pitch) * .pi / 180, heading: camera.heading * .pi / 180)
            middle = (Double(bounds.midX), Double(bounds.midY))
            size = bounds.size
        }
    }

    /// Heights of the ground measured (metres, the scale of MapKit's `convert`)
    private var samples: [Sample] = []
    private var focals: [Double] = []
    private var principalXs: [Double] = []
    private var principalYs: [Double] = []
    /// Medians of the lens fits so far, for views of `lensSize` (the lens changes with it)
    private var lens: Lens?
    private var lensSize: CGSize = .zero

    private static let maxSamples = 4000
    /// Sea-level points the lens is fitted on: a 3×3 grid across the middle of the view
    private static let lensGrid: [(x: Double, y: Double)] = [
        (-0.3, -0.3), (-0.3, 0), (-0.3, 0.3),
        (0, -0.3), (0, 0), (0, 0.3),
        (0.3, -0.3), (0.3, 0), (0.3, 0.3),
    ]
    /// And the ground under the centre measured each frame (lens known): sea-level points around the
    /// centre, to its right and ahead of it (in fractions of the camera's distance)
    private static let groundCross: [(right: Double, ahead: Double)] = [(0, 0), (-0.08, 0), (0.08, 0), (0, -0.08), (0, 0.08)]

    /// Measures MapKit's camera as it's drawn now: the lens and the ground under the centre (its
    /// height, if the fit matched). Call it only on a still frame (the camera set and drawn), where
    /// `convert` can't lag behind it.
    @discardableResult
    func calibrate(on mapView: MKMapView) -> Double? {
        guard let shot = Shot(mapView) else { return nil }
        let pitch = shot.geometry.pitch
        // Near top-down, height and lens can't be told apart (and a flat map needs no model)
        guard pitch > 20 * .pi / 180 else { return nil }
        let observations = Self.observe(Self.lensGrid, on: mapView, shot: shot)
        guard observations.count >= 6 else { return nil }

        // First guess: the camera looking through the middle of the view (the scale 50 m to the
        // right of the centre gives the lens, and how far below the middle the centre's sea-level
        // point is, the height); then Gauss-Newton on lens, screen centre and ground height
        let heading = shot.geometry.heading
        let center = mapView.convert(shot.frame.center, toPointTo: mapView)
        let right = mapView.convert(shot.frame.coordinate(east: cos(heading) * 50, north: -sin(heading) * 50), toPointTo: mapView)
        guard center.x.isFinite, center.y.isFinite, right.x.isFinite, right.y.isFinite else { return nil }
        let scale = Double(hypot(right.x - center.x, right.y - center.y)) / 50
        guard scale > 0, scale.isFinite else { return nil }
        let guessHeight = (Double(center.y) - shot.middle.y) / (scale * sin(pitch))
        var parameters = [scale * (shot.geometry.distance + guessHeight * cos(pitch)), 0, 0, guessHeight]
        let steps = [0.5, 0.05, 0.05, 0.5]

        func residuals(_ p: [Double]) -> [Double]? {
            let lens = Lens(focal: p[0], principal: (p[1], p[2]))
            return Self.residuals(of: observations, shot: shot, lens: lens, groundHeight: p[3])
        }
        for _ in 0..<12 {
            guard let r = residuals(parameters) else { return nil }
            // Jacobian (numerical) and the normal equations
            var jacobian = [[Double]](repeating: [Double](repeating: 0, count: 4), count: r.count)
            for k in 0..<4 {
                var shifted = parameters
                shifted[k] += steps[k]
                guard let rk = residuals(shifted) else { return nil }
                for row in 0..<r.count {
                    jacobian[row][k] = (rk[row] - r[row]) / steps[k]
                }
            }
            var normal = [[Double]](repeating: [Double](repeating: 0, count: 4), count: 4)
            var gradient = [Double](repeating: 0, count: 4)
            for row in 0..<r.count {
                for i in 0..<4 {
                    gradient[i] += jacobian[row][i] * r[row]
                    for j in 0..<4 {
                        normal[i][j] += jacobian[row][i] * jacobian[row][j]
                    }
                }
            }
            guard let delta = Self.solve(normal, gradient) else { return nil }
            for i in 0..<4 {
                parameters[i] -= delta[i]
            }
        }
        guard let fitted = residuals(parameters) else { return nil }
        let worst = fitted.map { abs($0) }.max() ?? .infinity
        let (focal, height) = (parameters[0], parameters[3])
        // Only a fit that matches MapKit (a camera unlike the model's is left out)
        guard worst < 2.5, focal > 100, focal < 20_000, height > -500, height < 9000 else { return nil }

        addSample(at: shot.frame.center, height: height)
        if shot.size != lensSize {
            // Another size of view: another lens
            lensSize = shot.size
            focals = []
            principalXs = []
            principalYs = []
        }
        focals.append(focal)
        principalXs.append(parameters[1])
        principalYs.append(parameters[2])
        if focals.count > 400 {
            focals.removeFirst()
            principalXs.removeFirst()
            principalYs.removeFirst()
        }
        lens = Lens(focal: Self.median(focals), principal: (Self.median(principalXs), Self.median(principalYs)))
        return height
    }

    /// Screen point of `coordinate` on the ground, with the camera `mapView` has now; nil where the
    /// model can't tell (no 3D camera measured, or a flat view of it: `convert` is right there).
    func project(_ coordinate: CLLocationCoordinate2D, on mapView: MKMapView) -> CGPoint? {
        guard let shot = Shot(mapView) else { return nil }
        let offset = shot.frame.offset(of: coordinate)
        let projected: (x: Double, y: Double)?
        if let lens, shot.size == lensSize {
            // The ground the camera looks at, measured now (or from the map), and the coordinate's own
            let mapped = height(at: shot.frame.center)
            guard let groundHeight = measureGround(on: mapView, shot: shot, lens: lens, guess: mapped ?? 0) ?? mapped else { return nil }
            let pointHeight = height(at: coordinate) ?? groundHeight
            projected = shot.geometry.project(east: offset.east, north: offset.north, height: pointHeight, groundHeight: groundHeight, focal: lens.focal, principal: lens.principal)
        } else {
            projected = roughProjection(of: offset, coordinate: coordinate, on: mapView, shot: shot)
        }
        guard let point = projected else { return nil }
        let result = CGPoint(x: shot.middle.x + point.x, y: shot.middle.y + point.y)
        return result.x.isFinite && result.y.isFinite ? result : nil
    }

    /// Height of the ground at `coordinate`: from the nearest heights measured, weighted by closeness.
    func height(at coordinate: CLLocationCoordinate2D) -> Double? {
        guard !samples.isEmpty else { return nil }
        let frame = LocalFrame(center: coordinate)
        var nearest: [(distanceSquared: Double, height: Double)] = []
        nearest.reserveCapacity(5)
        for sample in samples {
            let offset = frame.offset(of: sample.coordinate)
            let distanceSquared = offset.east * offset.east + offset.north * offset.north
            if distanceSquared < 0.25 { return sample.height }
            if nearest.count < 4 {
                nearest.append((distanceSquared, sample.height))
            } else if let farthest = nearest.indices.max(by: { nearest[$0].distanceSquared < nearest[$1].distanceSquared }),
                      distanceSquared < nearest[farthest].distanceSquared {
                nearest[farthest] = (distanceSquared, sample.height)
            }
        }
        var weightSum = 0.0
        var heightSum = 0.0
        for item in nearest {
            let weight = 1 / item.distanceSquared
            weightSum += weight
            heightSum += weight * item.height
        }
        return weightSum > 0 ? heightSum / weightSum : nil
    }

    /// Surveys the ground along the route (`surveyCameras`, whose map is loaded already): each stop
    /// for a couple of screen refreshes (a few more while MapKit is still drawing), then measured.
    /// Every few stops it's measured again a moment later: if MapKit turns out to ease its camera's
    /// height over the terrain, each stop from then on waits until the camera holds still.
    /// `onProgress` gets 0...1. False if cancelled.
    func survey(_ cameras: [ReplayCamera], on mapView: MKMapView, loadState: MapLoadState, onProgress: (Double) -> Void) async -> Bool {
        guard !cameras.isEmpty else { return !Task.isCancelled }
        let clock = FrameClock()
        clock.start()
        defer { clock.stop() }
        var easing = false
        for (index, camera) in cameras.enumerated() {
            mapView.camera = camera.mkCamera
            _ = await loadState.settle(clock: clock, maxRefreshes: 6, minRefreshes: 2, calmRefreshes: 1, patience: 0.5)
            if Task.isCancelled { return false }
            var height = calibrate(on: mapView)
            if easing || index < 4 || index % 8 == 0 {
                var refreshes = 0
                while refreshes < (easing ? 24 : 2) {
                    await clock.next()
                    if Task.isCancelled { return false }
                    refreshes += 1
                    guard refreshes % 2 == 0 else { continue }
                    // The newer measurement replaces the stop's sample
                    let again = calibrate(on: mapView)
                    if let previous = height, let again {
                        if abs(again - previous) < 0.3 { break }
                        easing = true
                    }
                    height = again
                }
            }
            onProgress(Double(index + 1) / Double(cameras.count))
        }
        return true
    }

    /// The survey of the ground along the route (3D): the replay's following camera every few tens
    /// of metres of it (at most ~80 stops), centred on the route itself.
    static func surveyCameras(for timeline: RouteReplayTimeline) -> [ReplayCamera] {
        let plan = timeline.plan
        guard timeline.mode == .threeD, plan.length > 0 else { return [] }
        let stops = max(1, Int((plan.length / max(60, plan.length / 80)).rounded(.up)))
        return (0...stops).map { index in
            let distance = plan.length * Double(index) / Double(stops)
            return ReplayCamera(center: plan.coordinate(at: distance), distance: timeline.followDistance, pitch: 50, heading: plan.cameraBearing(at: distance))
        }
    }

    // MARK: Measuring

    /// Sea-level points around the camera's centre (`offsets` to its right and ahead, in fractions of
    /// the camera's distance) and where `convert` puts them: cheap enough for every frame.
    private static func observe(around offsets: [(right: Double, ahead: Double)], on mapView: MKMapView, shot: Shot) -> [Observation] {
        let heading = shot.geometry.heading
        let distance = shot.geometry.distance
        var observations: [Observation] = []
        observations.reserveCapacity(offsets.count)
        for offset in offsets {
            let east = (offset.right * cos(heading) + offset.ahead * sin(heading)) * distance
            let north = (offset.ahead * cos(heading) - offset.right * sin(heading)) * distance
            let point = mapView.convert(shot.frame.coordinate(east: east, north: north), toPointTo: mapView)
            guard point.x.isFinite, point.y.isFinite else { continue }
            observations.append(Observation(east: east, north: north, x: Double(point.x) - shot.middle.x, y: Double(point.y) - shot.middle.y))
        }
        return observations
    }

    /// Sea-level points seen at `fractions` of the view from its middle, and where `convert` puts them
    /// (on screen whatever the lens; for still frames).
    private static func observe(_ fractions: [(x: Double, y: Double)], on mapView: MKMapView, shot: Shot) -> [Observation] {
        var observations: [Observation] = []
        observations.reserveCapacity(fractions.count)
        for fraction in fractions {
            let target = CGPoint(x: shot.middle.x + fraction.x * Double(shot.size.width), y: shot.middle.y + fraction.y * Double(shot.size.height))
            let coordinate = mapView.convert(target, toCoordinateFrom: mapView)
            guard CLLocationCoordinate2DIsValid(coordinate) else { continue }
            // Where MapKit puts that coordinate (at sea level), whatever ground the point above found
            let point = mapView.convert(coordinate, toPointTo: mapView)
            let offset = shot.frame.offset(of: coordinate)
            guard point.x.isFinite, point.y.isFinite, abs(offset.east) < 100_000, abs(offset.north) < 100_000 else { continue }
            observations.append(Observation(east: offset.east, north: offset.north, x: Double(point.x) - shot.middle.x, y: Double(point.y) - shot.middle.y))
        }
        return observations
    }

    /// The model's projection of the observations minus `convert`'s (x, y of each, points).
    private static func residuals(of observations: [Observation], shot: Shot, lens: Lens, groundHeight: Double) -> [Double]? {
        var result: [Double] = []
        result.reserveCapacity(observations.count * 2)
        for observation in observations {
            guard let projected = shot.geometry.project(east: observation.east, north: observation.north, height: 0, groundHeight: groundHeight, focal: lens.focal, principal: lens.principal) else { return nil }
            result.append(projected.x - observation.x)
            result.append(projected.y - observation.y)
        }
        return result
    }

    /// Height of the ground the camera looks at in the frame now, from `convert` with the lens known
    /// (Gauss-Newton on the one unknown); nil if `convert` doesn't match the camera there.
    private func measureGround(on mapView: MKMapView, shot: Shot, lens: Lens, guess: Double) -> Double? {
        let observations = Self.observe(around: Self.groundCross, on: mapView, shot: shot)
        guard observations.count >= 3 else { return nil }
        var height = guess
        for _ in 0..<4 {
            guard let r = Self.residuals(of: observations, shot: shot, lens: lens, groundHeight: height),
                  let shifted = Self.residuals(of: observations, shot: shot, lens: lens, groundHeight: height + 1) else { return nil }
            var jj = 0.0
            var jr = 0.0
            for index in r.indices {
                let j = shifted[index] - r[index]
                jj += j * j
                jr += j * r[index]
            }
            guard jj > 1e-12 else { return nil }
            height -= jr / jj
        }
        guard let fitted = Self.residuals(of: observations, shot: shot, lens: lens, groundHeight: height),
              (fitted.map { abs($0) }.max() ?? .infinity) < 2.5, height > -500, height < 9000 else { return nil }
        return height
    }

    /// Without the lens measured (no fit matched yet): from this frame alone, taking the view's middle
    /// as the screen centre (exact for a point as high as the centre's ground).
    private func roughProjection(of offset: (east: Double, north: Double), coordinate: CLLocationCoordinate2D, on mapView: MKMapView, shot: Shot) -> (x: Double, y: Double)? {
        let pitch = shot.geometry.pitch
        guard pitch > 10 * .pi / 180 else { return nil }
        let heading = shot.geometry.heading
        let center = mapView.convert(shot.frame.center, toPointTo: mapView)
        let right = mapView.convert(shot.frame.coordinate(east: cos(heading) * 50, north: -sin(heading) * 50), toPointTo: mapView)
        let scale = Double(hypot(right.x - center.x, right.y - center.y)) / 50
        guard center.y.isFinite, scale > 0, scale.isFinite else { return nil }
        let groundHeight = (Double(center.y) - shot.middle.y) / (scale * sin(pitch))
        guard groundHeight.isFinite, groundHeight > -500, groundHeight < 9000, abs(groundHeight) > 1 else { return nil }
        let focal = scale * (shot.geometry.distance + groundHeight * cos(pitch))
        let pointHeight = height(at: coordinate) ?? groundHeight
        return shot.geometry.project(east: offset.east, north: offset.north, height: pointHeight, groundHeight: groundHeight, focal: focal, principal: (0, 0))
    }

    /// Keeps a height measured at `coordinate` (a newer one replaces one within a couple of metres).
    private func addSample(at coordinate: CLLocationCoordinate2D, height: Double) {
        let frame = LocalFrame(center: coordinate)
        if let index = samples.lastIndex(where: { sample in
            let offset = frame.offset(of: sample.coordinate)
            return offset.east * offset.east + offset.north * offset.north < 4
        }) {
            samples[index] = Sample(coordinate: coordinate, height: height)
            return
        }
        samples.append(Sample(coordinate: coordinate, height: height))
        if samples.count > Self.maxSamples {
            samples.removeFirst(samples.count - Self.maxSamples)
        }
    }

    // MARK: Helpers

    private static func median(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        return sorted[sorted.count / 2]
    }

    /// Solves a small linear system (Gaussian elimination with pivoting).
    private static func solve(_ matrix: [[Double]], _ vector: [Double]) -> [Double]? {
        var a = matrix
        var b = vector
        let n = b.count
        for column in 0..<n {
            guard let pivot = (column..<n).max(by: { abs(a[$0][column]) < abs(a[$1][column]) }), abs(a[pivot][column]) > 1e-12 else { return nil }
            a.swapAt(column, pivot)
            b.swapAt(column, pivot)
            for row in (column + 1)..<n {
                let factor = a[row][column] / a[column][column]
                for k in column..<n {
                    a[row][k] -= factor * a[column][k]
                }
                b[row] -= factor * b[column]
            }
        }
        var x = [Double](repeating: 0, count: n)
        for row in stride(from: n - 1, through: 0, by: -1) {
            var sum = b[row]
            for k in (row + 1)..<n {
                sum -= a[row][k] * x[k]
            }
            x[row] = sum / a[row][row]
        }
        return x
    }
}

/// Metres east and north around a coordinate, on the WGS 84 ellipsoid (flat: plenty for a few kilometres).
private struct LocalFrame {
    let center: CLLocationCoordinate2D
    private let metresPerDegreeLatitude: Double
    private let metresPerDegreeLongitude: Double

    init(center: CLLocationCoordinate2D) {
        self.center = center
        let phi = center.latitude * .pi / 180
        metresPerDegreeLatitude = 111_132.954 - 559.822 * cos(2 * phi) + 1.175 * cos(4 * phi)
        metresPerDegreeLongitude = max(1, 111_412.84 * cos(phi) - 93.5 * cos(3 * phi) + 0.118 * cos(5 * phi))
    }

    func coordinate(east: Double, north: Double) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: center.latitude + north / metresPerDegreeLatitude, longitude: center.longitude + east / metresPerDegreeLongitude)
    }

    func offset(of coordinate: CLLocationCoordinate2D) -> (east: Double, north: Double) {
        var longitude = coordinate.longitude - center.longitude
        if longitude > 180 { longitude -= 360 }
        if longitude < -180 { longitude += 360 }
        return (longitude * metresPerDegreeLongitude, (coordinate.latitude - center.latitude) * metresPerDegreeLatitude)
    }
}

/// A camera like MapKit's: it looks at the centre (on the ground, `groundHeight` metres up) from
/// `distance` metres, tilted `pitch` from straight down, facing `heading` (radians).
private struct CameraGeometry {
    let distance: Double
    let pitch: Double
    let heading: Double

    /// Screen offset (points, from the view's middle) of a point `east`/`north` metres from the
    /// centre and `height` metres up.
    func project(east: Double, north: Double, height: Double, groundHeight: Double, focal: Double, principal: (x: Double, y: Double)) -> (x: Double, y: Double)? {
        let forward = (x: sin(pitch) * sin(heading), y: sin(pitch) * cos(heading), z: -cos(pitch))
        let right = (x: cos(heading), y: -sin(heading))
        let up = (x: sin(heading) * cos(pitch), y: cos(heading) * cos(pitch), z: sin(pitch))
        let eye = (x: -distance * forward.x, y: -distance * forward.y, z: groundHeight - distance * forward.z)
        let v = (x: east - eye.x, y: north - eye.y, z: height - eye.z)
        let depth = v.x * forward.x + v.y * forward.y + v.z * forward.z
        guard depth > 1 else { return nil }
        let x = principal.x + focal * (v.x * right.x + v.y * right.y) / depth
        let y = principal.y - focal * (v.x * up.x + v.y * up.y + v.z * up.z) / depth
        return (x, y)
    }
}
