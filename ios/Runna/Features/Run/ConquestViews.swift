import SwiftUI
import MapKit
import CoreLocation

/// Territory won in a run: big conquered area, total stolen and the victims, each with a button to send them a photo.
struct ConquestCard: View {
    let result: ConquestResult
    /// Victims who already got a photo for this run.
    let sentVictimIds: Set<String>
    let onTaunt: (Victim) -> Void

    @State private var appeared = false

    var body: some View {
        VStack(spacing: DS.Spacing.l) {
            conqueredHero
            let victims = result.stolenVictims
            if !victims.isEmpty {
                stolenSection(victims)
            }
        }
        .onAppear {
            withAnimation(.spring(response: 0.6, dampingFraction: 0.7).delay(0.15)) { appeared = true }
        }
    }

    private var conqueredHero: some View {
        let parts = Format.areaParts(result.newAreaConquered)
        return VStack(spacing: DS.Spacing.s) {
            Label("Territorio conquistado", systemImage: "flag.fill")
                .font(Font.statLabel)
                .textCase(.uppercase)
                .tracking(0.8)
                .foregroundStyle(Color.white.opacity(0.9))
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("+\(parts.value)")
                    .font(.system(size: 56, weight: .heavy, design: .rounded))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                Text(parts.unit)
                    .font(.system(.title2, design: .rounded, weight: .bold))
                    .opacity(0.85)
            }
            .foregroundStyle(.white)
            .scaleEffect(appeared ? 1 : 0.6)
            .opacity(appeared ? 1 : 0)
            if result.totalStolen > 0 {
                Label("\(Format.area(result.totalStolen)) robados", systemImage: "bolt.fill")
                    .font(.system(.subheadline, design: .rounded, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, DS.Spacing.m)
                    .padding(.vertical, 6)
                    .background(.stealGradient, in: Capsule())
                    .overlay(Capsule().strokeBorder(Color.white.opacity(0.35), lineWidth: 1))
            } else if result.newAreaConquered <= 0 {
                Text("Esta vez no has sumado terreno nuevo. ¡La próxima, por calles sin pintar!")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.white.opacity(0.9))
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.vertical, DS.Spacing.xxl)
        .padding(.horizontal, DS.Spacing.l)
        .frame(maxWidth: .infinity)
        .background(.brandGradient, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
        .overlay(alignment: .topTrailing) {
            Image(systemName: "sparkles")
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(Color.white.opacity(0.7))
                .symbolEffect(.bounce, value: appeared)
                .padding(DS.Spacing.l)
        }
        .shadow(color: Color.brand.opacity(0.35), radius: 16, x: 0, y: 8)
        .accessibilityElement(children: .combine)
    }

    private func stolenSection(_ victims: [Victim]) -> some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            HStack(spacing: DS.Spacing.s) {
                Image(systemName: "bolt.shield.fill")
                    .foregroundStyle(Color.steal)
                Text(victims.count == 1 ? "Has asaltado a" : "Has asaltado a \(victims.count) rivales")
                    .font(Font.cardTitle)
                Spacer()
            }
            ForEach(victims) { victim in
                ConquestVictimRow(victim: victim, sent: sentVictimIds.contains(victim.userId)) {
                    onTaunt(victim)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        .overlay(
            RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous)
                .strokeBorder(Color.steal.opacity(0.35), lineWidth: 1.5)
        )
    }
}

/// One victim: their colour, what you took and the "send photo" button.
private struct ConquestVictimRow: View {
    let victim: Victim
    let sent: Bool
    let onTaunt: () -> Void

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            AvatarView(name: victim.userName, avatar: nil, color: victim.userColor, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(victim.userName)
                    .font(.system(.body, design: .rounded, weight: .bold))
                    .lineLimit(1)
                Text("−\(Format.area(victim.stolenArea))")
                    .font(.system(.subheadline, design: .rounded, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(Color.steal)
            }
            Spacer(minLength: DS.Spacing.s)
            actionView
        }
        .padding(DS.Spacing.m)
        .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
        .animation(.snappy, value: sent)
    }

