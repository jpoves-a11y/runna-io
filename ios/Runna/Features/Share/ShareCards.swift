import SwiftUI
import UIKit

// Share cards, drawn at a fixed size in points and rendered at 3x (1080 px wide) with ImageRenderer.

// MARK: - Style

enum ShareStyle {
    static let night = Color(red: 0.043, green: 0.051, blue: 0.063)
    static let paper = Color(red: 0.969, green: 0.969, blue: 0.961)

    static func number(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight).width(.condensed)
    }

    static func ink(_ background: ShareOptions.Background) -> Color {
        background == .light ? Color.black : Color.white
    }

    /// "Ana", "Ana y Miguel", "Ana, Miguel y 2 más"
    static func names(_ names: [String]) -> String {
        switch names.count {
        case 0: return ""
        case 1: return names[0]
        case 2: return "\(names[0]) y \(names[1])"
        default: return "\(names[0]), \(names[1]) y \(names.count - 2) más"
        }
    }

    static func day(_ date: Date?) -> String {
        guard let date else { return "" }
        return date.formatted(.dateTime.day().month(.wide).locale(Locale(identifier: "es_ES")))
    }
}

/// The Runna.io mark: the app icon and the wordmark.
struct ShareWordmark: View {
    var ink: Color = .white
    var size: CGFloat = 15

    var body: some View {
        HStack(spacing: size * 0.4) {
            Image("RunnaMark")
                .resizable()
                .scaledToFill()
                .frame(width: size * 1.35, height: size * 1.35)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.32, style: .continuous))
            Text("Runna.io")
                .font(.system(size: size, weight: .semibold).width(.condensed))
                .tracking(0.3)
                .foregroundStyle(ink.opacity(0.9))
        }
    }
}

/// Value over a small uppercase label.
private struct ShareStat: View {
    let value: String
    let label: String
    let ink: Color
    var size: CGFloat = 26

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .font(ShareStyle.number(size))
                .foregroundStyle(ink)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(label.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.8)
                .foregroundStyle(ink.opacity(0.6))
        }
    }
}

/// Distance · time · pace, as chosen.
private struct ShareStatsRow: View {
    let context: ShareContext
    let options: ShareOptions
    let ink: Color
    var size: CGFloat = 26

    var body: some View {
        HStack(alignment: .top, spacing: 18) {
            if options.distance {
                ShareStat(value: Format.distance(context.run.distance), label: "Distancia", ink: ink, size: size)
            }
            if options.time {
                ShareStat(value: Format.duration(context.run.duration), label: "Tiempo", ink: ink, size: size)
            }
            if options.pace, let pace = context.run.paceText {
                ShareStat(value: pace, label: "Ritmo /km", ink: ink, size: size)
            }
        }
    }
}

/// Territory, steals and ranking lines (what makes it a Runna share).
private struct ShareRunnaLines: View {
    let context: ShareContext
    let options: ShareOptions
    let ink: Color
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 4 : 6) {
            if options.territory, context.newArea > 0 {
                line("flag.fill", "+\(Format.area(context.newArea)) conquistados", tint: context.run.color, bold: true)
            }
            if options.steals, !context.victims.isEmpty {
                line("bolt.fill", "Robado a \(ShareStyle.names(context.victims.map(\.userName)))", tint: Color(red: 1, green: 0.42, blue: 0.35))
            }
            if options.territory, context.castlesBuilt > 0 {
                line("shield.lefthalf.filled", context.castlesBuilt == 1 ? "+1 castillo" : "+\(context.castlesBuilt) castillos", tint: ink.opacity(0.8))
            }
            if options.ranking, let rank = context.weekRank, context.weekPlayers > 1 {
                line("trophy.fill", "\(rank).º de \(context.weekPlayers) esta semana", tint: Color(red: 1, green: 0.78, blue: 0.2))
            }
        }
    }

    private func line(_ symbol: String, _ text: String, tint: Color, bold: Bool = false) -> some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: compact ? 11 : 12, weight: .bold))
                .foregroundStyle(tint)
                .frame(width: 16)
            Text(text)
                .font(.system(size: compact ? 13 : 14, weight: bold ? .bold : .semibold))
                .foregroundStyle(ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
    }
}

