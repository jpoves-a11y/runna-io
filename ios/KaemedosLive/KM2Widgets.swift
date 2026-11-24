import AppIntents
import SwiftUI
import WidgetKit

// Home-screen widgets in KM2's own look (black like the icon, white figures, its green only where
// it matters): the map of my territory, the podium of my competition, and one that shows either
// (or a summary), chosen by holding it. They read GET /api/widget/summary and /api/widget/details.

// MARK: - What to show

enum WidgetContent: String, AppEnum {
    case map
    case podium
    case summary

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Contenido"
    static let caseDisplayRepresentations: [WidgetContent: DisplayRepresentation] = [
        .map: "Mapa de tu territorio",
        .podium: "Podio de la competición",
        .summary: "Resumen"
    ]
}

struct KM2WidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Qué muestra"
    static let description = IntentDescription("Elige qué muestra el widget de KM2.")

    @Parameter(title: "Mostrar", default: .map)
    var content: WidgetContent

    init() {}

    init(content: WidgetContent) {
        self.content = content
    }
}

// MARK: - Timeline

struct KM2Entry: TimelineEntry {
    let date: Date
    let content: WidgetContent
    let summary: WidgetSummary?
    let details: WidgetDetails?
    /// The map, already drawn at the widget's size (map content only).
    let mapImage: UIImage?
    let signedOut: Bool
}

enum KM2Timeline {
    /// Every half hour (the system may space it out).
    static let refresh: TimeInterval = 30 * 60

    static func layout(for family: WidgetFamily) -> TerritoryMapRenderer.Layout {
        switch family {
        case .systemMedium: return .left
        case .systemLarge, .systemExtraLarge: return .top
        default: return .bottom
        }
    }

    private static var scale: CGFloat { max(2, UIScreen.main.scale) }

    /// Right away, with sample data and the map without streets (placeholders, the gallery).
    static func placeholder(_ content: WidgetContent, family: WidgetFamily, size: CGSize) -> KM2Entry {
        let details = WidgetDetails.placeholder
        let image = content == .map ? details.map.flatMap { TerritoryMapRenderer.vector($0, size: size, scale: scale, layout: layout(for: family)) } : nil
        return KM2Entry(date: Date(), content: content, summary: .placeholder, details: details, mapImage: image, signedOut: false)
    }

    static func entry(_ content: WidgetContent, family: WidgetFamily, size: CGSize, preview: Bool) async -> KM2Entry {
        if preview { return placeholder(content, family: family, size: size) }
        let data = await WidgetStore.load()
        var image: UIImage?
        if content == .map, let map = data.details?.map {
            image = await TerritoryMapRenderer.render(map, size: size, scale: scale, layout: layout(for: family))
        }
        return KM2Entry(date: Date(), content: content, summary: data.summary, details: data.details, mapImage: image, signedOut: data.signedOut)
    }

    static func timeline(_ content: WidgetContent, family: WidgetFamily, size: CGSize) async -> Timeline<KM2Entry> {
        let entry = await entry(content, family: family, size: size, preview: false)
        return Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(refresh)))
    }
}

struct FixedContentProvider: TimelineProvider {
    let content: WidgetContent

    func placeholder(in context: Context) -> KM2Entry {
        KM2Timeline.placeholder(content, family: context.family, size: context.displaySize)
    }

    func getSnapshot(in context: Context, completion: @escaping (KM2Entry) -> Void) {
        Task {
            completion(await KM2Timeline.entry(content, family: context.family, size: context.displaySize, preview: context.isPreview))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<KM2Entry>) -> Void) {
        Task {
            completion(await KM2Timeline.timeline(content, family: context.family, size: context.displaySize))
        }
    }
}

struct ConfigurableProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> KM2Entry {
        KM2Timeline.placeholder(.map, family: context.family, size: context.displaySize)
    }

    func snapshot(for configuration: KM2WidgetIntent, in context: Context) async -> KM2Entry {
        await KM2Timeline.entry(configuration.content, family: context.family, size: context.displaySize, preview: context.isPreview)
    }

    func timeline(for configuration: KM2WidgetIntent, in context: Context) async -> Timeline<KM2Entry> {
        await KM2Timeline.timeline(configuration.content, family: context.family, size: context.displaySize)
    }
}

