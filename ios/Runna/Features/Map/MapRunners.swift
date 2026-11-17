import SwiftUI
import MapKit

/// One runner on the current map (not me): who, how they relate to me, and where to pin their face.
struct MapRunner: Identifiable, Equatable {
    let id: String
    let name: String
    let avatar: String?
    /// The owner's own colour (for the avatar) and the one their zones get on this map.
    let hex: String
    let displayColor: Color
    let relation: TerritoryRelation
    /// Total area of their territories on this map (m²).
    let area: Double
    /// Middle of their biggest zone.
    let anchor: CLLocationCoordinate2D

    static func == (lhs: MapRunner, rhs: MapRunner) -> Bool {
        lhs.id == rhs.id && lhs.relation == rhs.relation && lhs.area == rhs.area
            && lhs.anchor.latitude == rhs.anchor.latitude && lhs.anchor.longitude == rhs.anchor.longitude
    }

    static func runners(from shapes: [TerritoryShape]) -> [MapRunner] {
        var order: [String] = []
        var byUser: [String: [TerritoryShape]] = [:]
        for shape in shapes where shape.relation != .mine {
            if byUser[shape.userId] == nil { order.append(shape.userId) }
            byUser[shape.userId, default: []].append(shape)
        }
        return order.compactMap { userId in
            guard let shapes = byUser[userId], let first = shapes.first else { return nil }
            // Area: once per territory record (a record can be drawn as several polygons)
            var seen = Set<String>()
            var area = 0.0
            for shape in shapes where seen.insert(shape.recordId).inserted {
                area += shape.recordArea
            }
            let biggest = shapes.max { lhs, rhs in
                let a = lhs.polygon.boundingMapRect.size, b = rhs.polygon.boundingMapRect.size
                return a.width * a.height < b.width * b.height
            } ?? first
            return MapRunner(
                id: userId,
                name: first.ownerName,
                avatar: first.avatar,
                hex: first.hex,
                displayColor: first.displayColor,
                relation: first.relation,
                area: area,
                anchor: biggest.polygon.coordinate
            )
        }
    }
}

/// Avatars that would overlap at the current zoom, merged into one pin.
struct RunnerCluster: Identifiable {
    let id: String
    let runners: [MapRunner]
    let coordinate: CLLocationCoordinate2D

    /// Groups runners in a grid of the visible region (about 6 × 9 cells on screen).
    static func clusters(_ runners: [MapRunner], region: MKCoordinateRegion?) -> [RunnerCluster] {
        guard let region, region.span.latitudeDelta > 0, region.span.longitudeDelta > 0 else {
            return runners.map { RunnerCluster(id: $0.id, runners: [$0], coordinate: $0.anchor) }
        }
        let cellLat = region.span.latitudeDelta / 9
        let cellLng = region.span.longitudeDelta / 6
        var cells: [String: [MapRunner]] = [:]
        var order: [String] = []
        for runner in runners {
            let key = "\(Int(floor(runner.anchor.latitude / cellLat)))_\(Int(floor(runner.anchor.longitude / cellLng)))"
            if cells[key] == nil { order.append(key) }
            cells[key, default: []].append(runner)
        }
        return order.compactMap { key in
            guard let members = cells[key], !members.isEmpty else { return nil }
            let lat = members.map(\.anchor.latitude).reduce(0, +) / Double(members.count)
            let lng = members.map(\.anchor.longitude).reduce(0, +) / Double(members.count)
            let sorted = members.sorted { $0.area > $1.area }
            return RunnerCluster(
                id: sorted.map(\.id).joined(separator: "+"),
                runners: sorted,
                coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lng)
            )
        }
    }

    /// Region that shows every runner of the cluster, for zooming into it.
    var region: MKCoordinateRegion {
        let lats = runners.map(\.anchor.latitude), lngs = runners.map(\.anchor.longitude)
        let minLat = lats.min() ?? coordinate.latitude, maxLat = lats.max() ?? coordinate.latitude
        let minLng = lngs.min() ?? coordinate.longitude, maxLng = lngs.max() ?? coordinate.longitude
        return MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2),
            span: MKCoordinateSpan(latitudeDelta: max(0.004, (maxLat - minLat) * 1.8), longitudeDelta: max(0.004, (maxLng - minLng) * 1.8))
        )
    }
}

