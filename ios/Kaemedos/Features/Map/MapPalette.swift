import SwiftUI
import MapKit

// Map colours say how a territory relates to *me*, not only whose it is:
//   - Everybody keeps the colour they chose (the server no longer forces friends apart). Each
//     phone sorts out clashes on its own map: nobody near me looks like me, and territories that
//     touch get colours that can be told apart (four colours always suffice for a map, so a 12
//     colour palette never runs out).
//   - Competition modes colour by side: my team / club vs the rival, the runners right around me in
//     Todos contra todos, who is about to fall in Eliminación.
//   - Line styles back the colours up (colour-blind friendly): solid = mine, dashed = can be
//     stolen, short dashes = in danger, no outline = in the background.

/// How a territory relates to me.
enum TerritoryRelation: Hashable {
    case mine
    /// Same team (Por equipos) or same club (Derbi, Duelo, Objetivo común).
    case ally
    /// The other team, or the rival club in the Derbi: can be stolen.
    case rival
    /// Todos contra todos / Eliminación: right above or below me in the ranking.
    case directRival
    /// Anyone else I can steal from, drawn in the background.
    case other
    /// Eliminación: about to fall in the next cut.
    case danger
    /// Global: somebody else's world map (information only).
    case overlay

    /// Whether running over it takes it.
    var isStealable: Bool {
        switch self {
        case .rival, .directRival, .other, .danger: return true
        case .mine, .ally, .overlay: return false
        }
    }
}

/// How the Global map shows the overlays.
enum GlobalView: String, CaseIterable, Identifiable {
    /// Mine and the others, all filled.
    case normal
    /// Everything somebody has run covered by fog: the clear streets are new ground.
    case unexplored
    var id: String { rawValue }

    var title: String {
        switch self {
        case .normal: return "Normal"
        case .unexplored: return "Sin pisar por nadie"
        }
    }
}

/// Fill and outline of one territory.
struct TerritoryStyle: Equatable {
    var fill: Color
    var fillOpacity: Double
    var stroke: Color
    var strokeOpacity: Double
    var lineWidth: CGFloat
    /// Empty: solid line.
    var dash: [CGFloat]

    var strokeStyle: StrokeStyle {
        StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round, dash: dash)
    }

    static let solid: [CGFloat] = []
    static let dashed: [CGFloat] = [8, 5]
    static let alert: [CGFloat] = [3, 4]
    static let dotted: [CGFloat] = [1, 5]

    static func plain(_ color: Color) -> TerritoryStyle {
        TerritoryStyle(fill: color, fillOpacity: 0.26, stroke: color, strokeOpacity: 1, lineWidth: 2.5, dash: solid)
    }
}

/// Everything the palette needs to know about the moment.
struct PaletteContext: Equatable {
    var mode: MapMode
    var myId: String?
    var myColor: String
    /// Mode of the running competition ("ffa", "teams", "derby"…), nil outside one.
    var competitionMode: String?
    var myTeam: Int?
    /// Todos contra todos / Eliminación: the runners just above and below me.
    var directRivals: Set<String> = []
    /// Eliminación: who falls if the cut were now.
    var danger: Set<String> = []
    var focusUserId: String?
    var globalView: GlobalView = .normal
}

