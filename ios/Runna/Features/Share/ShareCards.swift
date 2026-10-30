import SwiftUI
import UIKit

// Share cards, drawn at a fixed width in points and rendered at 3x (1080 px wide) with ImageRenderer.
// Minimal look: big condensed figures, small grey labels, one colour accent, thin lines.

// MARK: - Style

enum ShareStyle {
    static let night = Color(red: 0.039, green: 0.039, blue: 0.043)
    static let paper = Color(red: 0.98, green: 0.98, blue: 0.969)
    static let steal = Color(red: 1, green: 0.42, blue: 0.35)
    static let gold = Color(red: 1, green: 0.78, blue: 0.25)

    static func number(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight).width(.condensed)
    }

    static func label(_ size: CGFloat = 9) -> Font {
        .system(size: size, weight: .semibold)
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
        return date.formatted(.dateTime.day().month(.wide).year().locale(Locale(identifier: "es_ES")))
    }
}

/// "powered by [logo] Runna.io" (or just the mark).
struct ShareWordmark: View {
    var ink: Color = .white
    var size: CGFloat = 13
    var poweredBy = true

    var body: some View {
        HStack(spacing: size * 0.35) {
            if poweredBy {
                Text("powered by")
                    .font(.system(size: size * 0.78, weight: .regular))
                    .foregroundStyle(ink.opacity(0.55))
            }
            Image("RunnaMark")
                .resizable()
                .scaledToFill()
                .frame(width: size * 1.25, height: size * 1.25)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
            Text("Runna.io")
                .font(.system(size: size, weight: .semibold))
                .foregroundStyle(ink.opacity(0.92))
        }
    }
}

/// Value over a tiny uppercase label.
private struct ShareStat: View {
    let value: String
    let label: String
    let ink: Color
    var size: CGFloat = 28
    var alignment: HorizontalAlignment = .leading

    var body: some View {
        VStack(alignment: alignment, spacing: 2) {
            Text(value)
                .font(ShareStyle.number(size))
                .foregroundStyle(ink)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(label.uppercased())
                .font(ShareStyle.label())
                .tracking(1.2)
                .foregroundStyle(ink.opacity(0.5))
        }
    }
}

/// Distance, time and pace, as chosen.
private struct ShareStatsRow: View {
    let context: ShareContext
    let options: ShareOptions
    let ink: Color
    var size: CGFloat = 28
    var centered = false

    var body: some View {
        HStack(alignment: .top, spacing: centered ? 26 : 22) {
            if options.distance {
                ShareStat(value: Format.distance(context.run.distance), label: "Distancia", ink: ink, size: size, alignment: centered ? .center : .leading)
            }
            if options.time {
                ShareStat(value: Format.duration(context.run.duration), label: "Tiempo", ink: ink, size: size, alignment: centered ? .center : .leading)
            }
            if options.pace, let pace = context.run.paceText {
                ShareStat(value: pace, label: "Ritmo /km", ink: ink, size: size, alignment: centered ? .center : .leading)
            }
        }
    }
}

/// Territory, steals, castles and ranking: only the ones with data, each with a small colour dot.
private struct ShareRunnaLines: View {
    let context: ShareContext
    let options: ShareOptions
    let ink: Color
    var centered = false
    var size: CGFloat = 14

    private var lines: [(color: Color, text: String, strong: Bool)] {
        var result: [(color: Color, text: String, strong: Bool)] = []
        if options.territory, context.newArea >= 1 {
            result.append((color: context.run.color, text: "+\(Format.area(context.newArea)) conquistados", strong: true))
        }
        if options.steals, context.hasSteals {
            result.append((color: ShareStyle.steal, text: "Robado a \(ShareStyle.names(context.victims.map(\.userName)))", strong: false))
        }
        if options.territory, context.castlesBuilt > 0 {
            result.append((color: ink.opacity(0.7), text: context.castlesBuilt == 1 ? "+1 castillo" : "+\(context.castlesBuilt) castillos", strong: false))
        }
        if options.ranking, context.hasRanking, let rank = context.weekRank {
            result.append((color: ShareStyle.gold, text: "\(rank).º de \(context.weekPlayers) esta semana", strong: false))
        }
        return result
    }

