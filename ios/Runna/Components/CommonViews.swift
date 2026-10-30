import SwiftUI
import UIKit

/// User avatar: data-URL or http image, or initials on the user's colour,
/// surrounded by a ring in the user's territory colour (their identity).
struct AvatarView: View {
    let name: String
    let avatar: String?
    let color: String
    var size: CGFloat = 40
    /// Territory-colour ring with a thin gap around the picture.
    var ring: Bool = true

    private var tint: Color { Color(hex: color) }
    private var ringWidth: CGFloat { ring ? max(1.5, size / 24) : 0 }
    private var gap: CGFloat { ring ? max(1, size / 30) : 0 }
    private var innerSize: CGFloat { max(1, size - 2 * (ringWidth + gap)) }

    var body: some View {
        ZStack {
            if ring {
                Circle()
                    .strokeBorder(tint, lineWidth: ringWidth)
            }
            picture
                .frame(width: innerSize, height: innerSize)
                .clipShape(Circle())
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var picture: some View {
        if let image = AvatarImageCache.image(for: avatar) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else if let avatar, avatar.hasPrefix("http"), let url = URL(string: avatar) {
            CachedRemoteImage(url: url) {
                initials
            }
        } else {
            initials
        }
    }

    private var initials: some View {
        ZStack {
            Circle().fill(tint)
            Text(String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
                .font(.system(size: innerSize * 0.42, weight: .semibold))
                .foregroundStyle(Color.white)
        }
    }
}

/// Decodes "data:image/...;base64," avatars once and keeps them in memory.
enum AvatarImageCache {
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 300
        return cache
    }()

    static func image(for avatar: String?) -> UIImage? {
        guard let avatar, avatar.hasPrefix("data:image"), let comma = avatar.firstIndex(of: ",") else { return nil }
        let key = "\(avatar.utf8.count)-\(avatar.hashValue)" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        guard let data = Data(base64Encoded: String(avatar[avatar.index(after: comma)...]), options: .ignoreUnknownCharacters),
              let image = UIImage(data: data) else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }
}

/// Remote images (http avatars) decoded once and kept in memory; the bytes also stay in the
/// shared URLCache (sized in RunnaApp), so they survive relaunches.
final class RemoteImageCache {
    static let shared = RemoteImageCache()

    private let cache: NSCache<NSURL, UIImage> = {
        let cache = NSCache<NSURL, UIImage>()
        cache.countLimit = 300
        cache.totalCostLimit = 64 * 1024 * 1024
        return cache
    }()
    private let lock = NSLock()
    private var inFlight: [URL: Task<UIImage?, Never>] = [:]

    func cachedImage(for url: URL) -> UIImage? {
        cache.object(forKey: url as NSURL)
    }

    /// Downloads (or reads from URLCache) and decodes the image off the main thread; concurrent
    /// requests for the same URL share one download.
    func image(for url: URL) async -> UIImage? {
        if let hit = cachedImage(for: url) { return hit }
        let task = sharedDownload(url)
        let image = await task.value
        finishDownload(url)
        if let image {
            let cost = Int(image.size.width * image.size.height * image.scale * image.scale * 4)
            cache.setObject(image, forKey: url as NSURL, cost: cost)
        }
        return image
    }

    func removeAll() {
        cache.removeAllObjects()
    }

    private func sharedDownload(_ url: URL) -> Task<UIImage?, Never> {
        lock.lock()
        defer { lock.unlock() }
        if let running = inFlight[url] { return running }
        let task = Task.detached(priority: .utility) { () -> UIImage? in
            var request = URLRequest(url: url)
            request.cachePolicy = .returnCacheDataElseLoad
            guard let response = try? await URLSession.shared.data(for: request),
                  let image = UIImage(data: response.0) else { return nil }
            // Decode now (not on the main thread while scrolling)
            return image.preparingForDisplay() ?? image
        }
        inFlight[url] = task
        return task
    }

    private func finishDownload(_ url: URL) {
        lock.lock()
        inFlight[url] = nil
        lock.unlock()
    }
}

/// An http image from RemoteImageCache: shown immediately when cached, else the placeholder until it loads.
struct CachedRemoteImage<Placeholder: View>: View {
    let url: URL
    let placeholder: () -> Placeholder
    @State private var loaded: UIImage?

    init(url: URL, @ViewBuilder placeholder: @escaping () -> Placeholder) {
        self.url = url
        self.placeholder = placeholder
    }

    var body: some View {
        if let image = loaded ?? RemoteImageCache.shared.cachedImage(for: url) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else {
            placeholder()
                .task(id: url) {
                    loaded = await RemoteImageCache.shared.image(for: url)
                }
        }
    }
}

/// Value (+ unit) over an uppercase label, centred in its column. Put `StatDivider()` between tiles.
/// Legacy sky / grape tints render as `.primary`; use brand only for the user's own data,
/// steal for lost values, gold for a #1 rank.
struct StatTile: View {
    let value: String
    let label: String
    var unit: String? = nil
    var tint: Color = .primary

    var body: some View {
        VStack(spacing: 4) {
            StatValue(value: value, unit: unit, font: Font.statNumber, tint: DS.restrainedTint(tint))
            Text(label)
                .statLabelStyle()
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// Draws a route's shape scaled into the available space (cheap alternative to a map in lists).
struct RouteShape: Shape {
    let coordinates: [[Double]]

    /// Long GPS tracks are thinned to at most `maxPoints`: the shape is tiny and redrawn often.
    init(coordinates: [[Double]], maxPoints: Int = 80) {
        self.coordinates = RouteShape.thinned(coordinates.filter { $0.count >= 2 }, maxPoints: maxPoints)
    }

    static func thinned(_ points: [[Double]], maxPoints: Int) -> [[Double]] {
        guard points.count > maxPoints, maxPoints >= 2 else { return points }
        let step = Double(points.count - 1) / Double(maxPoints - 1)
        return (0..<maxPoints).map { points[min(points.count - 1, Int((Double($0) * step).rounded()))] }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard coordinates.count >= 2 else { return path }
        let lats = coordinates.map { $0[0] }
        let lngs = coordinates.map { $0[1] }
        guard let minLat = lats.min(), let maxLat = lats.max(), let minLng = lngs.min(), let maxLng = lngs.max() else { return path }

        // Longitude degrees are shorter than latitude degrees away from the equator
        let lngScale = cos(((minLat + maxLat) / 2) * .pi / 180)
        let width = max((maxLng - minLng) * lngScale, 1e-9)
        let height = max(maxLat - minLat, 1e-9)
        let scale = min(rect.width / width, rect.height / height)
        let offsetX = rect.minX + (rect.width - width * scale) / 2
        let offsetY = rect.minY + (rect.height - height * scale) / 2

        for (index, point) in coordinates.enumerated() {
            let x = offsetX + (point[1] - minLng) * lngScale * scale
            let y = offsetY + (maxLat - point[0]) * scale
            if index == 0 {
                path.move(to: CGPoint(x: x, y: y))
            } else {
                path.addLine(to: CGPoint(x: x, y: y))
            }
        }
        return path
    }
}

/// Calm empty state: a quiet symbol, short title, one-line message and an optional action.
struct EmptyStateView: View {
    let systemImage: String
    let title: String
    let message: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    var tint: Color = .brand

    var body: some View {
        VStack(spacing: DS.Spacing.l) {
            Image(systemName: systemImage)
                .font(.system(size: 34, weight: .regular))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.secondary)
                .frame(height: 44)
            VStack(spacing: 6) {
                Text(title)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(PrimaryButtonStyle(color: tint))
                    .frame(maxWidth: 240)
                    .padding(.top, DS.Spacing.xs)
            }
        }
        .padding(.horizontal, DS.Spacing.xxxl)
        .padding(.vertical, DS.Spacing.xxl)
        .frame(maxWidth: .infinity)
    }
}

/// Inline error message with a retry button.
struct ErrorView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        EmptyStateView(
            systemImage: "wifi.exclamationmark",
            title: "No se ha podido cargar",
            message: message,
            actionTitle: "Reintentar",
            action: retry
        )
    }
}

/// Primary call-to-action button style: full-width solid fill, 12pt continuous corners.
/// Legacy accent colours (steal / gold / grape / sky) are normalised to the brand accent.
struct PrimaryButtonStyle: ButtonStyle {
    var color: Color = .brand
    @Environment(\.isEnabled) private var isEnabled

    private var fill: Color { DS.buttonFill(color) }
    private var labelColor: Color { fill == Color.brand ? Color.onBrand : Color(uiColor: .systemBackground) }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(labelColor)
            .frame(maxWidth: .infinity, minHeight: DS.Size.button)
            .background(fill, in: RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous))
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.4)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

extension View {
    /// Shows an alert for an error message bound to optional state.
    func errorAlert(_ message: Binding<String?>) -> some View {
        alert(
            "Error",
            isPresented: Binding(get: { message.wrappedValue != nil }, set: { if !$0 { message.wrappedValue = nil } }),
            actions: { Button("OK", role: .cancel) {} },
            message: { Text(message.wrappedValue ?? "") }
        )
    }

    /// Card background used across the app (same as `.card()`).
    func cardStyle() -> some View {
        card()
    }
}

enum Haptics {
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
}