enum MapPalette {
    /// Restyles the shapes of the current map (relation, display colour, outline).
    static func apply(_ shapes: [TerritoryShape], context: PaletteContext) -> [TerritoryShape] {
        let mine = LabColor(hex: context.myColor) ?? LabColor(r: 0.09, g: 0.64, b: 0.29)
        var result = shapes
        for index in result.indices {
            result[index].relation = relation(of: result[index], context: context)
        }
        // Individual colours: protected from mine, and different from the territories they touch
        let individual = Set(result.filter { needsIndividualColor($0.relation) }.map(\.userId))
        let colors = individualColors(
            for: result.filter { individual.contains($0.userId) },
            mine: mine,
            priority: context.directRivals.union(context.danger),
            checkNeighbours: context.mode == .competition
        )
        let rivalColor = contrastColor(to: mine)
        let allyColor = mine.adjustingLightness(by: 14).color
        let myColor = mine.color
        let iAmInDanger = context.myId.map { context.danger.contains($0) } ?? false

        for index in result.indices {
            let shape = result[index]
            let own = colors[shape.userId] ?? shape.color
            result[index].displayColor = shape.relation == .mine ? myColor : (shape.relation == .ally ? allyColor : (shape.relation == .rival ? rivalColor : own))
            result[index].style = style(
                for: shape,
                color: result[index].displayColor,
                context: context,
                iAmInDanger: iAmInDanger
            )
        }
        return result
    }

    private static func needsIndividualColor(_ relation: TerritoryRelation) -> Bool {
        switch relation {
        case .directRival, .other, .danger, .overlay: return true
        case .mine, .ally, .rival: return false
        }
    }

    private static func relation(of shape: TerritoryShape, context: PaletteContext) -> TerritoryRelation {
        let isMine = shape.userId == "me" || (context.myId != nil && shape.userId == context.myId)
        if isMine { return .mine }
        if context.mode == .global { return .overlay }
        switch context.competitionMode {
        case "teams":
            guard let team = shape.team, let myTeam = context.myTeam else { return .other }
            return team == myTeam ? .ally : .rival
        case "derby":
            return shape.isRival ? .rival : .ally
        case "duel", "target":
            // Nobody steals inside the club
            return .ally
        default:
            // Todos contra todos, Eliminación (and anything new): everyone for themselves
            if context.danger.contains(shape.userId) { return .danger }
            if context.directRivals.contains(shape.userId) { return .directRival }
            return .other
        }
    }

    private static func style(for shape: TerritoryShape, color: Color, context: PaletteContext, iAmInDanger: Bool) -> TerritoryStyle {
        // "Sin pisar por nadie": every territory is fog
        if context.mode == .global && context.globalView == .unexplored {
            return TerritoryStyle(fill: .mapFog, fillOpacity: 0.55, stroke: .clear, strokeOpacity: 0, lineWidth: 0, dash: TerritoryStyle.solid)
        }
        // Focus: the chosen runner (and me) in full, everybody else almost gone
        if let focus = context.focusUserId, shape.relation != .mine {
            if shape.userId == focus {
                // In Global (comparing world maps) their area, without an outline that reads as a route
                if context.mode == .global {
                    return TerritoryStyle(fill: color, fillOpacity: 0.4, stroke: .clear, strokeOpacity: 0, lineWidth: 0, dash: TerritoryStyle.solid)
                }
                return TerritoryStyle(fill: color, fillOpacity: 0.34, stroke: color, strokeOpacity: 1, lineWidth: 3, dash: TerritoryStyle.solid)
            }
            return TerritoryStyle(fill: color, fillOpacity: 0.04, stroke: .clear, strokeOpacity: 0, lineWidth: 0, dash: TerritoryStyle.solid)
        }
        var style: TerritoryStyle
        switch shape.relation {
        case .mine:
            style = TerritoryStyle(fill: color, fillOpacity: 0.34, stroke: iAmInDanger ? .steal : color, strokeOpacity: 1, lineWidth: 3, dash: iAmInDanger ? TerritoryStyle.alert : TerritoryStyle.solid)
        case .ally:
            style = TerritoryStyle(fill: color, fillOpacity: 0.2, stroke: color, strokeOpacity: 0.55, lineWidth: 1, dash: TerritoryStyle.solid)
        case .rival:
            style = TerritoryStyle(fill: color, fillOpacity: 0.26, stroke: color, strokeOpacity: 1, lineWidth: 2.5, dash: TerritoryStyle.dashed)
        case .directRival:
            style = TerritoryStyle(fill: color, fillOpacity: 0.3, stroke: color, strokeOpacity: 1, lineWidth: 2.5, dash: TerritoryStyle.dashed)
        case .other:
            style = TerritoryStyle(fill: color, fillOpacity: 0.14, stroke: .clear, strokeOpacity: 0, lineWidth: 0, dash: TerritoryStyle.solid)
        case .danger:
            style = TerritoryStyle(fill: color, fillOpacity: 0.22, stroke: .steal, strokeOpacity: 1, lineWidth: 2.5, dash: TerritoryStyle.alert)
        case .overlay:
            // Other people's world maps: their area, filled and with no outline (an outline reads as
            // the route they ran); light, so where they overlap the colours still show through
            style = TerritoryStyle(fill: color, fillOpacity: 0.3, stroke: .clear, strokeOpacity: 0, lineWidth: 0, dash: TerritoryStyle.solid)
        }
        // Ran together: dotted outline
        if shape.isShared && shape.relation != .overlay {
            style.dash = TerritoryStyle.dotted
            style.fillOpacity += 0.04
            if style.lineWidth == 0 {
                style.lineWidth = 2
                style.stroke = color
                style.strokeOpacity = 0.8
            }
        }
        return style
    }