    @ViewBuilder
    private var actionView: some View {
        if sent {
            Label("Enviada", systemImage: "checkmark.circle.fill")
                .font(.system(.footnote, design: .rounded, weight: .bold))
                .foregroundStyle(Color.brand)
                .transition(.scale.combined(with: .opacity))
        } else {
            Button(action: onTaunt) {
                Label("Foto", systemImage: "camera.fill")
                    .font(.system(.subheadline, design: .rounded, weight: .heavy))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 38)
                    .background(.stealGradient, in: Capsule())
                    .shadow(color: Color.steal.opacity(0.35), radius: 6, x: 0, y: 3)
            }
            .buttonStyle(.pressable)
            .accessibilityLabel("Enviar foto a \(victim.userName)")
        }
    }
}

// MARK: - Celebration pieces (shared by the run summary and the conquest inbox)

/// Gradient hero with a title, a subtitle and a burst of sparkles.
struct RunCelebrationHeader: View {
    let title: String
    let subtitle: String
    var systemImage: String = "flag.checkered"
    var isWorking: Bool = false

    @State private var appeared = false

    var body: some View {
        VStack(spacing: DS.Spacing.s) {
            ZStack {
                if !isWorking {
                    RunConfettiBurst()
                        .frame(width: 220, height: 140)
                }
                Image(systemName: isWorking ? "hourglass" : systemImage)
                    .font(.system(size: 34, weight: .heavy))
                    .foregroundStyle(.white)
                    .frame(width: 72, height: 72)
                    .background(isWorking ? AnyShapeStyle(LinearGradient.grapeGradient) : AnyShapeStyle(LinearGradient.brandGradient), in: Circle())
                    .overlay(Circle().strokeBorder(Color.white.opacity(0.4), lineWidth: 2))
                    .shadow(color: Color.brand.opacity(0.4), radius: 12, x: 0, y: 6)
                    .symbolEffect(.bounce, value: appeared)
                    .symbolEffect(.pulse, isActive: isWorking)
                    .scaleEffect(appeared ? 1 : 0.5)
            }
            .frame(height: 120)
            Text(title)
                .font(.system(size: 30, weight: .heavy, design: .rounded))
                .multilineTextAlignment(.center)
                .contentTransition(.opacity)
            Text(subtitle)
                .font(.system(.subheadline, design: .rounded, weight: .medium))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .sensoryFeedback(.success, trigger: appeared)
        .onAppear {
            withAnimation(.spring(response: 0.55, dampingFraction: 0.55)) { appeared = true }
        }
    }
}

/// Confetti-like burst of coloured symbols flying out from the centre (once).
struct RunConfettiBurst: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var exploded = false

    private struct Piece {
        let symbol: String
        let color: Color
        let angle: Double
        let distance: CGFloat
        let size: CGFloat
        let spin: Double
    }

    private let pieces: [Piece] = {
        let symbols = ["star.fill", "sparkle", "circle.fill", "triangle.fill", "heart.fill", "diamond.fill"]
        let colors: [Color] = [Color.brand, Color.brandLime, Color.gold, Color.steal, Color.sky, Color.grape]
        var result: [Piece] = []
        for index in 0..<18 {
            let angle = Double(index) / 18.0 * 2 * Double.pi + (index.isMultiple(of: 2) ? 0.15 : -0.1)
            let distance: CGFloat = index.isMultiple(of: 3) ? 104 : (index.isMultiple(of: 2) ? 84 : 66)
            result.append(Piece(
                symbol: symbols[index % symbols.count],
                color: colors[(index * 5) % colors.count],
                angle: angle,
                distance: distance,
                size: index.isMultiple(of: 4) ? 14 : 10,
                spin: Double((index % 5) * 70 - 140)
            ))
        }
        return result
    }()

