import SwiftUI

// MARK: - Social components (Friends, user profile, own profile)
//
// Small building blocks shared by the social screens. Names are prefixed with `Social`
// so they never clash with the shared design system or other screens.
// They follow the design-system rules: flat, neutral, one accent, no rounded fonts,
// no gradients or shadows, no tinted capsules behind numbers.

/// Section header for social lists: uppercase label and an optional count in secondary text.
/// `systemImage` and `tint` are accepted for API compatibility but not drawn.
struct SocialSectionHeader: View {
    let title: String
    var systemImage: String? = nil
    var count: Int? = nil
    var tint: Color = .brand

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title)
                .sectionLabelStyle()
            if let count {
                Text("\(count)")
                    .font(Font.sectionLabel)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                    .contentTransition(.numericText())
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// "#3" position within the friend group. Plain text; only #1 gets a gold crown.
struct SocialRankBadge: View {
    let rank: Int

    private var isFirst: Bool { rank == 1 }

    var body: some View {
        HStack(spacing: 3) {
            if isFirst {
                Image(systemName: "crown.fill")
                    .font(.system(size: 9, weight: .semibold))
            }
            Text("#\(rank)")
                .font(.caption.weight(.semibold))
                .monospacedDigit()
        }
        .foregroundStyle(isFirst ? Color.gold : Color.secondary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Puesto \(rank)")
    }
}

/// Label for row actions (Aceptar, Rechazar, Añadir…). Use inside a `Button` with
/// `.buttonStyle(.borderless)` when it sits in a List row so each button gets its own tap area.
/// `.filled` = solid brand (the prominent action), `.soft` = neutral fill with a tinted label.
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

    private var fill: Color {
        kind == .filled ? DS.buttonFill(tint) : Color(uiColor: .tertiarySystemFill)
    }

    private var labelColor: Color {
        switch kind {
        case .filled:
            return fill == Color.brand ? Color.onBrand : Color.white
        case .soft:
            return DS.restrainedTint(tint)
        }
    }

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: compact ? 11 : 13, weight: .semibold))
            }
            Text(title)
                .font(compact ? Font.footnote.weight(.semibold) : Font.subheadline.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(labelColor)
        .padding(.horizontal, compact ? 12 : 16)
        .frame(maxWidth: expand ? .infinity : nil)
        .frame(minHeight: compact ? 32 : 40)
        .background(fill, in: RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous))
    }
}

/// Leading glyph for setting rows: a plain SF Symbol (no coloured tile).
/// Coral is kept for destructive rows; everything else is secondary.
/// `inverted` draws a white rounded tile with a hairline and the tinted symbol — reserved for
/// third-party brand marks such as Apple Health.
struct SocialIconTile: View {
    let systemImage: String
    var tint: Color = .brand
    var size: CGFloat = 30
    var inverted: Bool = false

    private var glyphColor: Color {
        if inverted { return tint }
        if tint == Color.steal || tint == Color.red { return Color.steal }
        return Color.secondary
    }

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: inverted ? size * 0.5 : min(DS.Size.icon, size * 0.6), weight: .regular))
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(glyphColor)
            .frame(width: size, height: size)
            .background {
                if inverted {
                    RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
                        .fill(Color.white)
                }
            }
            .overlay {
                if inverted {
                    RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
                        .strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline)
                }
            }
            .accessibilityHidden(true)
    }
}

/// Settings row label: plain glyph + title (+ optional trailing value).
struct SocialSettingsLabel: View {
    let title: String
    let systemImage: String
    var tint: Color = .brand
    var value: String? = nil

    var body: some View {
        HStack(spacing: 12) {
            SocialIconTile(systemImage: systemImage, tint: tint, size: 28)
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

/// Small territory-colour dot + the colour's name.
struct SocialColorChip: View {
    let color: String
    var onDark: Bool = false

    private var colorName: String {
        AppConfig.userColorNames[color.uppercased()] ?? "Personalizado"
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Color(hex: color))
                .frame(width: 8, height: 8)
            Text(colorName)
                .font(.footnote)
                .foregroundStyle(onDark ? Color.white : Color.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Color de territorio: \(colorName.lowercased())")
    }
}

/// Legacy hero backdrop. Now a flat surface (no tinted gradient or blurred circles).
struct SocialHeroBackdrop: View {
    let color: Color

    var body: some View {
        Color.surface
    }
}

/// One stat column: condensed value (+ unit) over an uppercase label. No icon tile, no fill.
/// `systemImage` is accepted for API compatibility but not drawn.
struct SocialStatCell: View {
    let value: String
    let label: String
    var unit: String? = nil
    var systemImage: String? = nil
    var tint: Color = .primary

    var body: some View {
        VStack(spacing: 4) {
            StatValue(value: value, unit: unit, font: Font.statNumber, tint: DS.restrainedTint(tint))
            Text(label)
                .statLabelStyle()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// Thin two-sided bar comparing what each side took from the other (rivalries).
struct SocialDuelBar: View {
    let left: Double
    let right: Double
    var leftColor: Color = .brand
    var rightColor: Color = Color(uiColor: .tertiaryLabel)

    var body: some View {
        GeometryReader { proxy in
            let total: Double = max(left + right, 1)
            let available: CGFloat = max(0, proxy.size.width - 2)
            let leftWidth: CGFloat = min(max(4, available * CGFloat(left / total)), max(0, available - 4))
            HStack(spacing: 2) {
                Rectangle()
                    .fill(leftColor)
                    .frame(width: leftWidth)
                Rectangle()
                    .fill(rightColor)
            }
            .clipShape(Capsule())
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }
}

/// Neutral text-style button label for the secondary choice next to a prominent one
/// (e.g. "Rechazar" next to "Aceptar").
struct SocialPlainActionLabel: View {
    let title: String
    var tint: Color = .secondary

    var body: some View {
        Text(title)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(tint)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .frame(minHeight: 32)
            .contentShape(Rectangle())
    }
}