    var body: some View {
        if !lines.isEmpty {
            VStack(alignment: centered ? .center : .leading, spacing: 6) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    HStack(spacing: 7) {
                        Circle().fill(line.color).frame(width: 6, height: 6)
                        Text(line.text)
                            .font(.system(size: size, weight: line.strong ? .semibold : .medium))
                            .foregroundStyle(ink.opacity(line.strong ? 1 : 0.85))
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                    }
                }
            }
        }
    }
}

/// Round picture or initials on the player's colour.
private struct ShareAvatar: View {
    let name: String
    let color: Color
    let image: UIImage?
    var size: CGFloat = 24

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Text(String(name.prefix(1)).uppercased())
                    .font(.system(size: size * 0.44, weight: .semibold))
                    .foregroundStyle(Color.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(color)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }
}

// MARK: - Cards

/// Any template at its export width (the sticker's height follows its content).
struct ShareCardView: View {
    let template: ShareTemplate
    let context: ShareContext
    let options: ShareOptions

    var body: some View {
        switch template {
        case .sticker:
            StickerCard(context: context, options: options)
                .frame(width: template.size.width)
                .fixedSize(horizontal: false, vertical: true)
        case .map:
            MapShareCard(context: context, options: options)
                .frame(width: template.size.width, height: template.size.height)
        case .conquest:
            ConquestShareCard(context: context, options: options)
                .frame(width: template.size.width, height: template.size.height)
        case .league:
            LeagueShareCard(context: context, options: options)
                .frame(width: template.size.width, height: template.size.height)
        }
    }
}

/// Route silhouette and figures, centred, to paste over a photo.
private struct StickerCard: View {
    let context: ShareContext
    let options: ShareOptions

    var body: some View {
        let ink = ShareStyle.ink(options.background)
        let line = options.background == .light ? context.run.color : Color.white
        VStack(spacing: 18) {
            GeometryReader { proxy in
                ShareGeometry.path(ShareGeometry.fit(context.run.coordinates, in: CGRect(origin: .zero, size: proxy.size), padding: 4))
                    .stroke(line, style: StrokeStyle(lineWidth: 4.5, lineCap: .round, lineJoin: .round))
            }
            .frame(width: 250, height: 190)
            ShareStatsRow(context: context, options: options, ink: ink, size: 30, centered: true)
            ShareRunnaLines(context: context, options: options, ink: ink, centered: true)
            ShareWordmark(ink: ink, size: 12)
                .padding(.top, 2)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity)
        .shadow(color: options.background == .transparent ? Color.black.opacity(0.35) : Color.clear, radius: 6, x: 0, y: 2)
        .background(cardBackground(options.background))
    }
}

/// Dark map with the route and the territory, figures at the bottom.
private struct MapShareCard: View {
    let context: ShareContext
    let options: ShareOptions

    var body: some View {
        ZStack {
            if let map = context.mapImage {
                Image(uiImage: map).resizable().scaledToFill()
            } else {
                ShareStyle.night
            }
            LinearGradient(
                colors: [Color.black.opacity(0.55), Color.black.opacity(0), Color.black.opacity(0), Color.black.opacity(0.8)],
                startPoint: .top, endPoint: .bottom
            )
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(context.run.name)
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(Color.white)
                        .lineLimit(1)
                    Text(ShareStyle.day(context.run.date))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Color.white.opacity(0.6))
                }
                Spacer(minLength: 0)
                VStack(alignment: .leading, spacing: 14) {
                    ShareStatsRow(context: context, options: options, ink: .white, size: 30)
                    ShareRunnaLines(context: context, options: options, ink: .white, size: 13)
                    HStack {
                        Spacer()
                        ShareWordmark(ink: .white, size: 11)
                    }
                }
            }
            .padding(22)
        }
        .clipped()
    }
}

/// The conquest, big: area, whom you stole from and your place in the week.
private struct ConquestShareCard: View {
    let context: ShareContext
    let options: ShareOptions

