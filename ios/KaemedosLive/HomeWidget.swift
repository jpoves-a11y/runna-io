import SwiftUI
import WidgetKit

// Home-screen and lock-screen widget: my area, my place in my city, the last steal against me and
// the competition. Reads GET /api/widget/summary with the session the app shares (SharedSession).

struct SummaryEntry: TimelineEntry {
    let date: Date
    let summary: WidgetSummary?
    /// No session in the shared keychain: the user isn't signed in (or hasn't opened the app since updating)
    let signedOut: Bool
}

struct SummaryProvider: TimelineProvider {
    private static let cacheKey = "widget.summary"

    func placeholder(in context: Context) -> SummaryEntry {
        SummaryEntry(date: Date(), summary: .placeholder, signedOut: false)
    }

    func getSnapshot(in context: Context, completion: @escaping (SummaryEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        completion(SummaryEntry(date: Date(), summary: Self.cached() ?? .placeholder, signedOut: false))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SummaryEntry>) -> Void) {
        Task {
            let next = Date().addingTimeInterval(30 * 60)
            guard SharedSession.load() != nil else {
                completion(Timeline(entries: [SummaryEntry(date: Date(), summary: nil, signedOut: true)], policy: .after(next)))
                return
            }
            var summary: WidgetSummary?
            do {
                summary = try await WidgetSummary.fetch()
                if let summary { Self.store(summary) }
            } catch {
                summary = Self.cached() // offline: the last one
            }
            completion(Timeline(entries: [SummaryEntry(date: Date(), summary: summary, signedOut: summary == nil)], policy: .after(next)))
        }
    }

    private static func cached() -> WidgetSummary? {
        guard let data = UserDefaults.standard.data(forKey: cacheKey) else { return nil }
        return try? JSONDecoder().decode(WidgetSummary.self, from: data)
    }

    private static func store(_ summary: WidgetSummary) {
        if let data = try? JSONEncoder().encode(summary) { UserDefaults.standard.set(data, forKey: cacheKey) }
    }
}

struct HomeSummaryWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KaemedosSummary", provider: SummaryProvider()) { entry in
            HomeSummaryView(entry: entry)
                .containerBackground(for: .widget) { Color(uiColor: .systemBackground) }
                .widgetURL(URL(string: "runnaio://tab/map"))
        }
        .configurationDisplayName("Tu territorio")
        .description("Tu área, tu puesto en tu ciudad y si alguien te ha robado.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Views

private let brand = Color(red: 0x0E / 255, green: 0x8A / 255, blue: 0x5F / 255)
private let steal = Color(red: 0xE1 / 255, green: 0x4D / 255, blue: 0x2A / 255)

enum WidgetFormat {
    static func area(_ m2: Double) -> String {
        let km2 = m2 / 1_000_000
        let digits = km2 < 10 ? 2 : 1
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "es_ES")
        formatter.minimumFractionDigits = digits
        formatter.maximumFractionDigits = digits
        return "\(formatter.string(from: NSNumber(value: km2)) ?? "0") km²"
    }

    static func date(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let full = ISO8601DateFormatter()
        full.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = full.date(from: iso) { return date }
        let plain = ISO8601DateFormatter()
        if let date = plain.date(from: iso) { return date }
        // SQLite "YYYY-MM-DD HH:MM:SS" (UTC)
        let sqlite = DateFormatter()
        sqlite.locale = Locale(identifier: "en_US_POSIX")
        sqlite.timeZone = TimeZone(identifier: "UTC")
        sqlite.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return sqlite.date(from: iso)
    }

    static func ago(_ iso: String) -> String {
        guard let date = date(iso) else { return "" }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "es_ES")
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

struct HomeSummaryView: View {
    let entry: SummaryEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let summary = entry.summary {
            switch family {
            case .systemMedium: medium(summary)
            case .accessoryRectangular: rectangular(summary)
            case .accessoryCircular: circular(summary)
            case .accessoryInline: Text("\(WidgetFormat.area(summary.area))\(summary.cityRank.map { " · #\($0)" } ?? "")")
            default: small(summary)
            }
        } else {
            signedOut
        }
    }

    private var signedOut: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: "figure.run")
                .font(.title2)
                .foregroundStyle(brand)
            Text("Abre KM2 e inicia sesión para ver tu territorio.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func areaBlock(_ summary: WidgetSummary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Tu territorio")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(WidgetFormat.area(summary.area))
                .font(.system(size: 24, weight: .bold).width(.condensed))
                .foregroundStyle(brand)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            if let rank = summary.cityRank, let city = summary.city {
                Text("#\(rank) en \(city)")
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
            }
        }
    }

    private func small(_ summary: WidgetSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            areaBlock(summary)
            Spacer(minLength: 0)
            if let theft = summary.lastSteal {
                Label("\(theft.by) te ha robado", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(steal)
                    .lineLimit(2)
            } else if summary.streakDays > 0 {
                Label("Racha de \(summary.streakDays) \(summary.streakDays == 1 ? "día" : "días")", systemImage: "flame.fill")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func medium(_ summary: WidgetSummary) -> some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                areaBlock(summary)
                Spacer(minLength: 0)
                if summary.streakDays > 0 {
                    Label("\(summary.streakDays) \(summary.streakDays == 1 ? "día" : "días") seguidos", systemImage: "flame.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.orange)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .leading, spacing: 8) {
                if let theft = summary.lastSteal {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Te han robado")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(steal)
                        Text("\(theft.by) · \(WidgetFormat.area(theft.area))")
                            .font(.caption.weight(.semibold))
                            .lineLimit(1)
                        Text(WidgetFormat.ago(theft.at))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                if let competition = summary.competition, let rank = competition.rank {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Competición")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text("\(rank).º de \(competition.participants)")
                            .font(.caption.weight(.semibold))
                        if let end = WidgetFormat.date(summary.nextChangeAt), end > Date() {
                            Text("Acaba \(end, style: .relative)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                } else if summary.lastSteal == nil {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(summary.phase == "competition" ? "Competición en marcha" : "Descanso")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                        if let next = WidgetFormat.date(summary.nextChangeAt), next > Date() {
                            Text(summary.phase == "competition" ? "Acaba \(next, style: .relative)" : "Empieza \(next, style: .relative)")
                                .font(.caption.weight(.semibold))
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func rectangular(_ summary: WidgetSummary) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("KM2")
                .font(.caption2.weight(.semibold))
            Text("\(WidgetFormat.area(summary.area))\(summary.cityRank.map { " · #\($0)" } ?? "")")
                .font(.headline)
                .lineLimit(1)
            if let theft = summary.lastSteal {
                Text("\(theft.by) te ha robado")
                    .font(.caption2)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func circular(_ summary: WidgetSummary) -> some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: "figure.run")
                    .font(.caption2)
                Text(summary.cityRank.map { "#\($0)" } ?? String(format: "%.1f", summary.area / 1_000_000))
                    .font(.system(size: 14, weight: .bold))
                    .minimumScaleFactor(0.6)
            }
        }
    }
}