    // MARK: - Individual colours

    /// The colour of the rival side: whichever of a few strong colours is furthest from mine.
    static func contrastColor(to mine: LabColor) -> Color {
        let candidates = ["#D7263D", "#1E6FD9", "#F18F01"].compactMap { LabColor(hex: $0) }
        return (candidates.max { $0.distance(to: mine) < $1.distance(to: mine) } ?? candidates[0]).color
    }

    /// Distance (CIE76 ΔE) below which two colours look alike on the map.
    private static let similar: Double = 22
    /// Stricter margin around my own colour: I must never doubt which zones are mine.
    private static let nearMine: Double = 30

    /// One colour per runner: their own if it is clear of mine and of the runners they touch,
    /// otherwise the closest alternative that is (lighter/darker shades first, then other colours).
    private static func individualColors(for shapes: [TerritoryShape], mine: LabColor, priority: Set<String>, checkNeighbours: Bool) -> [String: Color] {
        struct Runner {
            let id: String
            let own: LabColor
            var boxes: [MKMapRect]
            var bounds: MKMapRect
            var size: Double
        }
        var runners: [String: Runner] = [:]
        for shape in shapes {
            let box = shape.polygon.boundingMapRect
            if var runner = runners[shape.userId] {
                runner.boxes.append(box)
                runner.bounds = runner.bounds.union(box)
                runner.size += box.size.width * box.size.height
                runners[shape.userId] = runner
            } else {
                runners[shape.userId] = Runner(
                    id: shape.userId,
                    own: LabColor(hex: shape.hex) ?? LabColor(r: 0.5, g: 0.5, b: 0.5),
                    boxes: [box],
                    bounds: box,
                    size: box.size.width * box.size.height
                )
            }
        }
        // Who goes first keeps their colour: the runners that matter most, then the biggest maps
        let order = runners.values.sorted { lhs, rhs in
            let lp = priority.contains(lhs.id), rp = priority.contains(rhs.id)
            if lp != rp { return lp }
            return lhs.size > rhs.size
        }
        // Touching = bounding boxes closer than ~200 m
        let margin = MKMapPointsPerMeterAtLatitude(order.first.map { $0.bounds.origin.coordinate.latitude } ?? 40) * 200
        func touch(_ a: Runner, _ b: Runner) -> Bool {
            guard a.bounds.insetBy(dx: -margin, dy: -margin).intersects(b.bounds) else { return false }
            for boxA in a.boxes {
                let grown = boxA.insetBy(dx: -margin, dy: -margin)
                if b.boxes.contains(where: { grown.intersects($0) }) { return true }
            }
            return false
        }

        let palette = (AppConfig.userColors + extraColors).compactMap { LabColor(hex: $0) }
        var assigned: [String: LabColor] = [:]
        var placed: [Runner] = []
        for runner in order {
            let neighbours: [LabColor] = checkNeighbours
                ? placed.filter { touch($0, runner) }.compactMap { assigned[$0.id] }
                : []
            let candidates = [runner.own]
                + [12.0, -12, 24, -24].map { runner.own.adjustingLightness(by: $0) }
                + palette.sorted { $0.distance(to: runner.own) < $1.distance(to: runner.own) }
            let pick = candidates.first { candidate in
                candidate.distance(to: mine) >= nearMine && neighbours.allSatisfy { candidate.distance(to: $0) >= similar }
            } ?? candidates.first { $0.distance(to: mine) >= nearMine } ?? runner.own
            assigned[runner.id] = pick
            placed.append(runner)
        }
        return assigned.mapValues(\.color)
    }

