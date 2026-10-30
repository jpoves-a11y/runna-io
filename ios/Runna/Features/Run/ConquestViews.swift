import SwiftUI
import MapKit
import CoreLocation

/// Territory won in a run: the conquered area as the hero number, then the people you took
/// territory from, each with a plain "Enviar foto" button.
struct ConquestCard: View {
    let result: ConquestResult
    /// Victims who already got a photo for this run.
    let sentVictimIds: Set<String>
    let onTaunt: (Victim) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.xxl) {
            conqueredHero
            if result.castlesBuilt > 0 || result.castlesDestroyed > 0 {
                castlesSection
            }
            let victims: [Victim] = result.stolenVictims
            if !victims.isEmpty {
                stolenSection(victims)
            }
        }
    }

    /// "+2 castillos en tu territorio" / "Has derribado 1 castillo"
    private var castlesSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            if result.castlesBuilt > 0 {
                Label {
                    Text(result.castlesBuilt == 1
                         ? "+1 castillo en tu territorio: esa zona aguanta un ataque más."
                         : "+\(result.castlesBuilt) castillos en tu territorio: aguanta más ataques.")
                } icon: {
                    Text("🏰")
                }
            }
            if result.castlesDestroyed > 0 {
                Label {
                    Text(result.castlesDestroyed == 1
                         ? "Has derribado 1 castillo rival: esa zona no se ha robado esta vez."
                         : "Has derribado \(result.castlesDestroyed) castillos rivales: esas zonas no se han robado esta vez.")
                } icon: {
                    Image(systemName: "hammer")
                        .foregroundStyle(Color.steal)
                }
            }
        }
        .font(.subheadline)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: DS.Spacing.l)
    }

    private var conqueredHero: some View {
        let parts = Format.areaParts(result.newAreaConquered)
        return VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Text("Territorio conquistado")
                .statLabelStyle()
            StatValue(
                value: result.newAreaConquered > 0 ? "+\(parts.value)" : parts.value,
                unit: parts.unit,
                font: Font.stat(56, weight: .semibold),
                tint: result.newAreaConquered > 0 ? Color.brand : Color.primary
            )
            if result.totalStolen > 0 {
                stolenSummary
            } else if result.newAreaConquered <= 0 {
                Text("Esta carrera no ha sumado territorio nuevo.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: DS.Spacing.xl)
        .accessibilityElement(children: .combine)
    }

    private var stolenSummary: some View {
        HStack(spacing: 4) {
            Text("Incluye")
                .foregroundStyle(.secondary)
            Text(Format.area(result.totalStolen))
                .foregroundStyle(Color.steal)
                .fontWeight(.semibold)
                .monospacedDigit()
            Text("de otros corredores")
                .foregroundStyle(.secondary)
        }
        .font(.subheadline)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }

    private func stolenSection(_ victims: [Victim]) -> some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: victims.count == 1 ? "Territorio robado a" : "Territorio robado a \(victims.count) corredores")
            VStack(spacing: 0) {
                ForEach(Array(victims.enumerated()), id: \.element.id) { index, victim in
                    if index > 0 {
                        HairlineDivider()
                            .padding(.leading, 64)
                    }
                    ConquestVictimRow(victim: victim, sent: sentVictimIds.contains(victim.userId)) {
                        onTaunt(victim)
                    }
                }
            }
            .card(padding: 0)
        }
    }
}

/// One victim: avatar, name, area taken (coral text) and the photo action.
private struct ConquestVictimRow: View {
    let victim: Victim
    let sent: Bool
    let onTaunt: () -> Void

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            AvatarView(name: victim.userName, avatar: nil, color: victim.userColor, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(victim.userName)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Text("−\(Format.area(victim.stolenArea))")
                    .font(.subheadline.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(Color.steal)
            }
            Spacer(minLength: DS.Spacing.s)
            actionView
        }
        .padding(.horizontal, DS.Spacing.l)
        .padding(.vertical, DS.Spacing.m)
        .animation(.snappy, value: sent)
    }

    @ViewBuilder
    private var actionView: some View {
        if sent {
            Label("Enviada", systemImage: "checkmark")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .transition(.opacity)
        } else {
            Button("Enviar foto", action: onTaunt)
                .buttonStyle(SecondaryButtonStyle(tint: Color.primary))
                .accessibilityLabel("Enviar foto a \(victim.userName)")
        }
    }
}

// MARK: - Report pieces (shared by the run summary and the conquest inbox)

