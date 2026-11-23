import CoreLocation
import Foundation
import WeatherKit

// MARK: - What a replay adds from the activity

/// A point of the altitude profile.
struct ReplayElevationPoint: Equatable {
    /// km from the start
    let km: Double
    /// metres
    let metres: Double
}

/// One hour of the weather of the activity's day and place.
struct ReplayWeatherHour: Equatable {
    enum Kind: Equatable {
        case dry
        case rain
        case snow
    }

    let date: Date
    let kind: Kind
    /// mm that fell in the hour
    let amount: Double
    /// How thick the fog was: 0 none ... 1 dense
    var fog: Double = 0

    /// Rain, snow or fog: something shows on the glass.
    var showsSomething: Bool { kind != .dry || fog > 0 }
}

/// What the replay shows besides the route: the pace of each km (km markers), the altitude profile,
/// and the weather while it was run (rain or snow). Empty where unknown.
struct ReplayExtras: Equatable {
    /// s/km of each km, in order (the last one may be partial)
    var kmPaces: [Double] = []
    var elevation: [ReplayElevationPoint] = []
    var weather: [ReplayWeatherHour] = []
    /// Apple Weather's legal page (its attribution is required where its data shows)
    var weatherLegalURL: URL?

    /// The weather at `date` (the hour it falls in), if it rained or snowed then, or there was fog.
    func weather(at date: Date) -> ReplayWeatherHour? {
        guard let hour = weather.last(where: { $0.date <= date }) ?? weather.first,
              abs(hour.date.timeIntervalSince(date)) < 2 * 3600 else { return nil }
        return hour.showsSomething ? hour : nil
    }

    /// Whether any weather effect will show.
    var hasWeather: Bool { weather.contains { $0.showsSomething } }

    /// Whether it rained or snowed at some point (the boxes over the map then stand out of the glass).
    var hasPrecipitation: Bool { weather.contains { $0.kind != .dry } }
}

/// Loads a replay's extras once per activity: the route's profile from the server and, if the
/// activity has a date, its weather from WeatherKit (historical hours, since August 2021).
@MainActor
enum ReplayExtrasLoader {
    private static var cache: [String: ReplayExtras] = [:]
    /// WeatherKit has history from August 1, 2021
    private static let weatherHistoryStart = Date(timeIntervalSince1970: 1_627_776_000)

    static func load(_ activity: ReplayActivity, center: CLLocationCoordinate2D) async -> ReplayExtras {
        let key = "\(activity.routeId ?? "-")|\(activity.start?.timeIntervalSince1970 ?? 0)"
        if let cached = cache[key] { return cached }
        var extras = ReplayExtras()
        if let routeId = activity.routeId,
           let profile: ActivityProfile = try? await APIClient.shared.request("GET", "/api/routes/\(routeId)/profile") {
            extras.kmPaces = profile.splits.sorted { $0.index < $1.index }.map(\.pace)
            if profile.hasElevation {
                extras.elevation = profile.series.compactMap { sample in
                    sample.e.map { ReplayElevationPoint(km: sample.d, metres: $0) }
                }
            }
        }
        if let start = activity.start, start > weatherHistoryStart, CLLocationCoordinate2DIsValid(center) {
            let end = max(activity.end ?? start, start)
            extras.weather = await weather(at: center, from: start.addingTimeInterval(-3600), to: end.addingTimeInterval(3600))
            if extras.hasWeather {
                extras.weatherLegalURL = try? await WeatherService.shared.attribution.legalPageURL
            }
        }
        if Task.isCancelled { return extras }
        cache[key] = extras
        return extras
    }

    /// Hourly rain and snow at `center` between two dates (nothing if WeatherKit isn't available).
    private static func weather(at center: CLLocationCoordinate2D, from start: Date, to end: Date) async -> [ReplayWeatherHour] {
        do {
            let location = CLLocation(latitude: center.latitude, longitude: center.longitude)
            let hours = try await WeatherService.shared.weather(for: location, including: .hourly(startDate: start, endDate: end))
            return hours.map { hour in
                let amount = hour.precipitationAmount.converted(to: .millimeters).value
                let kind: ReplayWeatherHour.Kind
                switch hour.precipitation {
                case .snow, .sleet, .mixed:
                    kind = .snow
                case .rain, .hail:
                    kind = .rain
                default:
                    kind = .dry
                }
                return ReplayWeatherHour(date: hour.date, kind: amount >= 0.1 ? kind : .dry, amount: amount, fog: fog(in: hour))
            }
        } catch {
            return []
        }
    }

    /// How thick the fog was in an hour: Apple Weather calls it fog, or one can't see far. Haze,
    /// smoke and blowing dust are left out: they aren't cloud on the ground.
    private static func fog(in hour: HourWeather) -> Double {
        let metres = hour.visibility.converted(to: .meters).value
        if hour.condition == .foggy {
            // Fog is under 1 km by definition; denser the less one sees
            return metres < 200 ? 1 : (metres < 600 ? 0.85 : 0.7)
        }
        // Mist: damp air one sees 1 to 3 km through
        if hour.precipitation == .none, hour.humidity >= 0.92, metres > 0, metres < 3000 {
            return metres < 1000 ? 0.7 : 0.4
        }
        return 0
    }
}
