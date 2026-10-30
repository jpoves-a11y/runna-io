import SwiftUI
import UIKit
import WidgetKit

// Views of the home and lock screen widgets (configured in RunnaLive/RunnaHomeWidget.swift). In Shared so
// the app can draw them too: the DEBUG widget gallery (runnaio://widgets/<page>) for the CI screenshots.
// The widget family is passed in (not read from the environment) so the gallery can draw every size.

// MARK: - Entry

struct RunnaWidgetEntry: TimelineEntry {
    let date: Date
    let summary: WidgetSummary?
    var avatars: [String: UIImage] = [:]
    var map: UIImage? = nil
    /// City of the place on the map widget ("Zaragoza"), when known.
    var placeName: String? = nil
    /// Why there is no summary (shown small, to tell a logged-out phone from a failed load).
    var problem: WidgetDataLoader.Outcome? = nil
}

// MARK: - Frame

/// Background (your colour, or the map), the tap destination and the logged-out state.
struct WidgetFrame<Content: View>: View {
    let entry: RunnaWidgetEntry
    let url: String
    let mapBackground: UIImage?
    /// Set by the app's widget gallery: the family to draw, with the margins and background a widget
    /// container gives (an app has none).
    let preview: WidgetFamily?
    /// The widget turns off the system's content margins (`.contentMarginsDisabled()`).
    let marginsDisabled: Bool
    let content: (WidgetSummary, WidgetFamily) -> Content
    @Environment(\.widgetFamily) private var widgetFamily

    init(
        entry: RunnaWidgetEntry,
        url: String,
        mapBackground: UIImage? = nil,
        preview: WidgetFamily? = nil,
        marginsDisabled: Bool = false,
        @ViewBuilder content: @escaping (WidgetSummary, WidgetFamily) -> Content
    ) {
        self.entry = entry
        self.url = url
        self.mapBackground = mapBackground
        self.preview = preview
        self.marginsDisabled = marginsDisabled
        self.content = content
    }

    private var family: WidgetFamily { preview ?? widgetFamily }

    private var isAccessory: Bool {
        family == .accessoryCircular || family == .accessoryRectangular || family == .accessoryInline
    }

    var body: some View {
        if preview != nil {
            inner
                .padding(marginsDisabled || isAccessory ? 0 : 16)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background { background }
        } else {
            inner
                .widgetURL(URL(string: url))
                .containerBackground(for: .widget) { background }
        }
    }

    @ViewBuilder
    private var inner: some View {
        if let summary = entry.summary {
            content(summary, family)
        } else {
            LoggedOutView(problem: entry.problem, family: family)
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
            WidgetBackdrop(color: WStyle.color(entry.summary?.me.color ?? "#16A34A"))
        }
    }
}

/// Background of the widgets without a map: your colour washing into the system background, with a soft
/// glow in the top corner.
struct WidgetBackdrop: View {
    let color: Color

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground)
            LinearGradient(colors: [color.opacity(0.30), color.opacity(0.05)], startPoint: .topLeading, endPoint: .bottomTrailing)
            RadialGradient(colors: [color.opacity(0.22), color.opacity(0)], center: .topTrailing, startRadius: 0, endRadius: 190)
        }
    }
}

struct LoggedOutView: View {
    let problem: WidgetDataLoader.Outcome?
    let family: WidgetFamily

    private var message: String {
        switch problem {
        case .failed: return "No se ha podido cargar. Se reintentará en unos minutos."
        default: return "Abre Runna.io para conectar el widget."
        }
    }

