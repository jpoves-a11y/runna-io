import SwiftUI
import MapKit
import UIKit

// MARK: - Event kinds

/// Visual identity of each feed event type (tint, icon and badge label).
enum ActivityEventKind {
    case run, steal, together, treasureFound, treasureSpawned, nickname, sentinel, record

    init(_ eventType: String) {
        switch eventType {
        case "territory_stolen": self = .steal
        case "ran_together": self = .together
        case "treasure_found": self = .treasureFound
        case "treasure_spawned": self = .treasureSpawned
        case "nickname_changed": self = .nickname
        case "sentinel_alert": self = .sentinel
        case "personal_record": self = .record
        default: self = .run
        }
    }

    var tint: Color {
        switch self {
        case .run: return Color.brand
        case .steal, .sentinel: return Color.steal
        case .together: return Color.sky
        case .treasureFound, .treasureSpawned, .record: return Color.gold
        case .nickname: return Color.grape
        }
    }

    var icon: String {
        switch self {
        case .run: return "figure.run"
        case .steal: return "bolt.fill"
        case .together: return "person.2.fill"
        case .treasureFound, .treasureSpawned: return "gift.fill"
        case .nickname: return "theatermasks.fill"
        case .sentinel: return "shield.lefthalf.filled"
        case .record: return "medal.fill"
        }
    }

    var label: String {
        switch self {
        case .run: return "Carrera"
        case .steal: return "Robo"
        case .together: return "En grupo"
        case .treasureFound: return "Tesoro"
        case .treasureSpawned: return "Nuevo tesoro"
        case .nickname: return "Apodo"
        case .sentinel: return "Alerta"
        case .record: return "Récord"
        }
    }

    /// Special events get a tinted card instead of the plain surface.
    var isSpecial: Bool {
        switch self {
        case .run, .together: return false
        default: return true
        }
    }
}

// MARK: - Card background

/// Feed card surface: like `.card()`, with an optional soft tint wash for special events.
struct ActivityCardBackground: ViewModifier {
    var tint: Color? = nil
    var padding: CGFloat = DS.Spacing.l

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous)
        content
            .padding(padding)
            .background {
                ZStack {
                    shape.fill(Color.surface)
                    if let tint {
                        shape.fill(
                            LinearGradient(
                                colors: [tint.opacity(0.16), tint.opacity(0.0)],
                                startPoint: .top,
                                endPoint: .center
                            )
                        )
                    }
                }
            }
            .overlay(shape.strokeBorder(tint.map { $0.opacity(0.35) } ?? Color.hairline, lineWidth: 1))
            .shadow(color: Color.black.opacity(0.06), radius: 12, x: 0, y: 4)
    }
}

extension View {
    func activityCard(tint: Color? = nil, padding: CGFloat = DS.Spacing.l) -> some View {
        modifier(ActivityCardBackground(tint: tint, padding: padding))
    }
}

// MARK: - Map snapshots

/// Renders (and caches) static map images of a route with the polyline drawn in the runner's colour.
enum ActivityMapSnapshots {
    private static let cache = NSCache<NSString, UIImage>()

    static func cached(_ key: String) -> UIImage? {
        cache.object(forKey: key as NSString)
    }

    static func render(
        coordinates: [[Double]],
        color: UIColor,
        lineWidth: CGFloat,
        size: CGSize,
        scale: CGFloat,
        dark: Bool,
        key: String
    ) async -> UIImage? {
        if let hit = cached(key) { return hit }
        let points: [CLLocationCoordinate2D] = coordinates.compactMap { pair in
            guard pair.count >= 2 else { return nil }
            return CLLocationCoordinate2D(latitude: pair[0], longitude: pair[1])
        }
        guard points.count >= 2, size.width > 1, size.height > 1 else { return nil }
        let lats: [Double] = points.map { $0.latitude }
        let lngs: [Double] = points.map { $0.longitude }
        guard let minLat = lats.min(), let maxLat = lats.max(),
              let minLng = lngs.min(), let maxLng = lngs.max() else { return nil }

        let center = CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2)
        let latDelta = min(max((maxLat - minLat) * 1.6, 0.004), 120)
        let lngDelta = min(max((maxLng - minLng) * 1.6, 0.004), 120)