// MARK: - Widgets

struct TerritoryMapWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KaemedosMap", provider: FixedContentProvider(content: .map)) { entry in
            KM2WidgetView(entry: entry)
        }
        .configurationDisplayName("Mapa")
        .description("Tu territorio sobre el mapa, con el de tus amigos alrededor.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
        .contentMarginsDisabled()
    }
}

struct PodiumWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KaemedosPodium", provider: FixedContentProvider(content: .podium)) { entry in
            KM2WidgetView(entry: entry)
        }
        .configurationDisplayName("Podio")
        .description("Los tres primeros de tu competición y lo que te falta para subir.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
        .contentMarginsDisabled()
    }
}

struct ConfigurableKM2Widget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "KaemedosConfigurable", intent: KM2WidgetIntent.self, provider: ConfigurableProvider()) { entry in
            KM2WidgetView(entry: entry)
        }
        .configurationDisplayName("KM2")
        .description("Mapa, podio o resumen: mantenlo pulsado para elegir.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
        .contentMarginsDisabled()
    }
}

// MARK: - Look

/// The widgets' type and colour: black like the icon, figures in a heavy condensed cut, small
/// labels in spaced capitals, hairlines, KM2's green only for what's mine or what matters.
enum WidgetStyle {
    static let ground = Color(white: 0.035)
    static let neon = Color(uiColor: WidgetColor.neon)
    static let alert = Color(red: 1, green: 0.36, blue: 0.27)
    static let primary = Color.white
    static let secondary = Color.white.opacity(0.58)
    static let tertiary = Color.white.opacity(0.36)
    static let hairline = Color.white.opacity(0.12)
    /// Space from the widget's edges (the content margins are off, so the map bleeds).
    static let inset: CGFloat = 15

    static func figure(_ size: CGFloat) -> Font {
        .system(size: size, weight: .heavy).width(.condensed)
    }

    static func runnerColor(_ hex: String?) -> Color {
        Color(uiColor: WidgetColor.visible(hex, fallback: UIColor(white: 0.7, alpha: 1)))
    }
}

/// A small label in spaced capitals.
private struct Caps: View {
    let text: String
    var color: Color = WidgetStyle.tertiary

    init(_ text: String, color: Color = WidgetStyle.tertiary) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text.uppercased(with: Locale(identifier: "es_ES")))
            .font(.system(size: 9, weight: .semibold))
            .tracking(1.3)
            .foregroundStyle(color)
            .lineLimit(1)
    }
}

/// KM2, as in the icon: KM in white, the 2 in green.
private struct Wordmark: View {
    var size: CGFloat = 11

    var body: some View {
        (Text("KM").foregroundStyle(WidgetStyle.primary) + Text("2").foregroundStyle(WidgetStyle.neon))
            .font(.system(size: size, weight: .black))
            .tracking(-0.2)
            .accessibilityLabel("KM2")
    }
}

/// An area as a big figure and a small unit: "1,25 km²".
private struct AreaFigure: View {
    let squareMetres: Double
    let size: CGFloat
    var color: Color = WidgetStyle.primary

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: size * 0.08) {
            Text(WidgetText.number(squareMetres / 1_000_000))
                .font(WidgetStyle.figure(size))
                .foregroundStyle(color)
                .monospacedDigit()
            Text("km²")
                .font(.system(size: max(9, size * 0.34), weight: .semibold))
                .foregroundStyle(WidgetStyle.secondary)
        }
        .lineLimit(1)
        .minimumScaleFactor(0.6)
    }
}

private struct Hairline: View {
    var body: some View {
        Rectangle().fill(WidgetStyle.hairline).frame(height: 0.5)
    }
}

enum WidgetText {
    private static let spanish = Locale(identifier: "es_ES")

    /// km² with two decimals under 10, one above ("1,25", "12,4").
    static func number(_ km2: Double) -> String {
        let digits = km2 < 10 ? 2 : 1
        return km2.formatted(.number.precision(.fractionLength(digits)).locale(spanish))
    }

