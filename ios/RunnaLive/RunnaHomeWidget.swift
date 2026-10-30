import SwiftUI
import UIKit
import WidgetKit

// Home and lock screen widgets:
// - Liga semanal (medium, large): your friends' week as coloured bars with their pictures.
// - Tu semana (small + lock screen): ring against the leader, km, runs and the week day by day.
// - Mi territorio (medium, large): map of your territory with castles and zones wearing away.
// - Defiende (small): the zone you need to run through soon, or your streak; opens the run screen.
// They fetch GET /api/widget/summary by themselves every ~30 minutes (WidgetData.swift).

// MARK: - Timeline

struct RunnaWidgetEntry: TimelineEntry {
    let date: Date
    let summary: WidgetSummary?
    var avatars: [String: UIImage] = [:]
    var map: UIImage? = nil
}

struct RunnaWidgetProvider: TimelineProvider {
    enum Extras { case none, avatars, map, focusMap }
    let extras: Extras

    func placeholder(in context: Context) -> RunnaWidgetEntry {
        RunnaWidgetEntry(date: Date(), summary: .sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (RunnaWidgetEntry) -> Void) {
        if context.isPreview {
            completion(RunnaWidgetEntry(date: Date(), summary: .sample))
            return
        }
        Task { completion(await entry(context)) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RunnaWidgetEntry>) -> Void) {
        Task {
            let entry = await entry(context)
            // Every 30 minutes, and right when the week turns over
            var next = Date().addingTimeInterval(30 * 60)
            if let end = entry.summary?.weekEndDate, end > Date() { next = min(next, end.addingTimeInterval(60)) }
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }

    private func entry(_ context: Context) async -> RunnaWidgetEntry {
        guard let summary = await WidgetDataLoader.load() else {
            return RunnaWidgetEntry(date: Date(), summary: nil)
        }
        var entry = RunnaWidgetEntry(date: Date(), summary: summary)
        switch extras {
        case .none:
            break
        case .avatars:
            entry.avatars = await WidgetAvatars.load(summary.week.entries.map { (id: $0.id, url: $0.avatarUrl) })
        case .map:
            entry.map = await WidgetMapRenderer.render(summary, size: context.displaySize)
        case .focusMap:
            if let point = summary.defense.atRisk {
                entry.map = await WidgetMapRenderer.render(summary, size: context.displaySize, focus: point.coordinate)
            }
        }
        return entry
    }
}

// MARK: - Widgets

struct RunnaLeagueWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RunnaLeagueWidget", provider: RunnaWidgetProvider(extras: .avatars)) { entry in
            WidgetFrame(entry: entry, url: "runnaio://tab/rankings") { summary in
                LeagueView(summary: summary, avatars: entry.avatars, date: entry.date)
            }
        }
        .configurationDisplayName("Liga semanal")
        .description("Lo que ha conquistado esta semana cada uno de tus amigos.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

/// Kept as "RunnaHomeWidget" so widgets already placed keep working.
struct RunnaHomeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RunnaHomeWidget", provider: RunnaWidgetProvider(extras: .none)) { entry in
            WidgetFrame(entry: entry, url: "runnaio://tab/rankings") { summary in
                MyWeekView(summary: summary, date: entry.date)
            }
        }
        .configurationDisplayName("Tu semana")
        .description("Tu territorio de la semana, tu puesto y cada día de un vistazo.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct RunnaTerritoryWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RunnaTerritoryWidget", provider: RunnaWidgetProvider(extras: .map)) { entry in
            WidgetFrame(entry: entry, url: "runnaio://tab/map", mapBackground: entry.map) { summary in
                TerritoryView(summary: summary, hasMap: entry.map != nil)
            }
        }
        .configurationDisplayName("Mi territorio")
        .description("El mapa de tu territorio con tus castillos y las zonas que se desgastan.")
        .supportedFamilies([.systemMedium, .systemLarge])
        .contentMarginsDisabled()
    }
}

struct RunnaDefendWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RunnaDefendWidget", provider: RunnaWidgetProvider(extras: .focusMap)) { entry in
            WidgetFrame(entry: entry, url: "runnaio://run", mapBackground: entry.map) { summary in
                DefendView(summary: summary, date: entry.date, hasMap: entry.map != nil)
            }
        }
        .configurationDisplayName("Defiende")
        .description("La zona que tienes que pisar pronto, o tu racha. Tócalo para empezar a correr.")
        .supportedFamilies([.systemSmall])
    }
}

// MARK: - Frame