/// Round picture or initials on the player's colour.
private struct ShareAvatar: View {
    let name: String
    let color: Color
    let image: UIImage?
    var size: CGFloat = 28

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Text(String(name.prefix(1)).uppercased())
                    .font(.system(size: size * 0.45, weight: .bold))
                    .foregroundStyle(Color.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(color)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(color, lineWidth: 2))
    }
}

// MARK: - Cards

/// Any template at its export size.
struct ShareCardView: View {
    let template: ShareTemplate
    let context: ShareContext
    let options: ShareOptions

    var body: some View {
        Group {
            switch template {
            case .sticker: StickerCard(context: context, options: options)
            case .map: MapShareCard(context: context, options: options)
            case .conquest: ConquestShareCard(context: context, options: options)
            case .league: LeagueShareCard(context: context, options: options)
            }
        }
        .frame(width: template.size.width, height: template.size.height)
    }
}

/// Route silhouette and figures, to paste over a photo (transparent by default).
private struct StickerCard: View {
    let context: ShareContext
    let options: ShareOptions

    var body: some View {
        let ink = ShareStyle.ink(options.background)
        VStack(alignment: .leading, spacing: 14) {
            GeometryReader { proxy in
                let points = ShareGeometry.fit(context.run.coordinates, in: CGRect(origin: .zero, size: proxy.size), padding: 10)
                let path = ShareGeometry.path(points)
                ZStack {
                    path.stroke(context.run.color.opacity(0.35), style: StrokeStyle(lineWidth: 12, lineCap: .round, lineJoin: .round))
                    path.stroke(options.background == .light ? context.run.color : Color.white, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
                    if let start = points.first {
                        Circle().fill(context.run.color).frame(width: 12, height: 12)
                            .overlay(Circle().strokeBorder(Color.white, lineWidth: 2.5))
                            .position(start)
                    }
                }
            }
            .frame(height: 200)
            ShareStatsRow(context: context, options: options, ink: ink)
            ShareRunnaLines(context: context, options: options, ink: ink)
            Spacer(minLength: 0)
            ShareWordmark(ink: ink, size: 14)
        }
        .padding(22)
        .shadow(color: options.background == .transparent ? Color.black.opacity(0.45) : Color.clear, radius: 3, x: 0, y: 1)
        .background(cardBackground(options.background))
    }
}

/// Dark map with the route and the conquered territory, figures at the bottom.
private struct MapShareCard: View {
    let context: ShareContext
    let options: ShareOptions

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let map = context.mapImage {
                Image(uiImage: map).resizable().scaledToFill()
            } else {
                ShareStyle.night
            }
            LinearGradient(colors: [Color.black.opacity(0), Color.black.opacity(0.85)], startPoint: .center, endPoint: .bottom)
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.run.name)
                        .font(.system(size: 20, weight: .bold))
                        .foregroundStyle(Color.white)
                        .lineLimit(1)
                    Text(ShareStyle.day(context.run.date))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Color.white.opacity(0.65))
                }
                ShareStatsRow(context: context, options: options, ink: .white, size: 28)
                ShareRunnaLines(context: context, options: options, ink: .white)
                ShareWordmark(ink: .white, size: 14)
                    .padding(.top, 4)
            }
            .padding(24)
        }
        .clipped()
    }
}

/// "+0,12 km²" big, whom you stole from and your place in the week.
private struct ConquestShareCard: View {
    let context: ShareContext
    let options: ShareOptions

    var body: some View {
        let ink = ShareStyle.ink(options.background)
        VStack(alignment: .leading, spacing: 14) {
            ShareWordmark(ink: ink, size: 13)
            VStack(alignment: .leading, spacing: 0) {
                Text(context.newArea > 0 ? "+\(Format.area(context.newArea))" : Format.distance(context.run.distance))
                    .font(ShareStyle.number(64))
                    .foregroundStyle(context.run.color)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                Text(context.newArea > 0 ? "conquistados · \(context.run.name)" : context.run.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ink.opacity(0.7))
                    .lineLimit(1)
            }
            if options.steals, !context.victims.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(context.victims.prefix(3)) { victim in
                        HStack(spacing: 10) {
                            ShareAvatar(name: victim.userName, color: Color(hex: victim.userColor), image: context.avatars[victim.userId])
                            Text(victim.userName)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(ink)
                                .lineLimit(1)
                            Spacer()
                            Text("−\(Format.area(victim.stolenArea))")
                                .font(ShareStyle.number(17))
                                .foregroundStyle(Color(red: 1, green: 0.42, blue: 0.35))
                        }
                    }
                }
            }
            Spacer(minLength: 0)
            if options.ranking, let rank = context.weekRank, context.weekPlayers > 1 {
                Label("\(rank).º de \(context.weekPlayers) esta semana", systemImage: "trophy.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(ink)
            }
            ShareStatsRow(context: context, options: options, ink: ink, size: 20)
        }
        .padding(24)
        .shadow(color: options.background == .transparent ? Color.black.opacity(0.45) : Color.clear, radius: 3, x: 0, y: 1)
        .background(cardBackground(options.background))
    }
}