        let options = MKMapSnapshotter.Options()
        options.region = MKCoordinateRegion(center: center, span: MKCoordinateSpan(latitudeDelta: latDelta, longitudeDelta: lngDelta))
        options.size = size
        options.scale = max(scale, 1)
        options.mapType = .mutedStandard
        options.pointOfInterestFilter = .excludingAll
        options.showsBuildings = false
        options.traitCollection = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)

        let snapshotter = MKMapSnapshotter(options: options)
        let queue = DispatchQueue.global(qos: .userInitiated)
        let image: UIImage? = await withCheckedContinuation { (continuation: CheckedContinuation<UIImage?, Never>) in
            snapshotter.start(with: queue) { snapshot, _ in
                guard let snapshot else {
                    continuation.resume(returning: nil)
                    return
                }
                let result = draw(route: points, on: snapshot, color: color, lineWidth: lineWidth)
                continuation.resume(returning: result)
            }
        }
        withExtendedLifetime(snapshotter) {}
        if let image {
            cache.setObject(image, forKey: key as NSString)
        }
        return image
    }

    private static func draw(route points: [CLLocationCoordinate2D], on snapshot: MKMapSnapshotter.Snapshot, color: UIColor, lineWidth: CGFloat) -> UIImage {
        let base = snapshot.image
        let format = UIGraphicsImageRendererFormat()
        format.scale = base.scale
        let renderer = UIGraphicsImageRenderer(size: base.size, format: format)
        return renderer.image { _ in
            base.draw(at: .zero)

            let path = UIBezierPath()
            for (index, coordinate) in points.enumerated() {
                let point = snapshot.point(for: coordinate)
                if index == 0 {
                    path.move(to: point)
                } else {
                    path.addLine(to: point)
                }
            }
            path.lineCapStyle = .round
            path.lineJoinStyle = .round

            // Soft white halo under the route so it pops on any map
            UIColor.white.withAlphaComponent(0.85).setStroke()
            path.lineWidth = lineWidth + 4
            path.stroke()

            color.setStroke()
            path.lineWidth = lineWidth
            path.stroke()

            if let first = points.first {
                dot(at: snapshot.point(for: first), fill: UIColor.white, stroke: color, radius: lineWidth + 1.5)
            }
            if let last = points.last {
                dot(at: snapshot.point(for: last), fill: color, stroke: UIColor.white, radius: lineWidth + 2.5)
            }
        }
    }

    private static func dot(at point: CGPoint, fill: UIColor, stroke: UIColor, radius: CGFloat) {
        let rect = CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)
        let circle = UIBezierPath(ovalIn: rect)
        fill.setFill()
        circle.fill()
        stroke.setStroke()
        circle.lineWidth = 2.5
        circle.stroke()
    }
}

/// Non-interactive map preview of a route (MapKit snapshot), with a drawn-shape placeholder while it loads.
struct ActivityRouteMap: View {
    let cacheKey: String
    let coordinates: [[Double]]
    let color: Color
    var cornerRadius: CGFloat = DS.Radius.tile
    var lineWidth: CGFloat = 4

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?