    private var detail: String? {
        switch problem {
        case .failed(let reason): return reason
        case .noSession(let reason): return reason
        default: return nil
        }
    }

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
                Text(message)
                    .font(.footnote.weight(.medium))
                if let detail {
                    Text(detail)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
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

    /// Gold, silver and bronze for the first three places.
    static func medal(_ rank: Int) -> Color? {
        switch rank {
        case 1: return Color(red: 0.96, green: 0.70, blue: 0.10)
        case 2: return Color(red: 0.60, green: 0.65, blue: 0.71)
        case 3: return Color(red: 0.80, green: 0.50, blue: 0.26)
        default: return nil
        }
    }
}

/// Title row of a widget: a symbol in a coloured circle, the title and a detail in a capsule on the right.
private struct WidgetHeader: View {
    let symbol: String
    let title: String
    let tint: Color
    var detail: String? = nil

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Color.white)
                .frame(width: 20, height: 20)
                .background(tint.gradient, in: Circle())
            Text(title)
                .font(.system(size: 13, weight: .bold))
                .lineLimit(1)
            Spacer(minLength: 4)
            if let detail {
                Text(detail)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Color.primary.opacity(0.07), in: Capsule())
            }
        }
    }
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
                    .background(color.gradient)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(color, lineWidth: 1.5))
    }
}

// MARK: - Liga semanal

struct LeagueView: View {
    let summary: WidgetSummary
    let family: WidgetFamily
    let avatars: [String: UIImage]
    let date: Date

    private var large: Bool { family == .systemLarge }

    private var rows: [WidgetSummary.Entry] {
        let limit = large ? 6 : 4
        var shown = Array(summary.week.entries.prefix(limit))
        if let me = summary.myEntry, !shown.contains(where: { $0.isMe }), !shown.isEmpty {
            shown[shown.count - 1] = me
        }
        return shown
    }

    private var maxArea: Double { max(summary.week.entries.map(\.area).max() ?? 0, 1) }