/// Background (your colour, or the map), the tap destination and the logged-out state.
private struct WidgetFrame<Content: View>: View {
    let entry: RunnaWidgetEntry
    let url: String
    var mapBackground: UIImage? = nil
    @ViewBuilder let content: (WidgetSummary) -> Content
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Group {
            if let summary = entry.summary {
                content(summary)
            } else {
                LoggedOutView()
            }
        }
        .widgetURL(URL(string: url))
        .containerBackground(for: .widget) {
            background
        }
    }

    @ViewBuilder
    private var background: some View {
        if let mapBackground {
            Image(uiImage: mapBackground)
                .resizable()
                .scaledToFill()
        } else if isAccessory {
            Color.clear
        } else {
            let tint = WStyle.color(entry.summary?.me.color ?? "#16A34A")
            LinearGradient(
                colors: [tint.opacity(0.28), Color(uiColor: .systemBackground)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }

    private var isAccessory: Bool {
        family == .accessoryCircular || family == .accessoryRectangular || family == .accessoryInline
    }
}

private struct LoggedOutView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryInline:
            Text("Runna.io")
        case .accessoryCircular:
            Image(systemName: "figure.run")
        default:
            VStack(alignment: .leading, spacing: 6) {
                Label("Runna.io", systemImage: "figure.run")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Text("Abre Runna.io e inicia sesión para ver tu territorio aquí.")
                    .font(.footnote.weight(.medium))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

// MARK: - Style

enum WStyle {
    static func color(_ hex: String) -> Color {
        Color(uiColor: UIColor(widgetHex: hex) ?? .systemGreen)
    }

    static func number(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight).width(.condensed)
    }

    /// "0,42 km²" / "3.400 m²"
    static func area(_ value: Double) -> String { RunnaWidgetSnapshot.areaText(value) }

    /// "12,4 km"
    static func distance(_ value: Double) -> String { RunnaWidgetSnapshot.distanceText(value) }

    static let label = Font.system(size: 11, weight: .semibold)
}

/// Round picture, or the initials on the player's colour.
private struct WidgetAvatar: View {
    let name: String
    let color: Color
    let image: UIImage?
    var size: CGFloat = 22

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Text(String(name.prefix(1)).uppercased())
                    .font(.system(size: size * 0.48, weight: .bold))
                    .foregroundStyle(Color.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(color)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(color, lineWidth: 1.5))
    }
}

// MARK: - Liga semanal

private struct LeagueView: View {
    let summary: WidgetSummary
    let avatars: [String: UIImage]
    let date: Date
    @Environment(\.widgetFamily) private var family

    private var rows: [WidgetSummary.Entry] {
        let limit = family == .systemLarge ? 6 : 4
        var shown = Array(summary.week.entries.prefix(limit))
        if let me = summary.myEntry, !shown.contains(where: { $0.isMe }), !shown.isEmpty {
            shown[shown.count - 1] = me
        }
        return shown
    }

    private var maxArea: Double { max(summary.week.entries.map(\.area).max() ?? 0, 1) }

    var body: some View {
        VStack(alignment: .leading, spacing: family == .systemLarge ? 10 : 6) {
            HStack {
                Text("🏆 Liga semanal")
                    .font(.subheadline.weight(.bold))
                Spacer()
                let left = summary.daysLeft(at: date)
                Text(left <= 1 ? "último día" : "quedan \(left) d")
                    .font(WStyle.label)
                    .foregroundStyle(.secondary)
            }
            if summary.week.players <= 1 {
                Spacer(minLength: 0)
                Text("Añade amigos en Runna.io para competir cada semana.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            } else {
                VStack(spacing: family == .systemLarge ? 9 : 5) {
                    ForEach(rows) { row in
                        LeagueRow(entry: row, maxArea: maxArea, avatar: avatars[row.id], large: family == .systemLarge)
                    }
                }
                Spacer(minLength: 0)
                if let footer {
                    Text(footer)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
        }
    }

    /// "Te faltan 0,11 km² para pasar a Ana" / "Vas primero"
    private var footer: String? {
        guard let me = summary.myEntry else { return nil }
        if me.rank == 1 {
            return me.area > 0 ? "🏆 Vas primero esta semana" : nil
        }
        guard let ahead = summary.week.entries.first(where: { $0.rank == me.rank - 1 }) else { return nil }
        let gap = max(0, ahead.area - me.area) + 1
        return "Te faltan \(WStyle.area(gap)) para pasar a \(ahead.name)"
    }
}

private struct LeagueRow: View {
    let entry: WidgetSummary.Entry
    let maxArea: Double
    let avatar: UIImage?
    let large: Bool

    var body: some View {
        let color = WStyle.color(entry.color)
        HStack(spacing: 6) {
            Text("\(entry.rank)")
                .font(WStyle.number(12))
                .foregroundStyle(.secondary)
                .frame(width: 12, alignment: .trailing)
            WidgetAvatar(name: entry.name, color: color, image: avatar, size: large ? 24 : 20)
            Text(entry.name)
                .font(.system(size: 12, weight: entry.isMe ? .bold : .medium))
                .lineLimit(1)
                .frame(width: large ? 70 : 56, alignment: .leading)
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.08))
                    Capsule()
                        .fill(color.opacity(entry.isMe ? 1 : 0.85))
                        .frame(width: entry.area > 0 ? max(6, proxy.size.width * entry.area / maxArea) : 0)
                }
            }
            .frame(height: large ? 10 : 8)
            Text(WStyle.area(entry.area))
                .font(WStyle.number(12))
                .monospacedDigit()
                .lineLimit(1)
                .frame(width: 62, alignment: .trailing)
            movement
                .frame(width: 10)
        }
        .padding(.vertical, entry.isMe ? 2 : 0)
        .background {
            if entry.isMe {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(color.opacity(0.14))
                    .padding(.horizontal, -4)
            }
        }
    }

    @ViewBuilder
    private var movement: some View {
        if let move = entry.movement, move != 0 {
            Image(systemName: move > 0 ? "arrowtriangle.up.fill" : "arrowtriangle.down.fill")
                .font(.system(size: 7))
                .foregroundStyle(move > 0 ? Color.green : Color.red)
        } else {
            Color.clear
        }
    }
}

