import SwiftUI
import UIKit

/// User avatar: data-URL or http image, or initials on the user's colour.
struct AvatarView: View {
    let name: String
    let avatar: String?
    let color: String
    var size: CGFloat = 40

    var body: some View {
        ZStack {
            Circle().fill(Color(hex: color))
            if let image = AvatarImageCache.image(for: avatar) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if let avatar, avatar.hasPrefix("http"), let url = URL(string: avatar) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        initials
                    }
                }
            } else {
                initials
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().stroke(Color(hex: color), lineWidth: max(1.5, size / 24)))
        .accessibilityHidden(true)
    }

    private var initials: some View {
        Text(String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
            .font(.system(size: size * 0.42, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
    }
}

/// Decodes "data:image/...;base64," avatars once and keeps them in memory.
enum AvatarImageCache {
    private static let cache = NSCache<NSString, UIImage>()

    static func image(for avatar: String?) -> UIImage? {
        guard let avatar, avatar.hasPrefix("data:image"), let comma = avatar.firstIndex(of: ",") else { return nil }
        let key = "\(avatar.count)-\(avatar.hashValue)" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        guard let data = Data(base64Encoded: String(avatar[avatar.index(after: comma)...]), options: .ignoreUnknownCharacters),
              let image = UIImage(data: data) else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }
}

/// Number + label tile used on the map, profile and run screens.
struct StatTile: View {
    let value: String
    let label: String
    var unit: String? = nil
    var tint: Color = .primary

    var body: some View {
        VStack(spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value)
                    .font(.title3.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(tint)
                if let unit {
                    Text(unit)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

/// Draws a route's shape scaled into the available space (cheap alternative to a map in lists).
struct RouteShape: Shape {
    let coordinates: [[Double]]

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

struct EmptyStateView: View {
    let systemImage: String
    let title: String
    let message: String

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(message)
        }
    }
}

/// Inline error message with a retry button.
struct ErrorView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("No se ha podido cargar", systemImage: "wifi.exclamationmark")
        } description: {
            Text(message)
        } actions: {
            Button("Reintentar", action: retry)
                .buttonStyle(.borderedProminent)
        }
    }
}

/// Primary call-to-action button style.
struct PrimaryButtonStyle: ButtonStyle {
    var color: Color = .brand

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(color.opacity(configuration.isPressed ? 0.8 : 1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
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

    /// Card background used across the app.
    func cardStyle() -> some View {
        padding()
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

enum Haptics {
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}