/// Editorial header of a report: large title and a secondary line (with a small spinner while working).
/// `systemImage` is kept for API compatibility and not drawn.
struct RunCelebrationHeader: View {
    let title: String
    let subtitle: String
    var systemImage: String = "flag.checkered"
    var isWorking: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Text(title)
                .font(Font.screenTitle)
                .tracking(DS.Tracking.title)
                .fixedSize(horizontal: false, vertical: true)
                .contentTransition(.opacity)
            HStack(spacing: DS.Spacing.s) {
                if isWorking {
                    ProgressView()
                        .controlSize(.small)
                }
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .contentTransition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Distance · time · pace in one flat card, separated by hairlines.
struct RunStatsCard: View {
    let distance: Double
    let duration: Int

    var body: some View {
        let distanceParts: (String, String?) = Self.split(Format.distance(distance))
        let paceParts: (String, String?) = Self.split(Format.pace(distanceMeters: distance, seconds: duration))
        return HStack(spacing: 0) {
            StatTile(value: distanceParts.0, label: "Distancia", unit: distanceParts.1)
            StatDivider(height: 40)
            StatTile(value: Format.duration(duration), label: "Tiempo")
            StatDivider(height: 40)
            StatTile(value: paceParts.0, label: "Ritmo", unit: paceParts.1)
        }
        .card(padding: DS.Spacing.l)
    }

    /// "5,23 km" → ("5,23", "km").
    private static func split(_ text: String) -> (String, String?) {
        guard let space = text.firstIndex(of: " ") else { return (text, nil) }
        let value = String(text[..<space])
        let unit = String(text[text.index(after: space)...])
        return (value, unit.isEmpty ? nil : unit)
    }
}

/// Card with a spinner (or quiet icon) and a short status message.
struct RunStatusCard: View {
    let systemImage: String
    let title: String
    let message: String
    var tint: Color = Color.brand
    var isLoading: Bool = false

    /// Coral stays for problems; anything else is a neutral icon.
    private var iconColor: Color { tint == Color.steal ? Color.steal : Color.secondary }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.m) {
            Group {
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: systemImage)
                        .font(.body)
                        .foregroundStyle(iconColor)
                }
            }
            .frame(width: 22)
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

/// Treasures found in a run: simple rows (small emoji, name, rarity as secondary text).
struct TreasuresCard: View {
    let treasures: [TreasureLine]

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: treasures.count == 1 ? "Tesoro encontrado" : "\(treasures.count) tesoros encontrados")
            VStack(spacing: 0) {
                ForEach(Array(treasures.enumerated()), id: \.element.id) { index, treasure in
                    if index > 0 {
                        HairlineDivider()
                            .padding(.leading, 52)
                    }
                    row(treasure)
                }
            }
            .card(padding: 0)
        }
    }

    private func row(_ treasure: TreasureLine) -> some View {
        HStack(spacing: DS.Spacing.m) {
            Text(treasure.emoji)
                .font(.body)
                .frame(width: 24)
                .accessibilityHidden(true)
            Text(treasure.name)
                .font(.body)
                .lineLimit(2)
            Spacer(minLength: DS.Spacing.s)
            Text(TreasureLine.rarityName(treasure.rarity))
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, DS.Spacing.l)
        .frame(minHeight: 48)
        .accessibilityElement(children: .combine)
    }
}

/// Compact replay in the summary cards: the line grows from start to finish over a few seconds.
struct RouteGrowthReplay: View {
    let coordinates: [CLLocationCoordinate2D]
    let color: Color
    /// 1,7 times faster than the original 4 s.
    var duration: Double = 4 / 1.7
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
                        .stroke(Color.white, style: StrokeStyle(lineWidth: 7, lineCap: .round, lineJoin: .round))
                    MapPolyline(coordinates: shown)
                        .stroke(color, style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
                }
                if let start = coordinates.first {
                    Annotation("Salida", coordinate: start) {
                        Circle()
                            .fill(Color.white)
                            .frame(width: 12, height: 12)
                            .overlay(Circle().strokeBorder(color, lineWidth: 3))
                    }
                    .annotationTitles(.hidden)
                }
                if let head = shown.last {
                    Annotation(progress >= 1 ? "Meta" : String(), coordinate: head) {
                        Circle()
                            .fill(progress >= 1 ? Color.primary : color)
                            .frame(width: 12, height: 12)
                            .overlay(Circle().stroke(Color.white, lineWidth: 2))
                    }
                    .annotationTitles(.hidden)
                }
            }

            if progress >= 1, coordinates.count >= 2 {
                Button {
                    replayToken += 1
                } label: {
                    Label("Repetir", systemImage: "arrow.counterclockwise")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 12)
                        .frame(height: 34)
                        .glassSurface(Capsule(), interactive: true)
                }
                .buttonStyle(.pressable)
                .padding(DS.Spacing.m)
                .transition(.opacity)
                .accessibilityLabel("Repetir recorrido")
            }
        }
        .frame(height: height)
        .clipShape(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous).strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline))
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