    var body: some View {
        ZStack {
            ForEach(0..<pieces.count, id: \.self) { index in
                pieceView(pieces[index])
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear {
            if reduceMotion {
                exploded = true
            } else {
                withAnimation(.spring(response: 0.9, dampingFraction: 0.6).delay(0.1)) { exploded = true }
            }
        }
    }

    private func pieceView(_ piece: Piece) -> some View {
        let dx = CGFloat(cos(piece.angle)) * piece.distance
        let dy = CGFloat(sin(piece.angle)) * piece.distance * 0.62
        return Image(systemName: piece.symbol)
            .font(.system(size: piece.size, weight: .bold))
            .foregroundStyle(piece.color)
            .rotationEffect(.degrees(exploded ? piece.spin : 0))
            .offset(x: exploded ? dx : 0, y: exploded ? dy : 0)
            .scaleEffect(exploded ? 1 : 0.2)
            .opacity(exploded ? 0.95 : 0)
    }
}

/// Distance · time · pace in one card (big rounded numbers).
struct RunStatsCard: View {
    let distance: Double
    let duration: Int

    var body: some View {
        HStack(spacing: 0) {
            StatTile(value: Format.distance(distance), label: "Distancia", tint: Color.sky)
            divider
            StatTile(value: Format.duration(duration), label: "Tiempo")
            divider
            StatTile(value: Format.pace(distanceMeters: distance, seconds: duration), label: "Ritmo", tint: Color.brand)
        }
        .card(padding: DS.Spacing.l)
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.hairline)
            .frame(width: 1, height: 40)
    }
}

/// Card with a spinner (or icon) and a short status message.
struct RunStatusCard: View {
    let systemImage: String
    let title: String
    let message: String
    var tint: Color = Color.brand
    var isLoading: Bool = false