    static func score(_ score: Double, mode: String) -> String {
        mode == "flags"
            ? "\(score.formatted(.number.precision(.fractionLength(0...1)).locale(spanish))) h"
            : "\(number(score / 1_000_000)) km²"
    }

    /// "3 d 5 h", "5 h 20 min", "12 min".
    static func remaining(until end: Date, from now: Date) -> String {
        let seconds = max(0, Int(end.timeIntervalSince(now)))
        let days = seconds / 86_400, hours = (seconds % 86_400) / 3600, minutes = (seconds % 3600) / 60
        if days > 0 { return "\(days) d \(hours) h" }
        if hours > 0 { return "\(hours) h \(minutes) min" }
        return "\(max(1, minutes)) min"
    }

    static func ago(_ iso: String, from now: Date) -> String {
        guard let date = WidgetFormat.date(iso) else { return "" }
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        if seconds < 3600 { return "hace \(max(1, seconds / 60)) min" }
        if seconds < 86_400 { return "hace \(seconds / 3600) h" }
        return "hace \(seconds / 86_400) d"
    }
}

// MARK: - Views

struct KM2WidgetView: View {
    let entry: KM2Entry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        content
            .environment(\.colorScheme, .dark)
            .containerBackground(for: .widget) { background }
            .widgetURL(url)
    }

    @ViewBuilder
    private var content: some View {
        if entry.signedOut {
            SignedOutView()
        } else {
            switch entry.content {
            case .map: MapContentView(entry: entry)
            case .podium: PodiumContentView(entry: entry)
            case .summary: SummaryContentView(entry: entry)
            }
        }
    }

    @ViewBuilder
    private var background: some View {
        if entry.content == .map, let image = entry.mapImage, !entry.signedOut {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else if family.isAccessory {
            AccessoryWidgetBackground()
        } else {
            WidgetStyle.ground
        }
    }

    private var url: URL? {
        switch entry.content {
        case .map: return URL(string: "runnaio://tab/map/global")
        case .podium: return URL(string: entry.details?.podium == nil ? "runnaio://tab/map/competition" : "runnaio://tab/club")
        case .summary: return URL(string: "runnaio://tab/map")
        }
    }
}

private extension WidgetFamily {
    var isAccessory: Bool {
        self == .accessoryRectangular || self == .accessoryInline || self == .accessoryCircular
    }
}

private struct SignedOutView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Wordmark(size: 13)
            Spacer(minLength: 0)
            Text("Inicia sesión en KM2 para ver tu territorio.")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(WidgetStyle.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(WidgetStyle.inset)
    }
}

// MARK: Map