/// The week's league after this run.
private struct LeagueShareCard: View {
    let context: ShareContext
    let options: ShareOptions

    var body: some View {
        let entries = Array((context.summary?.week.entries ?? []).prefix(6))
        let top = max(entries.map(\.area).max() ?? 0, 1)
        VStack(alignment: .leading, spacing: 18) {
            ShareWordmark(size: 14)
            VStack(alignment: .leading, spacing: 4) {
                Text("Liga semanal")
                    .font(.system(size: 30, weight: .bold))
                    .foregroundStyle(Color.white)
                if let rank = context.weekRank {
                    Text("Voy \(rank).º de \(context.weekPlayers)")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(context.run.color)
                }
            }
            if entries.count <= 1 {
                Text("Corre con tus amigos en Runna.io para competir cada semana.")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Color.white.opacity(0.7))
            } else {
                VStack(spacing: 14) {
                    ForEach(entries) { entry in
                        let color = Color(hex: entry.color)
                        HStack(spacing: 10) {
                            Text("\(entry.rank)")
                                .font(ShareStyle.number(16))
                                .foregroundStyle(Color.white.opacity(0.6))
                                .frame(width: 16)
                            ShareAvatar(name: entry.name, color: color, image: context.avatars[entry.id], size: 30)
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(entry.name)
                                        .font(.system(size: 14, weight: entry.isMe ? .bold : .semibold))
                                        .foregroundStyle(Color.white)
                                    Spacer()
                                    Text(Format.area(entry.area))
                                        .font(ShareStyle.number(14))
                                        .foregroundStyle(Color.white.opacity(0.85))
                                }
                                GeometryReader { proxy in
                                    ZStack(alignment: .leading) {
                                        Capsule().fill(Color.white.opacity(0.1))
                                        Capsule().fill(color)
                                            .frame(width: entry.area > 0 ? max(8, proxy.size.width * entry.area / top) : 0)
                                    }
                                }
                                .frame(height: 9)
                            }
                        }
                        .padding(.vertical, entry.isMe ? 6 : 0)
                        .padding(.horizontal, entry.isMe ? 8 : 0)
                        .background(entry.isMe ? color.opacity(0.18) : Color.clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                }
            }
            Spacer(minLength: 0)
            ShareRunnaLines(context: context, options: ShareOptions(distance: false, time: false, pace: false, territory: options.territory, steals: options.steals, ranking: false), ink: .white, compact: true)
            ShareStatsRow(context: context, options: options, ink: .white, size: 22)
        }
        .padding(26)
        .background(
            LinearGradient(colors: [context.run.color.opacity(0.35), ShareStyle.night, ShareStyle.night], startPoint: .topLeading, endPoint: .bottom)
        )
    }
}

@ViewBuilder
private func cardBackground(_ background: ShareOptions.Background) -> some View {
    switch background {
    case .dark: ShareStyle.night
    case .light: ShareStyle.paper
    case .transparent: Color.clear
    }
}

// MARK: - Rendering

enum ShareCardRenderer {
    /// The card as an image (1080 px wide; transparent where the card is).
    @MainActor
    static func image(_ template: ShareTemplate, context: ShareContext, options: ShareOptions) -> UIImage? {
        let renderer = ImageRenderer(content:
            ShareCardView(template: template, context: context, options: options)
                .environment(\.colorScheme, .dark)
        )
        renderer.scale = 3
        renderer.isOpaque = !(template.allowsTransparency && options.background == .transparent)
        return renderer.uiImage
    }
}