/// A runner's face on their territory (ring in their map colour); several stacked with a count.
struct RunnerPin: View {
    let cluster: RunnerCluster

    var body: some View {
        if cluster.runners.count == 1, let runner = cluster.runners.first {
            single(runner)
        } else {
            stack
        }
    }

    private func single(_ runner: MapRunner) -> some View {
        AvatarView(name: runner.name, avatar: runner.avatar, color: runner.hex, size: 26, ring: false)
            .padding(2)
            .background(Circle().fill(runner.displayColor))
            .overlay(alignment: .bottomTrailing) {
                if runner.relation == .danger {
                    Image(systemName: "exclamationmark")
                        .font(.system(size: 8, weight: .heavy))
                        .foregroundStyle(.white)
                        .frame(width: 13, height: 13)
                        .background(Circle().fill(Color.steal))
                        .offset(x: 3, y: 3)
                }
            }
            .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
            .accessibilityLabel(runner.name)
    }

    private var stack: some View {
        let shown = Array(cluster.runners.prefix(3))
        return HStack(spacing: -10) {
            ForEach(shown) { runner in
                AvatarView(name: runner.name, avatar: runner.avatar, color: runner.hex, size: 24, ring: false)
                    .padding(1.5)
                    .background(Circle().fill(runner.displayColor))
            }
            if cluster.runners.count > shown.count {
                Text("+\(cluster.runners.count - shown.count)")
                    .font(.caption2.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(Color.primary)
                    .padding(.horizontal, 6)
                    .frame(height: 27)
                    .background(Capsule().fill(Color(uiColor: .systemBackground)))
                    .padding(.leading, 12)
            }
        }
        .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(cluster.runners.count) corredores")
    }
}

/// Quick card for a tapped territory: who, how much, what it means for me; focus or open the profile.
struct TerritoryCallout: View {
    let runner: MapRunner
    let relationText: String
    let isFocused: Bool
    let focusTitle: String
    let onFocus: () -> Void
    let onProfile: () -> Void
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            HStack(spacing: DS.Spacing.m) {
                AvatarView(name: runner.name, avatar: runner.avatar, color: runner.hex, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(runner.name)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        Circle()
                            .fill(runner.displayColor)
                            .frame(width: 8, height: 8)
                        Text(relationText)
                            .font(.caption)
                            .foregroundStyle(runner.relation == .danger ? Color.steal : Color.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 4)
                Text(Format.area(runner.area))
                    .font(Font.stat(17, weight: .semibold))
                    .monospacedDigit()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Cerrar")
            }
            HStack(spacing: DS.Spacing.s) {
                Button(action: onFocus) {
                    Label(isFocused ? "Ver todos" : focusTitle, systemImage: isFocused ? "circle.dashed" : "scope")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle(tint: .brand))
                Button(action: onProfile) {
                    Label("Ver perfil", systemImage: "person.crop.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle(tint: .brand))
            }
        }
        .padding(DS.Spacing.m)
        .glassSurface(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
    }
}

/// "Viendo a Ana ✕": the focus in place, tap to see everybody again.
struct FocusPill: View {
    let runner: MapRunner
    let title: String
    let onClear: () -> Void

    var body: some View {
        Button(action: onClear) {
            HStack(spacing: 8) {
                AvatarView(name: runner.name, avatar: runner.avatar, color: runner.hex, size: 22)
                Text(title)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .padding(.leading, 4)
            .padding(.trailing, 12)
            .frame(minHeight: 32)
            .glassSurface(Capsule(), interactive: true)
        }
        .buttonStyle(.pressable)
        .accessibilityLabel("\(title). Toca para ver a todos")
    }
}
