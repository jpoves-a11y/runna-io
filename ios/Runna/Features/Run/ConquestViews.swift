import SwiftUI
import MapKit
import CoreLocation

/// Territory won in a run: new area, total stolen and the victims, each with a button to send them a photo.
struct ConquestCard: View {
    let result: ConquestResult
    /// Victims who already got a photo for this run.
    let sentVictimIds: Set<String>
    let onTaunt: (Victim) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Territorio", systemImage: "flag.fill")
                .font(.headline)
            HStack {
                StatTile(value: Format.area(result.newAreaConquered), label: "Conquistado", tint: .brand)
                StatTile(value: Format.area(result.totalStolen), label: "Robado", tint: .red)
            }
            let victims = result.stolenVictims
            if !victims.isEmpty {
                Divider()
                Text("Has robado territorio a:")
                    .font(.subheadline.weight(.semibold))
                ForEach(victims) { victim in
                    victimRow(victim)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
    }

    private func victimRow(_ victim: Victim) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Circle().fill(Color(hex: victim.userColor)).frame(width: 12, height: 12)
                Text(victim.userName)
                    .font(.body.weight(.semibold))
                Spacer()
                Text(Format.area(victim.stolenArea))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            if sentVictimIds.contains(victim.userId) {
                Label("Foto enviada", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.green)
                    .frame(maxWidth: .infinity, minHeight: 36)
            } else {
                Button {
                    onTaunt(victim)
                } label: {
                    Label("Enviar foto", systemImage: "camera.fill")
                        .font(.subheadline.weight(.bold))
                        .frame(maxWidth: .infinity, minHeight: 36)
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .accessibilityLabel("Enviar foto a \(victim.userName)")
            }
        }
        .padding(.vertical, 4)
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
        case "rare": return .blue
        case "epic": return .purple
        case "legendary": return .orange
        default: return .gray
        }
    }
}

struct TreasuresCard: View {
    let treasures: [TreasureLine]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("¡Tesoros encontrados!", systemImage: "gift.fill")
                .font(.headline)
            ForEach(treasures) { treasure in
                HStack {
                    Text(treasure.emoji)
                    Text(treasure.name)
                    Spacer()
                    Text(TreasureLine.rarityName(treasure.rarity))
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(TreasureLine.rarityColor(treasure.rarity).opacity(0.15), in: Capsule())
                        .foregroundStyle(TreasureLine.rarityColor(treasure.rarity))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
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
                        .stroke(color, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
                }
                if let start = coordinates.first {
                    Annotation("Salida", coordinate: start) {
                        Circle()
                            .fill(Color.green)
                            .frame(width: 12, height: 12)
                            .overlay(Circle().stroke(Color.white, lineWidth: 2))
                    }
                }
                if let head = shown.last {
                    Annotation(progress >= 1 ? "Meta" : String(), coordinate: head) {
                        Circle()
                            .fill(progress >= 1 ? Color.red : color)
                            .frame(width: 16, height: 16)
                            .overlay(Circle().stroke(Color.white, lineWidth: 3))
                            .shadow(radius: 2)
                    }
                }
            }
            .annotationTitles(.hidden)

            if progress >= 1, coordinates.count >= 2 {
                Button {
                    replayToken += 1
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                        .font(.subheadline.weight(.bold))
                        .padding(10)
                        .background(.regularMaterial, in: Circle())
                }
                .padding(10)
                .accessibilityLabel("Repetir recorrido")
            }
        }
        .frame(height: height)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
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