    var body: some View {
        GeometryReader { proxy in
            content(size: proxy.size)
        }
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).strokeBorder(Color.hairline, lineWidth: 1))
        .accessibilityHidden(true)
    }

    private func content(size: CGSize) -> some View {
        let key = snapshotKey(for: size)
        let shown: UIImage? = image ?? ActivityMapSnapshots.cached(key)
        return ZStack {
            placeholder
            if let shown {
                Image(uiImage: shown)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size.width, height: size.height)
                    .transition(.opacity)
            }
        }
        .frame(width: size.width, height: size.height)
        .task(id: key) { await load(size: size, key: key) }
    }

    private var placeholder: some View {
        ZStack {
            LinearGradient(
                colors: [color.opacity(0.20), color.opacity(0.06)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            RouteShape(coordinates: coordinates)
                .stroke(color, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                .padding(24)
                .opacity(0.8)
        }
    }

    private func snapshotKey(for size: CGSize) -> String {
        "\(cacheKey)-\(Int(size.width))x\(Int(size.height))-\(colorScheme == .dark ? "d" : "l")"
    }

    private func load(size: CGSize, key: String) async {
        if let hit = ActivityMapSnapshots.cached(key) {
            image = hit
            return
        }
        image = nil
        guard size.width > 1, size.height > 1 else { return }
        let rendered = await ActivityMapSnapshots.render(
            coordinates: coordinates,
            color: UIColor(color),
            lineWidth: lineWidth,
            size: size,
            scale: displayScale,
            dark: colorScheme == .dark,
            key: key
        )
        guard !Task.isCancelled else { return }
        withAnimation(.easeOut(duration: 0.3)) {
            image = rendered
        }
    }
}

// MARK: - Stats

/// One value of a stats strip: coloured icon + tiny label above, rounded bold value below.
struct ActivityStatItem: View {
    let systemImage: String
    let value: String
    let label: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: systemImage)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(tint)
                Text(label)
                    .statLabelStyle()
                    .lineLimit(1)
            }
            Text(value)
                .font(.system(.headline, design: .rounded, weight: .bold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

struct ActivityStat: Identifiable {
    let systemImage: String
    let value: String
    let label: String
    let tint: Color
    var id: String { label }
}

/// Row of stats on a soft inner tile.
struct ActivityStatsStrip: View {
    let stats: [ActivityStat]

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            ForEach(stats) { stat in
                ActivityStatItem(systemImage: stat.systemImage, value: stat.value, label: stat.label, tint: stat.tint)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
    }
}

// MARK: - Reactions

/// Expressive capsule button with an icon and an animated count (reactions, comments).
struct ActivityReactionPill: View {
    let systemImage: String
    let activeImage: String
    let count: Int
    let isActive: Bool
    let tint: Color
    let accessibilityLabel: String
    let action: () -> Void

    @State private var taps = 0

    var body: some View {
        Button {
            taps += 1
            action()
        } label: {
            label
        }
        .buttonStyle(.pressable)
        .sensoryFeedback(.impact(weight: .light), trigger: taps)
        .accessibilityLabel(accessibilityLabel)
    }

    private var label: some View {
        HStack(spacing: 6) {
            Image(systemName: isActive ? activeImage : systemImage)
                .font(.subheadline.weight(.semibold))
                .symbolEffect(.bounce, value: taps)
            Text("\(count)")
                .font(.system(.subheadline, design: .rounded, weight: .bold))
                .monospacedDigit()
                .contentTransition(.numericText(value: Double(count)))
        }
        .foregroundStyle(isActive ? tint : Color.secondary)
        .padding(.horizontal, 14)
        .frame(height: 36)
        .background(isActive ? tint.opacity(0.15) : Color.surfaceRaised, in: Capsule())
        .overlay(Capsule().strokeBorder(isActive ? tint.opacity(0.45) : Color.clear, lineWidth: 1))
        .contentShape(Capsule())
        .animation(.snappy, value: count)
        .animation(.snappy, value: isActive)
    }
}

// MARK: - Small pieces

/// Icon in a tinted circle + text, for the extra achievements of a run.
struct ActivityEmblemRow: View {
    let systemImage: String
    let text: String
    let tint: Color

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.caption.weight(.bold))
                .foregroundStyle(tint)
                .frame(width: 28, height: 28)
                .background(tint.opacity(0.15), in: Circle())
            Text(text)
                .font(.system(.footnote, design: .rounded, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }
}

/// Small capsule badge with the event type (icon + label) in its tint.
struct ActivityKindBadge: View {
    let kind: ActivityEventKind

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: kind.icon)
                .font(.caption2.weight(.bold))
            Text(kind.label)
                .font(.system(.caption2, design: .rounded, weight: .bold))
                .lineLimit(1)
        }
        .foregroundStyle(kind.tint)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(kind.tint.opacity(0.14), in: Capsule())
        .accessibilityHidden(true)
    }
}

/// Capsule section switcher with a sliding gradient pill.
struct ActivitySectionPicker: View {
    @Binding var selection: AppRouter.ActivitySection
    @Namespace private var namespace

    var body: some View {
        HStack(spacing: 4) {
            segment(.feed, title: "Amigos", systemImage: "person.2.fill")
            segment(.mine, title: "Mis carreras", systemImage: "figure.run")
        }
        .padding(4)
        .background(Color.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.hairline, lineWidth: 1))
        .shadow(color: Color.black.opacity(0.05), radius: 8, x: 0, y: 3)
        .sensoryFeedback(.selection, trigger: selection)
    }

    private func segment(_ section: AppRouter.ActivitySection, title: String, systemImage: String) -> some View {
        let selected: Bool = selection == section
        return Button {
            withAnimation(.snappy(duration: 0.3)) {
                selection = section
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.subheadline.weight(.bold))
                Text(title)
                    .font(.system(.subheadline, design: .rounded, weight: .bold))
                    .lineLimit(1)
            }
            .foregroundStyle(selected ? Color.white : Color.secondary)
            .frame(maxWidth: .infinity)
            .frame(height: 40)
            .background {
                if selected {
                    Capsule()
                        .fill(.brandGradient)
                        .shadow(color: Color.brand.opacity(0.35), radius: 6, x: 0, y: 3)
                        .matchedGeometryEffect(id: "activity-section-pill", in: namespace)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Pulsing placeholder card while the feed loads for the first time.
struct ActivitySkeletonCard: View {
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Circle().fill(Color.surfaceRaised).frame(width: 44, height: 44)
                VStack(alignment: .leading, spacing: 6) {
                    Capsule().fill(Color.surfaceRaised).frame(width: 130, height: 12)
                    Capsule().fill(Color.surfaceRaised).frame(width: 70, height: 10)
                }
                Spacer()
            }
            Capsule().fill(Color.surfaceRaised).frame(width: 200, height: 14)
            RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous)
                .fill(Color.surfaceRaised)
                .frame(height: 170)
            RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous)
                .fill(Color.surfaceRaised)
                .frame(height: 52)
        }
        .opacity(pulse ? 0.55 : 1)
        .activityCard()
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
        .accessibilityHidden(true)
    }
}