    var body: some View {
        let ink = ShareStyle.ink(options.background)
        VStack(alignment: .leading, spacing: 0) {
            Text(ShareStyle.day(context.run.date).uppercased())
                .font(ShareStyle.label(10))
                .tracking(1.4)
                .foregroundStyle(ink.opacity(0.5))
            Spacer(minLength: 12)
            if context.newArea >= 1 {
                Text("+\(Format.area(context.newArea))")
                    .font(ShareStyle.number(76, weight: .bold))
                    .foregroundStyle(context.run.color)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                Text("conquistados en \(context.run.name)")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(ink.opacity(0.6))
                    .lineLimit(1)
            } else {
                Text(context.run.name)
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(ink)
                    .lineLimit(2)
            }
            if options.steals, context.hasSteals {
                VStack(spacing: 0) {
                    ForEach(context.victims.prefix(3)) { victim in
                        HStack(spacing: 10) {
                            ShareAvatar(name: victim.userName, color: Color(hex: victim.userColor), image: context.avatars[victim.userId])
                            Text(victim.userName)
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(ink)
                                .lineLimit(1)
                            Spacer()
                            Text("−\(Format.area(victim.stolenArea))")
                                .font(ShareStyle.number(16))
                                .foregroundStyle(ShareStyle.steal)
                        }
                        .padding(.vertical, 9)
                        .overlay(alignment: .bottom) {
                            Rectangle().fill(ink.opacity(0.1)).frame(height: 0.5)
                        }
                    }
                }
                .padding(.top, 18)
            }
            Spacer(minLength: 12)
            if options.ranking, context.hasRanking, let rank = context.weekRank {
                HStack(spacing: 7) {
                    Circle().fill(ShareStyle.gold).frame(width: 6, height: 6)
                    Text("\(rank).º de \(context.weekPlayers) esta semana")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(ink.opacity(0.85))
                }
                .padding(.bottom, 14)
            }
            HStack(alignment: .bottom) {
                ShareStatsRow(context: context, options: options, ink: ink, size: 20)
                Spacer(minLength: 8)
                ShareWordmark(ink: ink, size: 10)
            }
        }
        .padding(24)
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
        VStack(alignment: .leading, spacing: 0) {
            Text("LIGA SEMANAL")
                .font(ShareStyle.label(10))
                .tracking(1.6)
                .foregroundStyle(Color.white.opacity(0.5))
            if let rank = context.weekRank, context.hasRanking {
                Text("\(rank).º de \(context.weekPlayers)")
                    .font(ShareStyle.number(52, weight: .bold))
                    .foregroundStyle(Color.white)
                    .padding(.top, 4)
            }
            VStack(spacing: 16) {
                ForEach(entries) { entry in
                    let color = Color(hex: entry.color)
                    VStack(spacing: 6) {
                        HStack(spacing: 9) {
                            Text("\(entry.rank)")
                                .font(ShareStyle.number(14))
                                .foregroundStyle(Color.white.opacity(0.45))
                                .frame(width: 14, alignment: .leading)
                            ShareAvatar(name: entry.name, color: color, image: context.avatars[entry.id], size: 22)
                            Text(entry.name)
                                .font(.system(size: 14, weight: entry.isMe ? .semibold : .regular))
                                .foregroundStyle(entry.isMe ? color : Color.white)
                                .lineLimit(1)
                            Spacer()
                            Text(Format.area(entry.area))
                                .font(ShareStyle.number(14))
                                .foregroundStyle(Color.white.opacity(entry.isMe ? 1 : 0.7))
                        }
                        GeometryReader { proxy in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Color.white.opacity(0.08))
                                Capsule().fill(color.opacity(entry.isMe ? 1 : 0.75))
                                    .frame(width: entry.area > 0 ? max(6, proxy.size.width * entry.area / top) : 0)
                            }
                        }
                        .frame(height: 6)
                    }
                }
            }
            .padding(.top, 26)
            Spacer(minLength: 16)
            ShareRunnaLines(
                context: context,
                options: ShareOptions(distance: false, time: false, pace: false, territory: options.territory, steals: options.steals, ranking: false),
                ink: .white,
                size: 13
            )
            HStack(alignment: .bottom) {
                ShareStatsRow(context: context, options: options, ink: .white, size: 20)
                Spacer(minLength: 8)
                ShareWordmark(ink: .white, size: 10)
            }
            .padding(.top, 14)
        }
        .padding(26)
        .background(
            ZStack {
                ShareStyle.night
                RadialGradient(colors: [context.run.color.opacity(0.35), Color.clear], center: .topTrailing, startRadius: 0, endRadius: 360)
            }
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