// MARK: - Tu semana

private struct MyWeekView: View {
    let summary: WidgetSummary
    let date: Date
    @Environment(\.widgetFamily) private var family

    private var color: Color { WStyle.color(summary.me.color) }
    private var rankText: String { summary.week.myRank.map { "\($0).º" } ?? "–" }
    /// How far you are from the leader (full when you lead).
    private var progress: Double {
        let leader = summary.week.leaderArea
        guard leader > 0 else { return summary.week.myArea > 0 ? 1 : 0 }
        return min(1, summary.week.myArea / leader)
    }

    var body: some View {
        switch family {
        case .accessoryCircular:
            Gauge(value: progress) {
                Image(systemName: "figure.run")
            } currentValueLabel: {
                Text(rankText)
            }
            .gaugeStyle(.accessoryCircularCapacity)
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Label("Runna · semana", systemImage: "figure.run")
                    .font(.caption2.weight(.semibold))
                Text("\(rankText) · +\(WStyle.area(summary.week.myArea))")
                    .font(.headline)
                    .lineLimit(1)
                if let leader = summary.leader, !leader.isMe, leader.area > 0 {
                    Text("\(leader.name) \(WStyle.area(leader.area))")
                        .font(.caption2)
                        .lineLimit(1)
                } else {
                    Text("\(WStyle.distance(summary.week.myDistance)) · \(summary.week.myRuns) carreras")
                        .font(.caption2)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .accessoryInline:
            Text("🏃 \(rankText) esta semana · +\(WStyle.area(summary.week.myArea))")
        default:
            small
        }
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Esta semana")
                    .font(WStyle.label)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(rankText)
                    .font(WStyle.number(15, weight: .bold))
                    .foregroundStyle(summary.week.myRank == 1 ? Color.orange : Color.primary)
            }
            HStack(spacing: 8) {
                ZStack {
                    Circle().stroke(color.opacity(0.2), lineWidth: 6)
                    Circle()
                        .trim(from: 0, to: progress)
                        .stroke(color, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                    Image(systemName: "flag.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(color)
                }
                .frame(width: 48, height: 48)
                VStack(alignment: .leading, spacing: 1) {
                    Text(WStyle.area(summary.week.myArea))
                        .font(WStyle.number(17, weight: .bold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    Text("\(WStyle.distance(summary.week.myDistance)) · \(summary.week.myRuns)🏃")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            DayBars(summary: summary, date: date, color: color)
        }
    }
}

/// L M X J V S D: what you conquered (or ran) each day, today outlined.
private struct DayBars: View {
    let summary: WidgetSummary
    let date: Date
    let color: Color
    private let letters = ["L", "M", "X", "J", "V", "S", "D"]

    var body: some View {
        // Area when you conquered something this week, else distance
        let values = summary.week.days.contains(where: { $0 > 0 }) ? summary.week.days : summary.week.dayDistance
        let top = max(values.max() ?? 0, 1)
        let today = todayIndex
        HStack(alignment: .bottom, spacing: 4) {
            ForEach(0..<7, id: \.self) { index in
                let value = index < values.count ? values[index] : 0
                VStack(spacing: 2) {
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(value > 0 ? color : Color.primary.opacity(0.12))
                        .frame(height: value > 0 ? max(4, 22 * value / top) : 3)
                    Text(letters[index])
                        .font(.system(size: 8, weight: index == today ? .bold : .medium))
                        .foregroundStyle(index == today ? Color.primary : Color.secondary)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .frame(height: 34, alignment: .bottom)
    }

    private var todayIndex: Int {
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = TimeZone(identifier: "Europe/Madrid") ?? .current
        let weekday = calendar.component(.weekday, from: date) // 1 = Sunday
        return (weekday + 5) % 7
    }
}

// MARK: - Mi territorio

private struct TerritoryView: View {
    let summary: WidgetSummary
    let hasMap: Bool
    @Environment(\.widgetFamily) private var family

    var body: some View {
        VStack(alignment: .leading) {
            HStack {
                Label("Mi territorio", systemImage: "map.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.black.opacity(0.45), in: Capsule())
                Spacer()
            }
            Spacer(minLength: 0)
            if hasMap {
                stats
            } else {
                Text("Aún no tienes territorio: rodea una zona corriendo para conquistarla.")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.white)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            if !hasMap { Color.black.opacity(0.85) }
        }
    }

    private var stats: some View {
        HStack(alignment: .bottom, spacing: 12) {
            VStack(alignment: .leading, spacing: 0) {
                Text(WStyle.area(summary.me.totalArea))
                    .font(WStyle.number(family == .systemLarge ? 28 : 22, weight: .bold))
                Text("conquistados")
                    .font(.system(size: 10, weight: .semibold))
                    .opacity(0.8)
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 2) {
                if summary.defense.castles > 0 {
                    Text("🏰 \(summary.defense.castles) \(summary.defense.castles == 1 ? "zona" : "zonas") · \(summary.defense.castleLayers) castillos")
                }
                if summary.defense.weakArea > 0 {
                    Text("🍂 \(WStyle.area(summary.defense.weakArea)) se desgastan")
                } else if summary.defense.atRiskArea > 0 {
                    Text("⏳ \(WStyle.area(summary.defense.atRiskArea)) en 2 días")
                }
            }
            .font(.system(size: 11, weight: .semibold))
            .lineLimit(1)
        }
        .foregroundStyle(Color.white)
        .padding(10)
        .background(
            LinearGradient(colors: [Color.black.opacity(0.0), Color.black.opacity(0.7)], startPoint: .top, endPoint: .bottom)
                .padding(-12)
        )
    }
}

// MARK: - Defiende

private struct DefendView: View {
    let summary: WidgetSummary
    let date: Date
    let hasMap: Bool

    private var defense: WidgetSummary.Defense { summary.defense }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            content
            Spacer(minLength: 0)
            HStack(spacing: 4) {
                Image(systemName: "figure.run")
                Text("Correr")
            }
            .font(.caption.weight(.bold))
            .foregroundStyle(Color.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(WStyle.color(summary.me.color), in: Capsule())
        }
        .foregroundStyle(hasMap ? Color.white : Color.primary)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            if hasMap {
                LinearGradient(colors: [Color.black.opacity(0.65), Color.black.opacity(0.15), Color.black.opacity(0.55)], startPoint: .top, endPoint: .bottom)
                    .padding(-16)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if defense.resting {
            Text("😴 En descanso")
                .font(.subheadline.weight(.bold))
            Text("Tu territorio no se desgasta mientras descansas.")
                .font(.caption2)
                .opacity(0.8)
        } else if defense.weakArea > 0 || defense.atRiskArea > 0 {
            Text(defense.weakArea > 0 ? "🍂 Se desgasta" : "⏳ Defiende")
                .font(.subheadline.weight(.bold))
            Text(WStyle.area(defense.weakArea > 0 ? defense.weakArea : defense.atRiskArea))
                .font(WStyle.number(22, weight: .bold))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(defense.weakArea > 0 ? "sin pisar más de 14 días" : "empiezan a desgastarse en 2 días")
                .font(.caption2)
                .opacity(0.85)
                .lineLimit(2)
        } else {
            Text(summary.streakWeeks >= 2 ? "🔥 \(summary.streakWeeks) semanas" : "🏃 Tu racha")
                .font(.subheadline.weight(.bold))
            Text(summary.streakWeeks >= 2 ? "corriendo cada semana" : "Corre esta semana para empezarla")
                .font(.caption2)
                .opacity(0.85)
                .lineLimit(2)
            Text(lastRunText)
                .font(.caption.weight(.semibold))
                .foregroundStyle((summary.daysSinceRun(at: date) ?? 0) >= 4 ? Color.orange : Color.secondary)
                .lineLimit(1)
                .padding(.top, 2)
        }
    }

    private var lastRunText: String {
        guard let days = summary.daysSinceRun(at: date) else { return "Aún no has corrido" }
        switch days {
        case ..<1: return "Hoy has corrido"
        case 1: return "Corriste ayer"
        default: return "Hace \(days) días que no corres"
        }
    }
}