private struct MapContentView: View {
    let entry: KM2Entry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let map = entry.details?.map {
            switch family {
            case .systemMedium: medium(map)
            case .systemLarge, .systemExtraLarge: large(map)
            default: small(map)
            }
        } else {
            empty
        }
    }

    private var rankLine: String? {
        guard let summary = entry.summary, let rank = summary.cityRank else { return nil }
        return summary.city.map { "\(rank).º en \($0)" } ?? "\(rank).º"
    }

    private func small(_ map: WidgetDetails.MapData) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Spacer()
                Wordmark()
            }
            Spacer(minLength: 0)
            Caps("Territorio")
            AreaFigure(squareMetres: map.area, size: 30)
            if let rankLine {
                Text(rankLine)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(WidgetStyle.secondary)
                    .lineLimit(1)
            }
        }
        .padding(WidgetStyle.inset)
    }

    private func medium(_ map: WidgetDetails.MapData) -> some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                Wordmark()
                Spacer(minLength: 0)
                Caps("Territorio")
                AreaFigure(squareMetres: map.area, size: 34)
                if let rankLine {
                    Text(rankLine)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(WidgetStyle.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                StatusLine(summary: entry.summary, now: entry.date)
            }
            .frame(maxWidth: 150, alignment: .leading)
            Spacer(minLength: 0)
        }
        .padding(WidgetStyle.inset)
    }

    private func large(_ map: WidgetDetails.MapData) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Wordmark(size: 12)
                Spacer()
                if let city = entry.summary?.city { Caps(city, color: WidgetStyle.secondary) }
            }
            Spacer(minLength: 0)
            Caps("Territorio")
            AreaFigure(squareMetres: map.area, size: 46)
            Hairline()
                .padding(.vertical, 10)
            HStack(alignment: .top, spacing: 0) {
                stat("Puesto", entry.summary?.cityRank.map { "\($0).º" } ?? "—")
                stat("Racha", entry.summary.map { $0.streakDays == 1 ? "1 día" : "\($0.streakDays) días" } ?? "—")
                stat(entry.details?.podium?.modeName ?? "Competición", competitionValue)
            }
        }
        .padding(WidgetStyle.inset + 2)
    }

    private var competitionValue: String {
        if let me = entry.details?.podium?.me, let podium = entry.details?.podium {
            return "\(me.rank).º de \(podium.participants)"
        }
        return entry.details?.phase == "competition" ? "—" : "Descanso"
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Caps(label)
            Text(value)
                .font(WidgetStyle.figure(20))
                .foregroundStyle(WidgetStyle.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 6) {
            Wordmark()
            Spacer(minLength: 0)
            Caps("Territorio")
            Text("Cierra un recorrido corriendo y aquí aparecerá tu territorio.")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(WidgetStyle.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(WidgetStyle.inset)
    }
}

/// One line about what's going on: a steal against me (in red), or my streak.
private struct StatusLine: View {
    let summary: WidgetSummary?
    let now: Date

    var body: some View {
        if let theft = summary?.lastSteal {
            HStack(spacing: 6) {
                Circle().fill(WidgetStyle.alert).frame(width: 5, height: 5)
                Text("\(theft.by) te quitó \(WidgetText.number(theft.area / 1_000_000)) km² · \(WidgetText.ago(theft.at, from: now))")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(WidgetStyle.primary)
                    .lineLimit(2)
            }
        } else if let streak = summary?.streakDays, streak > 0 {
            HStack(spacing: 6) {
                Circle().fill(WidgetStyle.neon).frame(width: 5, height: 5)
                Text(streak == 1 ? "1 día corriendo" : "\(streak) días seguidos corriendo")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(WidgetStyle.secondary)
                    .lineLimit(1)
            }
        }
    }
}

// MARK: Podium

private struct PodiumContentView: View {
    let entry: KM2Entry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let podium = entry.details?.podium, !podium.top.isEmpty {
            switch family {
            case .accessoryRectangular: rectangular(podium)
            case .accessoryInline: inline(podium)
            case .systemMedium: medium(podium)
            case .systemLarge, .systemExtraLarge: large(podium)
            default: small(podium)
            }
        } else {
            rest
        }
    }

    private var ends: String? {
        guard let end = WidgetFormat.date(entry.details?.podium?.endsAt), end > entry.date else { return nil }
        return WidgetText.remaining(until: end, from: entry.date)
    }

    private func header(_ podium: WidgetDetails.Podium) -> some View {
        HStack(spacing: 8) {
            Caps(podium.modeName, color: WidgetStyle.secondary)
            Spacer(minLength: 4)
            if let ends { Caps(ends, color: WidgetStyle.tertiary) }
        }
    }

    // Small: the top three as a list, and me under a hairline if I'm not among them

    private func small(_ podium: WidgetDetails.Podium) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            header(podium)
            Spacer(minLength: 6)
            VStack(spacing: 7) {
                ForEach(podium.top, id: \.rank) { place in
                    row(rank: place.rank, name: place.me ? "Tú" : place.name, color: place.color, score: place.score, mode: podium.mode, isMe: place.me)
                }
            }
            if let me = podium.me, !podium.top.contains(where: \.me) {
                Hairline().padding(.vertical, 7)
                row(rank: me.rank, name: "Tú", color: me.color, score: me.score, mode: podium.mode, isMe: true)
            }
        }
        .padding(WidgetStyle.inset)
    }

    private func row(rank: Int, name: String, color: String?, score: Double, mode: String, isMe: Bool) -> some View {
        HStack(spacing: 7) {
            Text("\(rank)")
                .font(WidgetStyle.figure(17))
                .foregroundStyle(isMe ? WidgetStyle.neon : (rank == 1 ? WidgetStyle.primary : WidgetStyle.secondary))
                .monospacedDigit()
                .frame(minWidth: 14, alignment: .leading)
            RoundedRectangle(cornerRadius: 1, style: .continuous)
                .fill(WidgetStyle.runnerColor(color))
                .frame(width: 3, height: 13)
            Text(name)
                .font(.system(size: 13, weight: isMe ? .bold : .semibold))
                .foregroundStyle(isMe ? WidgetStyle.neon : WidgetStyle.primary)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(WidgetText.score(score, mode: mode))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(WidgetStyle.secondary)
                .monospacedDigit()
                .lineLimit(1)
        }
    }

    // Medium: a real podium (2, 1, 3) on the left, where I stand on the right

    private func medium(_ podium: WidgetDetails.Podium) -> some View {
        HStack(alignment: .bottom, spacing: 16) {
            blocks(podium, scale: 1)
                .frame(maxWidth: .infinity)
            standing(podium, figure: 44)
                .frame(width: 118, alignment: .leading)
        }
        .padding(WidgetStyle.inset)
    }

    private func large(_ podium: WidgetDetails.Podium) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            header(podium)
            Spacer(minLength: 10)
            blocks(podium, scale: 1.45)
            Hairline().padding(.vertical, 14)
            standing(podium, figure: 52, showsHeader: false)
        }
        .padding(WidgetStyle.inset + 2)
    }

    private func blocks(_ podium: WidgetDetails.Podium, scale: CGFloat) -> some View {
        let order = [2, 1, 3].compactMap { rank in podium.top.first { $0.rank == rank } }
        return HStack(alignment: .bottom, spacing: 5) {
            ForEach(order, id: \.rank) { place in
                VStack(spacing: 4 * scale) {
                    Text(place.me ? "Tú" : place.name)
                        .font(.system(size: 11 * min(scale, 1.2), weight: .semibold))
                        .foregroundStyle(place.me ? WidgetStyle.neon : WidgetStyle.primary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                    Text(WidgetText.score(place.score, mode: podium.mode))
                        .font(.system(size: 9.5 * min(scale, 1.2), weight: .medium))
                        .foregroundStyle(WidgetStyle.tertiary)
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    step(place, height: height(of: place.rank) * scale)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }

    private func height(of rank: Int) -> CGFloat {
        switch rank {
        case 1: return 58
        case 2: return 42
        default: return 30
        }
    }

    private func step(_ place: WidgetDetails.Place, height: CGFloat) -> some View {
        UnevenRoundedRectangle(topLeadingRadius: 4, topTrailingRadius: 4, style: .continuous)
            .fill(place.me ? WidgetStyle.neon.opacity(0.16) : Color.white.opacity(place.rank == 1 ? 0.11 : 0.065))
            .overlay(alignment: .top) {
                // The runner's colour as a thin edge on top of the step
                UnevenRoundedRectangle(topLeadingRadius: 4, topTrailingRadius: 4, style: .continuous)
                    .fill(WidgetStyle.runnerColor(place.color))
                    .frame(height: 2.5)
            }
            .overlay(alignment: .top) {
                Text("\(place.rank)")
                    .font(WidgetStyle.figure(min(30, height * 0.52)))
                    .foregroundStyle(place.me ? WidgetStyle.neon : (place.rank == 1 ? WidgetStyle.primary : WidgetStyle.secondary))
                    .padding(.top, 5)
            }
            .frame(height: height)
    }

    private func standing(_ podium: WidgetDetails.Podium, figure: CGFloat, showsHeader: Bool = true) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if showsHeader {
                Caps(podium.modeName, color: WidgetStyle.secondary)
                Spacer(minLength: 6)
            }
            Caps("Tu puesto")
            if let me = podium.me {
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text("\(me.rank)")
                        .font(WidgetStyle.figure(figure))
                        .foregroundStyle(WidgetStyle.neon)
                        .monospacedDigit()
                    Text(".º")
                        .font(WidgetStyle.figure(figure * 0.42))
                        .foregroundStyle(WidgetStyle.neon)
                    Text("de \(podium.participants)")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(WidgetStyle.secondary)
                        .padding(.leading, 3)
                }
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                Text(me.ahead.map { "A \(WidgetText.score($0.gap, mode: podium.mode)) de \($0.name)" } ?? "Vas en cabeza")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(WidgetStyle.primary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("No participas")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(WidgetStyle.secondary)
            }
            if showsHeader, let ends {
                Spacer(minLength: 6)
                Caps("Quedan \(ends)")
            } else if let ends {
                Text("Quedan \(ends)")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(WidgetStyle.tertiary)
                    .padding(.top, 6)
            }
        }
    }

    private func rectangular(_ podium: WidgetDetails.Podium) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("KM2 · \(podium.modeName)")
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
            if let me = podium.me {
                Text("\(me.rank).º de \(podium.participants)")
                    .font(.headline)
                Text(me.ahead.map { "A \(WidgetText.score($0.gap, mode: podium.mode)) de \($0.name)" } ?? "Vas en cabeza")
                    .font(.caption2)
                    .lineLimit(1)
            } else if let first = podium.top.first {
                Text("Lidera \(first.name)")
                    .font(.headline)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func inline(_ podium: WidgetDetails.Podium) -> some View {
        Text(podium.me.map { "\($0.rank).º de \(podium.participants) · KM2" } ?? "KM2 · \(podium.modeName)")
    }

    /// No competition right now: when the next one starts.
    @ViewBuilder
    private var rest: some View {
        let next = WidgetFormat.date(entry.details?.nextChangeAt ?? entry.summary?.nextChangeAt)
        switch family {
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Text("KM2 · Descanso").font(.caption2.weight(.semibold))
                if let next, next > entry.date {
                    Text("Compites en \(WidgetText.remaining(until: next, from: entry.date))").font(.headline).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .accessoryInline:
            Text("KM2 · Descanso")
        default:
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Caps("Descanso", color: WidgetStyle.secondary)
                    Spacer()
                    Wordmark()
                }
                Spacer(minLength: 0)
                Caps("Próxima competición")
                if let next, next > entry.date {
                    Text(WidgetText.remaining(until: next, from: entry.date))
                        .font(WidgetStyle.figure(family == .systemSmall ? 30 : 38))
                        .foregroundStyle(WidgetStyle.primary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
                Text("Los cofres están en el mapa.")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(WidgetStyle.secondary)
                    .lineLimit(1)
            }
            .padding(WidgetStyle.inset)
        }
    }
}

// MARK: Summary

private struct SummaryContentView: View {
    let entry: KM2Entry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let summary = entry.summary {
            switch family {
            case .systemSmall: small(summary)
            default: wide(summary)
            }
        } else {
            SignedOutView()
        }
    }

    private func small(_ summary: WidgetSummary) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Spacer()
                Wordmark()
            }
            Spacer(minLength: 0)
            Caps("Territorio")
            AreaFigure(squareMetres: summary.area, size: 30)
            if let rank = summary.cityRank {
                Text(summary.city.map { "\(rank).º en \($0)" } ?? "\(rank).º")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(WidgetStyle.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            StatusLine(summary: summary, now: entry.date)
        }
        .padding(WidgetStyle.inset)
    }

    private func wide(_ summary: WidgetSummary) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Wordmark()
                Spacer()
                if let city = summary.city { Caps(city, color: WidgetStyle.secondary) }
            }
            Spacer(minLength: 0)
            HStack(alignment: .bottom, spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    Caps("Territorio")
                    AreaFigure(squareMetres: summary.area, size: family == .systemLarge ? 46 : 34)
                }
                Spacer(minLength: 8)
            }
            Hairline().padding(.vertical, 9)
            HStack(alignment: .top, spacing: 0) {
                cell("Puesto", summary.cityRank.map { "\($0).º" } ?? "—")
                cell("Racha", summary.streakDays == 1 ? "1 día" : "\(summary.streakDays) días")
                cell("Competición", summary.competition?.rank.map { "\($0).º de \(summary.competition?.participants ?? 0)" } ?? (summary.phase == "competition" ? "—" : "Descanso"))
            }
            if family == .systemLarge {
                Spacer(minLength: 12)
                StatusLine(summary: summary, now: entry.date)
            }
        }
        .padding(WidgetStyle.inset)
    }

    private func cell(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Caps(label)
            Text(value)
                .font(WidgetStyle.figure(19))
                .foregroundStyle(WidgetStyle.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