    var body: some View {
        HStack(alignment: .top, spacing: DS.Spacing.m) {
            ZStack {
                Circle()
                    .fill(tint.opacity(0.14))
                    .frame(width: 44, height: 44)
                if isLoading {
                    ProgressView()
                        .tint(tint)
                } else {
                    Image(systemName: systemImage)
                        .font(.headline)
                        .foregroundStyle(tint)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(Font.cardTitle)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

/// One treasure in a run summary.
struct TreasureLine: Identifiable, Hashable {
    let id: String
    let emoji: String
    let name: String
    let rarity: String

    /// Live-collected treasures plus the ones the server collected along the route, without duplicates.
    static func merge(live: [Treasure], server: [CollectedTreasure]) -> [TreasureLine] {
        var lines: [TreasureLine] = []
        var seen: Set<String> = []
        for treasure in live where !seen.contains(treasure.id) {
            seen.insert(treasure.id)
            lines.append(TreasureLine(
                id: treasure.id,
                emoji: treasure.emoji ?? "🎁",
                name: treasure.powerName ?? treasure.name,
                rarity: treasure.rarity
            ))
        }
        for treasure in server where !seen.contains(treasure.treasureId) {
            seen.insert(treasure.treasureId)
            lines.append(TreasureLine(id: treasure.treasureId, emoji: "🎁", name: treasure.treasureName, rarity: treasure.rarity))
        }
        return lines
    }

    static func rarityName(_ rarity: String) -> String {
        switch rarity.lowercased() {
        case "common": return "Común"
        case "rare": return "Raro"
        case "epic": return "Épico"
        case "legendary": return "Legendario"
        default: return rarity.capitalized
        }
    }

    static func rarityColor(_ rarity: String) -> Color {
        switch rarity.lowercased() {
        case "rare": return Color.sky
        case "epic": return Color.grape
        case "legendary": return Color.gold
        default: return Color.secondary
        }
    }
}

struct TreasuresCard: View {
    let treasures: [TreasureLine]

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            HStack(spacing: DS.Spacing.s) {
                Image(systemName: "gift.fill")
                    .foregroundStyle(.goldGradient)
                    .symbolEffect(.bounce, value: treasures.count)
                Text(treasures.count == 1 ? "¡Tesoro encontrado!" : "¡\(treasures.count) tesoros encontrados!")
                    .font(Font.cardTitle)
                Spacer()
            }
            ForEach(treasures) { treasure in
                row(treasure)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        .overlay(
            RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous)
                .strokeBorder(Color.gold.opacity(0.45), lineWidth: 1.5)
        )
    }

    private func row(_ treasure: TreasureLine) -> some View {
        let color = TreasureLine.rarityColor(treasure.rarity)
        return HStack(spacing: DS.Spacing.m) {
            Text(treasure.emoji)
                .font(.title2)
                .frame(width: 44, height: 44)
                .background(color.opacity(0.15), in: RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous))
            Text(treasure.name)
                .font(.system(.body, design: .rounded, weight: .semibold))
                .lineLimit(2)
            Spacer(minLength: DS.Spacing.s)
            Text(TreasureLine.rarityName(treasure.rarity))
                .font(.system(.caption, design: .rounded, weight: .heavy))
                .textCase(.uppercase)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(color.opacity(0.15), in: Capsule())
                .foregroundStyle(color)
        }
    }
}

/// Replays the route: the line grows from start to finish over a few seconds.
struct RouteReplayView: View {
    let coordinates: [CLLocationCoordinate2D]
    let color: Color
    var duration: Double = 4
    var height: CGFloat = 240

    @State private var progress: Double = 0
    @State private var replayToken = 0

    var body: some View {
        let count = visibleCount
        let shown: [CLLocationCoordinate2D] = Array(coordinates.prefix(count))
        ZStack(alignment: .bottomTrailing) {
            Map(initialPosition: Self.cameraPosition(for: coordinates), interactionModes: []) {
                if shown.count >= 2 {
                    MapPolyline(coordinates: shown)
                        .stroke(Color.white.opacity(0.9), style: StrokeStyle(lineWidth: 9, lineCap: .round, lineJoin: .round))
                    MapPolyline(coordinates: shown)
                        .stroke(color, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
                }
                if let start = coordinates.first {
                    Annotation("Salida", coordinate: start) {
                        Circle()
                            .fill(Color.brand)
                            .frame(width: 14, height: 14)
                            .overlay(Circle().stroke(Color.white, lineWidth: 2))
                    }
                    .annotationTitles(.hidden)
                }
                if let head = shown.last {
                    Annotation(progress >= 1 ? "Meta" : String(), coordinate: head) {
                        Circle()
                            .fill(progress >= 1 ? Color.steal : color)
                            .frame(width: 16, height: 16)
                            .overlay(Circle().stroke(Color.white, lineWidth: 3))
                            .shadow(radius: 2)
                    }
                    .annotationTitles(.hidden)
                }
            }

            if progress >= 1, coordinates.count >= 2 {
                Button {
                    replayToken += 1
                } label: {
                    Label("Repetir", systemImage: "arrow.counterclockwise")
                        .font(.system(.footnote, design: .rounded, weight: .bold))
                        .padding(.horizontal, 12)
                        .frame(height: 34)
                        .glassSurface(Capsule(), interactive: true)
                }
                .buttonStyle(.pressable)
                .padding(DS.Spacing.m)
                .transition(.scale.combined(with: .opacity))
                .accessibilityLabel("Repetir recorrido")
            }
        }
        .frame(height: height)
        .clipShape(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous).strokeBorder(Color.hairline, lineWidth: 1))
        .animation(.snappy, value: progress >= 1)
        .task(id: replayToken) { await play() }
    }

    private var visibleCount: Int {
        guard !coordinates.isEmpty else { return 0 }
        let count = Int((Double(coordinates.count) * progress).rounded(.up))
        return min(coordinates.count, max(1, count))
    }

    private func play() async {
        guard coordinates.count >= 2 else {
            progress = 1
            return
        }
        progress = 0
        let frames = 60
        let frameNanoseconds = UInt64(max(0.5, duration) / Double(frames) * 1_000_000_000)
        for frame in 1...frames {
            try? await Task.sleep(nanoseconds: frameNanoseconds)
            if Task.isCancelled { return }
            let t = Double(frame) / Double(frames)
            // Ease-out cubic
            progress = 1 - pow(1 - t, 3)
        }
        progress = 1
    }

    static func cameraPosition(for coordinates: [CLLocationCoordinate2D]) -> MapCameraPosition {
        let lats = coordinates.map(\.latitude)
        let lngs = coordinates.map(\.longitude)
        guard let minLat = lats.min(), let maxLat = lats.max(), let minLng = lngs.min(), let maxLng = lngs.max() else {
            return .automatic
        }
        let region = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2),
            span: MKCoordinateSpan(
                latitudeDelta: max(0.004, (maxLat - minLat) * 1.4),
                longitudeDelta: max(0.004, (maxLng - minLng) * 1.4)
            )
        )
        return .region(region)
    }
}
