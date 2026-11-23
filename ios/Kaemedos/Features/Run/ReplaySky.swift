import CoreLocation
import Foundation

// MARK: - The activity behind a replay

/// Which activity a replay shows: its route on the server (for its profile) and when it was run
/// (for the sun's light and the weather of that day).
struct ReplayActivity: Equatable {
    var routeId: String?
    var start: Date?
    var end: Date?

    init(routeId: String?, start: Date?, end: Date?) {
        self.routeId = routeId
        self.start = start
        self.end = end
    }

    init(route: RunRoute) {
        let start = route.startDate
        let end = APIDate.parse(route.completedAt) ?? start.map { $0.addingTimeInterval(Double(route.duration)) }
        self.init(routeId: route.id, start: start, end: end)
    }

    /// When the runner had run `fraction` (0...1) of the route (the time spread over the distance).
    func date(atFraction fraction: Double) -> Date? {
        guard let start else { return nil }
        guard let end, end > start else { return start }
        return start.addingTimeInterval(end.timeIntervalSince(start) * min(1, max(0, fraction)))
    }
}

// MARK: - The sun

/// Where the sun is in the sky (NOAA's solar position equations): checked against real sunrise and
/// sunset times, to within 2 minutes.
enum SunPosition {
    /// The sun's elevation above the horizon (degrees; negative below it) at `coordinate` and `date`.
    static func elevation(at coordinate: CLLocationCoordinate2D, date: Date) -> Double {
        let radians = Double.pi / 180
        let julianDay = date.timeIntervalSince1970 / 86_400 + 2_440_587.5
        let t = (julianDay - 2_451_545) / 36_525
        let meanLongitude = (280.46646 + t * (36_000.76983 + t * 0.0003032)).truncatingRemainder(dividingBy: 360)
        let meanAnomaly = 357.52911 + t * (35_999.05029 - 0.0001537 * t)
        let eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
        let m = meanAnomaly * radians
        let center = sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) + sin(2 * m) * (0.019993 - 0.000101 * t) + sin(3 * m) * 0.000289
        let omega = (125.04 - 1934.136 * t) * radians
        let longitude = (meanLongitude + center - 0.00569 - 0.00478 * sin(omega)) * radians
        let obliquity0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
        let obliquity = (obliquity0 + 0.00256 * cos(omega)) * radians
        let declination = asin(sin(obliquity) * sin(longitude))
        let y = pow(tan(obliquity / 2), 2)
        let l0 = meanLongitude * radians
        let equationOfTime = 4 / radians * (y * sin(2 * l0) - 2 * eccentricity * sin(m) + 4 * eccentricity * y * sin(m) * cos(2 * l0)
            - 0.5 * y * y * sin(4 * l0) - 1.25 * eccentricity * eccentricity * sin(2 * m))
        let minutes = (julianDay + 0.5).truncatingRemainder(dividingBy: 1) * 1440
        var trueSolarTime = (minutes + equationOfTime + 4 * coordinate.longitude).truncatingRemainder(dividingBy: 1440)
        if trueSolarTime < 0 { trueSolarTime += 1440 }
        var hourAngle = trueSolarTime / 4 - 180
        if hourAngle < -180 { hourAngle += 360 }
        let latitude = coordinate.latitude * radians
        let cosZenith = sin(latitude) * sin(declination) + cos(latitude) * cos(declination) * cos(hourAngle * radians)
        return 90 - acos(min(1, max(-1, cosZenith))) / radians
    }

    /// Mapbox Standard's light for the sun at `coordinate` and `date`: day above 6°, night below
    /// −6°, and in between dawn while it rises or dusk while it sets.
    static func lightPreset(at coordinate: CLLocationCoordinate2D, date: Date) -> String {
        let now = elevation(at: coordinate, date: date)
        if now > 6 { return "day" }
        if now < -6 { return "night" }
        let later = elevation(at: coordinate, date: date.addingTimeInterval(600))
        return later > now ? "dawn" : "dusk"
    }
}
