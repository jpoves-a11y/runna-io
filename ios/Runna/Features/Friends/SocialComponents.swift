import SwiftUI

// MARK: - Social components (Friends, user profile, own profile)
//
// Small building blocks shared by the social screens. Names are prefixed with `Social`
// so they never clash with the shared design system or other screens.

/// Rounded section header for social lists: icon, title and an optional count bubble.
struct SocialSectionHeader: View {
    let title: String
    var systemImage: String? = nil
    var count: Int? = nil
    var tint: Color = .brand

    var body: some View {
        HStack(spacing: 8) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(tint)
            }
            Text(title)
                .font(.system(.headline, design: .rounded, weight: .bold))
                .foregroundStyle(Color.primary)
            if let count {
                Text("\(count)")
                    .font(.system(.caption, design: .rounded, weight: .heavy))
                    .monospacedDigit()
                    .foregroundStyle(tint)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(tint.opacity(0.15), in: Capsule())
                    .contentTransition(.numericText())
            }
            Spacer(minLength: 0)
        }
        .textCase(nil)
        .padding(.bottom, 2)
        .accessibilityElement(children: .combine)
    }
}

/// "#3" position within the friend group: crown for #1, medals for #2 and #3.
struct SocialRankBadge: View {
    let rank: Int

    private static let silver = Color(hex: "#9AA6B2")
    private static let bronze = Color(hex: "#C98A4B")

    var body: some View {
        HStack(spacing: 3) {
            if rank >= 1 && rank <= 3 {
                Image(systemName: rank == 1 ? "crown.fill" : "medal.fill")
                    .font(.system(size: 9, weight: .bold))
            }
            Text("#\(rank)")
                .font(.system(.caption2, design: .rounded, weight: .heavy))
                .monospacedDigit()
        }
        .foregroundStyle(rank >= 1 && rank <= 3 ? Color.white : Color.secondary)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(fill, in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Puesto \(rank)")
    }

    private var fill: AnyShapeStyle {
        switch rank {
        case 1: return AnyShapeStyle(LinearGradient.goldGradient)
        case 2: return AnyShapeStyle(Self.silver)
        case 3: return AnyShapeStyle(Self.bronze)
        default: return AnyShapeStyle(Color.secondary.opacity(0.14))
        }
    }
}

/// Capsule label for row actions (Aceptar, Rechazar, Añadir…). Use inside a `Button` with
/// `.buttonStyle(.borderless)` when it sits in a List row so each button gets its own tap area.
struct SocialPillLabel: View {
    enum Kind {
        case filled
        case soft
    }

    let title: String
    var systemImage: String? = nil
    var tint: Color = .brand
    var kind: Kind = .filled
    var compact: Bool = false
    var expand: Bool = false

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: compact ? 11 : 13, weight: .bold))
            }
            Text(title)
                .font(.system(compact ? Font.TextStyle.footnote : Font.TextStyle.subheadline, design: .rounded, weight: .bold))
                .lineLimit(1)
        }
        .foregroundStyle(kind == .filled ? Color.white : tint)
        .padding(.horizontal, compact ? 12 : 16)
        .frame(maxWidth: expand ? .infinity : nil)
        .frame(minHeight: compact ? 32 : 40)
        .background { pillBackground }
        .contentShape(Capsule())
    }

    @ViewBuilder
    private var pillBackground: some View {
        switch kind {
        case .filled:
            Capsule().fill(tint.gradient)
                .shadow(color: tint.opacity(0.28), radius: 6, x: 0, y: 3)
        case .soft:
            Capsule().fill(tint.opacity(0.14))
        }
    }
}

/// Coloured rounded-square icon (iOS Settings style) for setting rows and devices.
struct SocialIconTile: View {
    let systemImage: String
    var tint: Color = .brand
    var size: CGFloat = 30
    /// White tile with a tinted symbol (e.g. Apple Health) instead of a tinted tile.
    var inverted: Bool = false

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(inverted ? tint : Color.white)
            .frame(width: size, height: size)
            .background {
                RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
                    .fill(inverted ? AnyShapeStyle(Color.white) : AnyShapeStyle(tint.gradient))
            }
            .overlay {
                RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
                    .strokeBorder(Color.hairline, lineWidth: inverted ? 1 : 0)
            }
            .accessibilityHidden(true)
    }
}

/// Settings row label: coloured icon tile + title (+ optional trailing value).
struct SocialSettingsLabel: View {
    let title: String
    let systemImage: String
    var tint: Color = .brand
    var value: String? = nil

    var body: some View {
        HStack(spacing: 12) {
            SocialIconTile(systemImage: systemImage, tint: tint)
            Text(title)
                .foregroundStyle(Color.primary)
            if let value {
                Spacer(minLength: 8)
                Text(value)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}

/// Little coloured dot + name of a territory colour.
struct SocialColorChip: View {
    let color: String
    var onDark: Bool = false

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Color(hex: color))
                .frame(width: 10, height: 10)
                .overlay(Circle().stroke(Color.white.opacity(0.9), lineWidth: 1.5))
            Text(AppConfig.userColorNames[color.uppercased()] ?? "Personalizado")
                .font(.system(.caption, design: .rounded, weight: .semibold))
        }
        .foregroundStyle(onDark ? Color.white : Color.primary)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(onDark ? Color.white.opacity(0.2) : Color(hex: color).opacity(0.14), in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Color de territorio: \(AppConfig.userColorNames[color.uppercased()] ?? "personalizado")")
    }
}

/// Tinted hero backdrop for a runner's header: their territory colour blended into the canvas,
/// with soft decorative circles.
struct SocialHeroBackdrop: View {
    let color: Color

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [color.opacity(0.55), color.opacity(0.18), Color.surface],
                startPoint: .top,
                endPoint: .bottom
            )
            Circle()
                .fill(color.opacity(0.25))
                .frame(width: 220, height: 220)
                .blur(radius: 30)
                .offset(x: -110, y: -70)
            Circle()
                .fill(Color.brandLime.opacity(0.18))
                .frame(width: 180, height: 180)
                .blur(radius: 30)
                .offset(x: 120, y: -40)
        }
    }
}

/// One stat inside a hero/stat grid card: icon, big rounded number and a small label.
struct SocialStatCell: View {
    let value: String
    let label: String
    var unit: String? = nil
    var systemImage: String? = nil
    var tint: Color = .brand

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(tint)
                    .frame(width: 26, height: 26)
                    .background(tint.opacity(0.15), in: Circle())
            }
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value)
                    .font(Font.stat(22))
                    .monospacedDigit()
                    .foregroundStyle(Color.primary)
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                if let unit {
                    Text(unit)
                        .font(.system(.caption, design: .rounded, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
            }
            Text(label)
                .statLabelStyle()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// Two-sided bar comparing what one side stole vs the other (rivalries).
struct SocialDuelBar: View {
    let left: Double
    let right: Double
    var leftColor: Color = .brand
    var rightColor: Color = .steal

    var body: some View {
        GeometryReader { proxy in
            let total = max(left + right, 1)
            let leftWidth = max(6, proxy.size.width * CGFloat(left / total))
            HStack(spacing: 3) {
                Capsule().fill(leftColor.gradient)
                    .frame(width: max(0, min(leftWidth, proxy.size.width - 9)))
                Capsule().fill(rightColor.gradient)
            }
        }
        .frame(height: 10)
        .accessibilityHidden(true)
    }
}