    var body: some View {
        VStack(alignment: .leading, spacing: large ? 12 : 6) {
            WidgetHeader(symbol: "trophy.fill", title: "Liga semanal", tint: .orange, detail: daysLeftText)
            if summary.week.players <= 1 {
                Spacer(minLength: 0)
                Text("Añade amigos en Runna.io para competir cada semana.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            } else {
                VStack(spacing: large ? 10 : 5) {
                    ForEach(rows) { row in
                        LeagueRow(entry: row, maxArea: maxArea, avatar: avatars[row.id], large: large)
                    }
                }
                Spacer(minLength: 0)
                if let footer {
                    Text(footer)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
        }
    }

    private var daysLeftText: String {
        let left = summary.daysLeft(at: date)
        return left <= 1 ? "último día" : "quedan \(left) días"
    }

    /// "Te faltan 0,11 km² para pasar a Ana" / "Vas primero"
    private var footer: String? {
        guard let me = summary.myEntry else { return nil }
        if me.rank == 1 {
            return me.area > 0 ? "👑 Vas primero esta semana" : nil
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
                .font(WStyle.number(12, weight: .bold))
                .foregroundStyle(WStyle.medal(entry.rank) ?? Color.secondary)
                .frame(width: 13, alignment: .trailing)
            WidgetAvatar(name: entry.name, color: color, image: avatar, size: large ? 26 : 20)
            Text(entry.name)
                .font(.system(size: large ? 13 : 12, weight: entry.isMe ? .bold : .medium))
                .lineLimit(1)
                .frame(width: large ? 72 : 56, alignment: .leading)
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.08))
                    Capsule()
                        .fill(LinearGradient(colors: [color.opacity(0.6), color], startPoint: .leading, endPoint: .trailing))
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
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(color.opacity(0.14))
                    .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(color.opacity(0.35), lineWidth: 1))
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

struct MyWeekView: View {
    let summary: WidgetSummary
    let family: WidgetFamily
    let date: Date

    private var color: Color { WStyle.color(summary.me.color) }
    private var rankText: String { summary.week.myRank.map { "\($0).º" } ?? "–" }
    private var rankColor: Color {
        if let rank = summary.week.myRank, let medal = WStyle.medal(rank) { return medal }
        return Color.primary
    }
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
        case .systemMedium:
            medium
        default:
            small
        }
    }

    /// Progress against the leader: a track and an arc in your colour.
    private func ring(lineWidth: CGFloat) -> some View {
        ZStack {
            Circle().stroke(color.opacity(0.18), lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: progress)
                .stroke(
                    AngularGradient(colors: [color.opacity(0.55), color], center: .center),
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
        }
    }

    /// Ring and figures on the left, the week day by day on the right.
    private var medium: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                WidgetHeader(symbol: "figure.run", title: "Esta semana", tint: color)
                HStack(spacing: 10) {
                    ZStack {
                        ring(lineWidth: 7)
                        Text(rankText)
                            .font(WStyle.number(17, weight: .bold))
                            .foregroundStyle(rankColor)
                    }
                    .frame(width: 58, height: 58)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(WStyle.area(summary.week.myArea))
                            .font(WStyle.number(22, weight: .bold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)
                        Text(WStyle.distance(summary.week.myDistance))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                        Text(summary.week.myRuns == 1 ? "1 carrera" : "\(summary.week.myRuns) carreras")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
                if let leader = summary.leader, !leader.isMe, leader.area > 0 {
                    Text("🏆 \(leader.name) · \(WStyle.area(leader.area))")
                        .font(.system(size: 11, weight: .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack {
                Spacer(minLength: 0)
                DayBars(summary: summary, date: date, color: color, height: 52)
            }
            .frame(maxWidth: .infinity)
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
                    .foregroundStyle(rankColor)
            }
            HStack(spacing: 8) {
                ZStack {
                    ring(lineWidth: 6)
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

/// L M X J V S D: what you conquered (or ran) each day, today in bold.
private struct DayBars: View {
    let summary: WidgetSummary
    let date: Date
    let color: Color
    /// Height of the tallest bar.
    var height: CGFloat = 22
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
                    RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                        .fill(value > 0
                              ? AnyShapeStyle(LinearGradient(colors: [color, color.opacity(0.65)], startPoint: .top, endPoint: .bottom))
                              : AnyShapeStyle(Color.primary.opacity(index == today ? 0.25 : 0.12)))
                        .frame(height: value > 0 ? max(4, height * value / top) : 3)
                    Text(letters[index])
                        .font(.system(size: 8, weight: index == today ? .heavy : .medium))
                        .foregroundStyle(index == today ? Color.primary : Color.secondary)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .frame(height: height + 12, alignment: .bottom)
    }

    private var todayIndex: Int {
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = TimeZone(identifier: "Europe/Madrid") ?? .current
        let weekday = calendar.component(.weekday, from: date) // 1 = Sunday
        return (weekday + 5) % 7
    }
}

// MARK: - Mi territorio

/// The map of your main place (where you run the most; the server leaves other cities out) with your
/// totals over it. Medium: figures in a panel on the left, the territory on the right. Large: the place
/// at the top, figures at the bottom and the territory in between.
struct TerritoryView: View {
    let summary: WidgetSummary
    let family: WidgetFamily
    let hasMap: Bool
    var placeName: String? = nil

    /// Part of the map each layout covers with text (fractions of the widget): the territory is framed in the rest.
    static func mapInsets(for family: WidgetFamily) -> WidgetMapRenderer.Insets {
        family == .systemLarge
            ? WidgetMapRenderer.Insets(top: 0.16, left: 0.06, bottom: 0.30, right: 0.06)
            : WidgetMapRenderer.Insets(top: 0.10, left: 0.46, bottom: 0.10, right: 0.05)
    }

    private var color: Color { WStyle.color(summary.me.color) }

    var body: some View {
        Group {
            if summary.me.totalArea <= 0 && !hasMap {
                empty
            } else if family == .systemLarge {
                large
            } else {
                medium
            }
        }
        .foregroundStyle(Color.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            // No map (no territory yet, or the map couldn't be drawn): a dark backdrop in your colour
            if !hasMap {
                LinearGradient(colors: [color.opacity(0.55), Color.black.opacity(0.94)], startPoint: .topLeading, endPoint: .bottomTrailing)
            }
        }
    }

    private var placeChip: some View {
        Label(placeName ?? "Mi territorio", systemImage: placeName == nil ? "map.fill" : "mappin.and.ellipse")
            .font(.system(size: 12, weight: .bold))
            .lineLimit(1)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(Color.black.opacity(0.5), in: Capsule())
    }

    /// "+1 lugar más · 1,02 km²": territory in other cities, not on the map.
    private var elsewhereText: String? {
        guard let elsewhere = summary.map.elsewhere, elsewhere.places > 0 else { return nil }
        let places = elsewhere.places == 1 ? "1 lugar más" : "\(elsewhere.places) lugares más"
        return "+\(places) · \(WStyle.area(elsewhere.area))"
    }

    /// Castles and wear, one line each.
    private var facts: [String] {
        var lines: [String] = []
        let castles = summary.defense.castleLayers
        if castles > 0 {
            lines.append("🏰 \(castles) \(castles == 1 ? "castillo" : "castillos")")
        }
        if summary.defense.weakArea > 0 {
            lines.append("🍂 \(WStyle.area(summary.defense.weakArea)) se desgastan")
        } else if summary.defense.atRiskArea > 0 {
            lines.append("⏳ \(WStyle.area(summary.defense.atRiskArea)) en 2 días")
        }
        return lines
    }

    private var totalArea: some View {
        Text(WStyle.area(summary.me.totalArea))
            .font(WStyle.number(family == .systemLarge ? 34 : 28, weight: .bold))
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .shadow(color: Color.black.opacity(0.4), radius: 3, y: 1)
    }

    private var medium: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                placeChip
                Spacer(minLength: 4)
                totalArea
                Text("conquistados")
                    .font(.system(size: 10, weight: .semibold))
                    .opacity(0.75)
                Spacer(minLength: 4)
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(facts.prefix(2), id: \.self) { line in
                        Text(line)
                    }
                    if let elsewhereText {
                        Text("🌍 \(elsewhereText)")
                    }
                }
                .font(.system(size: 10.5, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            }
            .frame(width: 160, alignment: .leading)
            .padding(.leading, 14)
            .padding(.vertical, 14)
            Spacer(minLength: 0)
        }
        .background {
            if hasMap {
                LinearGradient(
                    stops: [
                        .init(color: Color.black.opacity(0.82), location: 0),
                        .init(color: Color.black.opacity(0.55), location: 0.38),
                        .init(color: Color.black.opacity(0), location: 0.62),
                    ],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            }
        }
    }

    private var large: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 6) {
                placeChip
                Spacer(minLength: 0)
                if let elsewhereText {
                    Text("🌍 \(elsewhereText)")
                        .font(.system(size: 11, weight: .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(Color.black.opacity(0.5), in: Capsule())
                }
            }
            Spacer(minLength: 0)
            HStack(alignment: .bottom, spacing: 12) {
                VStack(alignment: .leading, spacing: 1) {
                    totalArea
                    Text("conquistados")
                        .font(.system(size: 11, weight: .semibold))
                        .opacity(0.75)
                    if summary.week.myArea > 0 {
                        HStack(spacing: 5) {
                            Circle()
                                .fill(color)
                                .frame(width: 7, height: 7)
                            Text("+\(WStyle.area(summary.week.myArea)) esta semana")
                        }
                        .font(.system(size: 11, weight: .bold))
                        .padding(.top, 3)
                    }
                }
                Spacer(minLength: 0)
                VStack(alignment: .trailing, spacing: 3) {
                    ForEach(facts, id: \.self) { line in
                        Text(line)
                    }
                }
                .font(.system(size: 11, weight: .semibold))
                .lineLimit(1)
            }
        }
        .padding(14)
        .background {
            if hasMap {
                VStack(spacing: 0) {
                    LinearGradient(colors: [Color.black.opacity(0.6), Color.black.opacity(0)], startPoint: .top, endPoint: .bottom)
                        .frame(height: 84)
                    Spacer(minLength: 0)
                    LinearGradient(colors: [Color.black.opacity(0), Color.black.opacity(0.82)], startPoint: .top, endPoint: .bottom)
                        .frame(height: 150)
                }
            }
        }
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 6) {
            placeChip
            Spacer(minLength: 0)
            Image(systemName: "flag.2.crossed.fill")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(color)
            Text("Aún no tienes territorio")
                .font(.system(size: 15, weight: .bold))
            Text("Rodea una zona corriendo para conquistarla.")
                .font(.system(size: 12, weight: .medium))
                .opacity(0.75)
        }
        .padding(14)
    }
}

// MARK: - Defiende

struct DefendView: View {
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
            .background(WStyle.color(summary.me.color).gradient, in: Capsule())
            .shadow(color: Color.black.opacity(0.25), radius: 3, y: 1)
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