    /// Extra colours beyond the 12 that people choose, only used to tell neighbours apart.
    private static let extraColors = ["#1B9E77", "#7A7A00", "#1F3A93", "#D4A017", "#17BECF", "#8C1D40", "#66C2A5", "#5E4FA2"]
}

// MARK: - Colour maths

/// A colour in CIELAB, where distances match how different two colours look.
struct LabColor: Equatable {
    let l: Double
    let a: Double
    let b: Double

    init(l: Double, a: Double, b: Double) {
        self.l = l
        self.a = a
        self.b = b
    }

    /// From sRGB components 0…1.
    init(r: Double, g: Double, b blue: Double) {
        func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        let lr = linear(r), lg = linear(g), lb = linear(blue)
        // sRGB → XYZ (D65), normalised by the white point
        let x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047
        let y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
        let z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883
        func f(_ t: Double) -> Double { t > 0.008856 ? cbrt(t) : 7.787 * t + 16.0 / 116.0 }
        let fx = f(x), fy = f(y), fz = f(z)
        l = 116 * fy - 16
        a = 500 * (fx - fy)
        b = 200 * (fy - fz)
    }

    init?(hex: String) {
        var text = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        self.init(
            r: Double((value >> 16) & 0xFF) / 255,
            g: Double((value >> 8) & 0xFF) / 255,
            b: Double(value & 0xFF) / 255
        )
    }

    func distance(to other: LabColor) -> Double {
        let dl = l - other.l, da = a - other.a, db = b - other.b
        return (dl * dl + da * da + db * db).squareRoot()
    }

    /// Same hue, lighter (positive) or darker (negative).
    func adjustingLightness(by amount: Double) -> LabColor {
        LabColor(l: min(80, max(22, l + amount)), a: a, b: b)
    }

    /// Back to sRGB (clamped).
    var rgb: (r: Double, g: Double, b: Double) {
        let fy = (l + 16) / 116
        let fx = fy + a / 500
        let fz = fy - b / 200
        func finv(_ t: Double) -> Double { t * t * t > 0.008856 ? t * t * t : (t - 16.0 / 116.0) / 7.787 }
        let x = finv(fx) * 0.95047, y = finv(fy), z = finv(fz) * 1.08883
        let lr = 3.2406 * x - 1.5372 * y - 0.4986 * z
        let lg = -0.9689 * x + 1.8758 * y + 0.0415 * z
        let lb = 0.0557 * x - 0.2040 * y + 1.0570 * z
        func gamma(_ c: Double) -> Double {
            let v = c <= 0.0031308 ? 12.92 * c : 1.055 * pow(max(c, 0), 1 / 2.4) - 0.055
            return min(1, max(0, v))
        }
        return (gamma(lr), gamma(lg), gamma(lb))
    }

    var color: Color {
        let value = rgb
        return Color(red: value.r, green: value.g, blue: value.b)
    }
}

extension Color {
    /// "Sin pisar por nadie": the fog over ground somebody has already run.
    static let mapFog = Color.adaptive(light: 0x5B6472, dark: 0x0B0D12)
}
