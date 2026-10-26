import SwiftUI
import UIKit

// MARK: - Runna design system — quick guide (read before styling ANY screen)
//
// DIRECTION: premium athletic / editorial (think Strava, Nike Run Club, Apple Fitness, Linear).
// Calm neutral surfaces, ONE brand accent used sparingly, strong typographic hierarchy, flat
// containers with hairlines. If something looks "playful", "glowing" or "candy", it is wrong.
//
// HARD RULES
//   • No gradients (the old gradient tokens now render SOLID — don't add new LinearGradients;
//     the only exception is a very subtle legibility scrim over a map/photo).
//   • No glow, halos, pulsing or bouncing decorations. No `.shadow` on cards. Motion is functional
//     only: `.snappy` state changes, `.contentTransition(.numericText())` on counters.
//   • No emoji in UI chrome (titles, labels, buttons, badges, copy we write). Emoji only inside
//     user/API content (e.g. a power's emoji) and then small (≤ .body). Prefer SF Symbols.
//   • NEVER `design: .rounded`. Use SF Pro (default design). Numbers use the condensed stat fonts.
//   • Colour budget per screen: neutrals + brand. Coral (`Color.steal`) only as TEXT/ICON colour
//     for stolen/lost/destructive values — never a filled block. Gold only for #1-rank details.
//     Territory colours (`Color(hex: user.color)`) are identity: avatar ring, a small dot. Nothing else.
//   • No filled/tinted capsule "pills" behind every number. Separate stats with hairline dividers
//     (`StatDivider()`), put labels under values (`.statLabelStyle()`).
//   • No coloured circle backgrounds behind icons (avatars are the only circles with fills).
//   • Copy: concise, confident, adult Spanish (Spain). Sentence case. Avoid "¡...!" — one at most
//     per screen, ideally none. No slang ("crew", "currado", "pique") in new copy.
//
// COLOURS (adaptive; write them as `Color.xxx` — `.foregroundStyle(.brand)` does NOT compile):
//   Color.brand         deep emerald — primary actions, selection, the user's OWN data. Sparingly.
//   Color.onBrand       text/icon colour ON a brand fill (white in light, near-black in dark)
//   Color.brandDeep     darker emerald (pressed states, text on very light backgrounds)
//   Color.brandLime     legacy: now a quiet lighter emerald. Don't use in new code.
//   Color.steal         coral/red — TEXT colour for "robado / perdido / destructive". Never a fill.
//   Color.gold          muted gold — ONLY rank #1 details (crown glyph, "#1" text)
//   Color.sky, .grape   legacy, now desaturated slate / indigo. Avoid in new code (use .secondary).
//   Color.canvas        screen background = systemGroupedBackground (use `.screenBackground()`)
//   Color.surface       card fill = secondarySystemGroupedBackground (use `.card()`)
//   Color.surfaceRaised element nested in a card = tertiarySystemGroupedBackground / inputs
//   Color.hairline      separator colour for 0.5pt strokes and dividers
//   Text: `.primary` for content, `.secondary` for metadata, `.tertiary` for disabled/hints.
//
// GRADIENT TOKENS (kept so old code compiles — they now render as a flat solid colour):
//   .brandGradient = brand, .stealGradient = steal, .goldGradient = gold, .grapeGradient = grape.
//   Don't use them for large blocks: a big coloured hero card is off-brand. Use `.card()` instead.
//
// TYPOGRAPHY (SF Pro, default design):
//   Font.screenTitle    34 bold, use with `.tracking(DS.Tracking.title)` — custom large titles
//   Font.sectionTitle   title3 semibold — a big in-content heading (rare)
//   Font.sectionLabel   caption semibold — section headers; use `.sectionLabelStyle()`
//                       (UPPERCASE + tracking + secondary). This is the default section header.
//   Font.cardTitle      headline (semibold) — title inside a card / list row
//   Font.statHero       hero number (≈44 bold condensed) — summary screens
//   Font.statNumber     standard stat value (≈24 semibold condensed)
//   Font.stat(size, weight:)  condensed number of any size (heavy/black are clamped to bold)
//   Font.statUnit       unit next to a number (subheadline medium) — colour `.secondary`
//   Font.statLabel      label under a stat (caption2 semibold) — use `.statLabelStyle()`
//   Font.meta           caption — metadata lines (dates, counts)
//   Always add `.monospacedDigit()` to changing numbers. Use `StatValue(value:unit:)` for value+unit.
//
// SPACING / SHAPES:
//   DS.Spacing.xs 4, .s 8, .m 12, .l 16 (card padding), .xl 20 (screen margin), .xxl 24, .xxxl 32
//   DS.Radius.card 14 (cards), .tile 12 (nested tiles, thumbnails), .small 10, .control 12 (buttons)
//   DS.Stroke.hairline 0.5 — card / control outlines.  DS.Size.mapControl 44, .icon 17.
//   Chips are Capsules; buttons are 12pt rounded rects (the "Correr" button is a capsule).
//
// ICONS: SF Symbols only. `.symbolRenderingMode(.monochrome)` (or `.hierarchical` for multi-layer
//   glyphs), weight .regular/.medium, colour `.secondary` (or `.primary` / brand when selected).
//   Prefer outline glyphs in content; `.fill` only for selected states / tab bar.
//
// MODIFIERS:
//   .card(padding:radius:)    flat surface card: surface fill, 14pt continuous corners, hairline,
//                             no shadow. THE container for content.
//   .cardStyle()              legacy name, same as .card()
//   .screenBackground()       grouped canvas behind a whole screen
//   .listBackground()         for List/Form (prefer `.listStyle(.insetGrouped)` lists)
//   .glassSurface(shape, interactive:)  floating control over a map: subtle Liquid Glass on iOS 26,
//                             .regularMaterial + hairline on iOS 17/18. Only over maps/photos.
//   .statLabelStyle()         uppercase tiny label under stats
//   .sectionLabelStyle()      uppercase section header label
//   .hairlineBorder(radius:)  adds just the 0.5pt outline
//   .buttonStyle(.pressable)  subtle press feedback (opacity + tiny scale)
//
// COMPONENTS (DesignSystem.swift + CommonViews.swift):
//   GlassCircleButton(systemImage:accessibilityLabel:badge:tint:isActive:size:action:)
//                             44pt round map control. isActive → icon in tint/brand (no fill).
//   GlassCircleLabel          same visual without a Button (Menu labels)
//   GlassGroup { }            groups glass controls (GlassEffectContainer on iOS 26)
//   PrimaryActionButton(title:systemImage:style:pulse:action:)  solid brand capsule ("Correr").
//                             `pulse` and `style` are ignored visually (kept for API).
//   PrimaryButtonStyle(color:)  full-width solid button, 12pt radius. Non-brand accent colours
//                             (steal/gold/grape/sky) are normalised to brand — one accent.
//   SecondaryButtonStyle(tint:) neutral fill (tertiarySystemFill), label in tint
//   StatTile(value:label:unit:tint:)  value + unit + label column. Legacy sky/grape tints → primary.
//   StatValue(value:unit:font:tint:)  number + smaller secondary unit, inline
//   StatDivider(height:)      vertical hairline between stats;  HairlineDivider() horizontal
//   StatPill(value:label:systemImage:tint:)  quiet neutral tag (no tinted capsule)
//   SectionHeader(title:subtitle:systemImage:actionTitle:action:)  uppercase label header
//   SectionLabel(_:)          just the uppercase label text
//   ChipToggle(title:isOn:color:systemImage:onGlass:action:)  outline / inverted selection chips
//   CountBadge(count:)        small coral count bubble
//   AvatarView(name:avatar:color:size:ring:)  avatar with thin territory-colour ring
//   EmptyStateView(...) / ErrorView(...) / ErrorBanner(...)  calm states, no halos
//   RouteShape(coordinates:), Haptics.tap()/success()

// MARK: - Tokens

enum DS {
    enum Spacing {
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 16
        static let xl: CGFloat = 20
        static let xxl: CGFloat = 24
        static let xxxl: CGFloat = 32
        /// Horizontal screen margin.
        static let screen: CGFloat = 20
        /// Default inner padding of a card.
        static let card: CGFloat = 16
    }

    enum Radius {
        /// Cards and grouped containers.
        static let card: CGFloat = 14
        /// Nested tiles, thumbnails, inputs.
        static let tile: CGFloat = 12
        static let small: CGFloat = 10
        /// Buttons.
        static let control: CGFloat = 12
    }

    enum Stroke {
        /// Card / control outline width.
        static let hairline: CGFloat = 0.5
    }

    enum Size {
        /// Round floating map control.
        static let mapControl: CGFloat = 44
        /// Default SF Symbol point size inside controls.
        static let icon: CGFloat = 17
        /// Primary button height.
        static let button: CGFloat = 50
    }

    enum Tracking {
        /// Large titles (slightly tight).
        static let title: CGFloat = -0.4
        /// Uppercase labels.
        static let label: CGFloat = 0.8
    }

    /// Legacy accent colours (sky / grape / lime) collapse to `.primary` so numbers don't turn into a rainbow.
    static func restrainedTint(_ color: Color) -> Color {
        if color == Color.sky || color == Color.grape || color == Color.brandLime {
            return Color.primary
        }
        return color
    }

    /// Fills for solid buttons: only the brand accent (or a neutral the caller chose explicitly).
    static func buttonFill(_ color: Color) -> Color {
        if color == Color.steal || color == Color.gold || color == Color.grape || color == Color.sky
            || color == Color.brandLime || color == Color.brandDeep {
            return Color.brand
        }
        return color
    }
}

// MARK: - Colours

extension UIColor {
    /// 0xRRGGBB → UIColor.
    convenience init(rgb: UInt32, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: alpha
        )
    }
}

extension Color {
    /// A colour that switches between a light-mode and a dark-mode value.
    static func adaptive(light: UInt32, dark: UInt32) -> Color {
        let lightColor = UIColor(rgb: light)
        let darkColor = UIColor(rgb: dark)
        return Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? darkColor : lightColor
        })
    }

    /// Deep, slightly desaturated emerald — the single brand accent.
    static let brand = Color.adaptive(light: 0x0E8A5F, dark: 0x3CC98E)
    /// Text / icons placed on a brand fill.
    static let onBrand = Color.adaptive(light: 0xFFFFFF, dark: 0x05170F)
    /// Darker emerald (pressed states, text on light tints).
    static let brandDeep = Color.adaptive(light: 0x0A6B4A, dark: 0x2AA874)
    /// Legacy highlight; now a quiet lighter emerald.
    static let brandLime = Color.adaptive(light: 0x3A9C76, dark: 0x6AD6A8)
    /// Coral red: stolen / lost / destructive — as text colour.
    static let steal = Color.adaptive(light: 0xD64531, dark: 0xFF7A66)
    /// Muted gold: rank #1 details only.
    static let gold = Color.adaptive(light: 0xB08415, dark: 0xE0B44A)
    /// Legacy info colour, desaturated slate blue.
    static let sky = Color.adaptive(light: 0x4F6B8A, dark: 0x92A9C4)
    /// Legacy special colour, desaturated indigo.
    static let grape = Color.adaptive(light: 0x5D5A93, dark: 0xA3A0D6)

    /// Screen background.
    static let canvas = Color(uiColor: .systemGroupedBackground)
    /// Card background.
    static let surface = Color(uiColor: .secondarySystemGroupedBackground)
    /// Element nested inside a card.
    static let surfaceRaised = Color(uiColor: .tertiarySystemGroupedBackground)
    /// Hairline outlines and separators.
    static let hairline = Color(uiColor: .separator).opacity(0.6)
}

extension ShapeStyle where Self == LinearGradient {
    /// Legacy: renders as solid brand (no gradients in the new direction).
    static var brandGradient: LinearGradient {
        LinearGradient(colors: [Color.brand, Color.brand], startPoint: .top, endPoint: .bottom)
    }

    /// Legacy: renders as solid coral.
    static var stealGradient: LinearGradient {
        LinearGradient(colors: [Color.steal, Color.steal], startPoint: .top, endPoint: .bottom)
    }

    /// Legacy: renders as solid gold.
    static var goldGradient: LinearGradient {
        LinearGradient(colors: [Color.gold, Color.gold], startPoint: .top, endPoint: .bottom)
    }

    /// Legacy: renders as solid indigo.
    static var grapeGradient: LinearGradient {
        LinearGradient(colors: [Color.grape, Color.grape], startPoint: .top, endPoint: .bottom)
    }
}

// MARK: - Typography

extension Font {
    /// Custom large title (34 bold). Pair with `.tracking(DS.Tracking.title)`.
    static let screenTitle = Font.system(size: 34, weight: .bold)
    /// Standard stat value: condensed semibold.
    static let statNumber = Font.system(size: 24, weight: .semibold).width(.condensed)
    /// Hero number (summary screens).
    static let statHero = Font.system(size: 44, weight: .bold).width(.condensed)
    /// Unit next to a stat value (colour `.secondary`).
    static let statUnit = Font.system(.subheadline, weight: .medium)
    /// Small label under a stat (use with `.statLabelStyle()`).
    static let statLabel = Font.system(.caption2, weight: .semibold)
    /// Section header label (use with `.sectionLabelStyle()`).
    static let sectionLabel = Font.system(.caption, weight: .semibold)
    /// Larger in-content heading.
    static let sectionTitle = Font.system(.title3, weight: .semibold)
    /// Title inside a card or row.
    static let cardTitle = Font.headline
    /// Metadata line (dates, counts).
    static let meta = Font.caption

    /// Condensed number of a custom size. Heavy / black are clamped to bold.
    static func stat(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        let clamped: Font.Weight = (weight == .heavy || weight == .black) ? .bold : weight
        return Font.system(size: size, weight: clamped).width(.condensed)
    }
}

// MARK: - Modifiers

/// Flat surface card: fill, continuous corners and a hairline. No shadow.
struct CardBackground: ViewModifier {
    var padding: CGFloat = DS.Spacing.card
    var radius: CGFloat = DS.Radius.card

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .padding(padding)
            .background(Color.surface, in: shape)
            .overlay(shape.strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline))
    }
}

/// Floating control background (subtle Liquid Glass on iOS 26, material + hairline on iOS 17/18).
struct GlassSurface<S: Shape>: ViewModifier {
    let shape: S
    var interactive: Bool = false

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .glassEffect(interactive ? Glass.regular.interactive() : Glass.regular, in: shape)
        } else {
            content
                .background(.regularMaterial, in: shape)
                .overlay(shape.stroke(Color.hairline, lineWidth: DS.Stroke.hairline))
                .shadow(color: Color.black.opacity(0.06), radius: 4, x: 0, y: 1)
        }
    }
}

extension View {
    /// Flat surface card — the default container for content.
    func card(padding: CGFloat = DS.Spacing.card, radius: CGFloat = DS.Radius.card) -> some View {
        modifier(CardBackground(padding: padding, radius: radius))
    }

    /// Floating background for controls drawn over a map or photo.
    func glassSurface<S: Shape>(_ shape: S, interactive: Bool = false) -> some View {
        modifier(GlassSurface(shape: shape, interactive: interactive))
    }

    /// Grouped canvas behind the whole screen.
    func screenBackground() -> some View {
        background(Color.canvas.ignoresSafeArea())
    }

    /// For List / Form: hides the system background and shows the canvas.
    func listBackground() -> some View {
        scrollContentBackground(.hidden)
            .background(Color.canvas.ignoresSafeArea())
    }

    /// Uppercase, tracked, secondary — for labels under stat numbers.
    func statLabelStyle() -> some View {
        font(Font.statLabel)
            .textCase(.uppercase)
            .tracking(DS.Tracking.label)
            .foregroundStyle(.secondary)
    }

    /// Uppercase, tracked, secondary — section header labels.
    func sectionLabelStyle() -> some View {
        font(Font.sectionLabel)
            .textCase(.uppercase)
            .tracking(DS.Tracking.label)
            .foregroundStyle(.secondary)
    }

    /// Just the 0.5pt hairline outline in a continuous rounded rectangle.
    func hairlineBorder(radius: CGFloat = DS.Radius.card) -> some View {
        overlay(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline)
        )
    }
}

/// Subtle press feedback (slight dim + scale), no spring bounce.
struct PressableButtonStyle: ButtonStyle {
    var scale: CGFloat = 0.97

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == PressableButtonStyle {
    /// Subtle press feedback.
    static var pressable: PressableButtonStyle { PressableButtonStyle() }
}

// MARK: - Glass controls

/// Groups several glass controls so they blend together on iOS 26 (GlassEffectContainer).
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 10
    @ViewBuilder var content: Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) {
                content
            }
        } else {
            content
        }
    }
}

/// The visual of a round floating control (also usable as a Menu label).
struct GlassCircleLabel: View {
    let systemImage: String
    var badge: Int? = nil
    var tint: Color? = nil
    var isActive: Bool = false
    var size: CGFloat = DS.Size.mapControl
    /// Kept for API compatibility (no bounce in the new direction).
    var bounceTrigger: Int = 0

    private var iconColor: Color {
        if isActive { return tint ?? Color.brand }
        return tint ?? Color.primary
    }

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: min(DS.Size.icon, size * 0.4), weight: .medium))
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(iconColor)
            .frame(width: size, height: size)
            .glassSurface(Circle(), interactive: true)
            .contentShape(Circle())
            .overlay(alignment: .topTrailing) {
                if let badge, badge > 0 {
                    CountBadge(count: badge)
                        .offset(x: 3, y: -3)
                }
            }
    }
}

/// Round floating map control.
struct GlassCircleButton: View {
    let systemImage: String
    let accessibilityLabel: String
    var badge: Int? = nil
    var tint: Color? = nil
    var isActive: Bool = false
    var size: CGFloat = DS.Size.mapControl
    let action: () -> Void

    @State private var taps = 0

    var body: some View {
        Button {
            taps += 1
            action()
        } label: {
            GlassCircleLabel(systemImage: systemImage, badge: badge, tint: tint, isActive: isActive, size: size, bounceTrigger: taps)
        }
        .buttonStyle(.pressable)
        .sensoryFeedback(.impact(weight: .light), trigger: taps)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}

/// Small count bubble.
struct CountBadge: View {
    let count: Int
    var color: Color = .steal

    var body: some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(.system(size: 11, weight: .semibold))
            .monospacedDigit()
            .foregroundStyle(Color.white)
            .contentTransition(.numericText())
            .padding(.horizontal, 5)
            .frame(minWidth: 18, minHeight: 18)
            .background(color, in: Capsule())
            .overlay(Capsule().stroke(Color(uiColor: .systemBackground), lineWidth: 1.5))
            .accessibilityHidden(true)
    }
}

// MARK: - Primary action

/// Solid brand capsule for the screen's main action (e.g. "Correr").
struct PrimaryActionButton: View {
    enum Style {
        case brand, steal, gold

        /// Legacy name; the accent colour of the style.
        var glow: Color {
            switch self {
            case .brand: return Color.brand
            case .steal: return Color.steal
            case .gold: return Color.gold
            }
        }

        /// Legacy name; now a flat fill.
        var gradient: LinearGradient {
            switch self {
            case .brand: return .brandGradient
            case .steal: return .stealGradient
            case .gold: return .goldGradient
            }
        }
    }

    let title: String
    var systemImage: String? = nil
    /// Kept for API compatibility; always rendered as the brand fill.
    var style: Style = .brand
    /// Kept for API compatibility; no halo is drawn.
    var pulse: Bool = false
    let action: () -> Void

    @State private var taps = 0
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button {
            taps += 1
            action()
        } label: {
            label
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .sensoryFeedback(.impact(weight: .medium), trigger: taps)
    }

    private var label: some View {
        HStack(spacing: 8) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 17, weight: .semibold))
            }
            Text(title)
                .font(.system(size: 17, weight: .semibold))
        }
        .foregroundStyle(Color.onBrand)
        .padding(.horizontal, 32)
        .frame(minWidth: 160, minHeight: 52)
        .background(Color.brand, in: Capsule())
        .opacity(isEnabled ? 1 : 0.4)
        .contentShape(Capsule())
    }
}

/// Neutral filled button with a tinted label, for secondary actions.
struct SecondaryButtonStyle: ButtonStyle {
    var tint: Color = .brand

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous)
        let fill: UIColor = configuration.isPressed ? UIColor.secondarySystemFill : UIColor.tertiarySystemFill
        return configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(DS.restrainedTint(tint))
            .padding(.horizontal, 14)
            .frame(minHeight: 36)
            .background(Color(uiColor: fill), in: shape)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

// MARK: - Stats

/// Number + smaller secondary unit, inline (e.g. "0,75 km²").
struct StatValue: View {
    let value: String
    var unit: String? = nil
    var font: Font = Font.statNumber
    var tint: Color = .primary

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(value)
                .font(font)
                .monospacedDigit()
                .foregroundStyle(tint)
                .contentTransition(.numericText())
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if let unit {
                Text(unit)
                    .font(Font.statUnit)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Vertical hairline between stats in a row.
struct StatDivider: View {
    var height: CGFloat = 28

    var body: some View {
        Rectangle()
            .fill(Color.hairline)
            .frame(width: 1, height: height)
            .accessibilityHidden(true)
    }
}

/// Horizontal hairline (inside cards, between rows).
struct HairlineDivider: View {
    var body: some View {
        Rectangle()
            .fill(Color.hairline)
            .frame(height: DS.Stroke.hairline)
            .accessibilityHidden(true)
    }
}

/// Quiet neutral tag: icon + value (+ label). No tinted capsule.
struct StatPill: View {
    let value: String
    var label: String? = nil
    var systemImage: String? = nil
    /// Only brand / steal / gold keep their colour (on the icon); others render secondary.
    var tint: Color = .brand

    private var iconColor: Color {
        let restrained = DS.restrainedTint(tint)
        return restrained == Color.primary ? Color.secondary : restrained
    }

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(iconColor)
            }
            Text(value)
                .font(.footnote.weight(.semibold))
                .monospacedDigit()
                .contentTransition(.numericText())
            if let label {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .lineLimit(1)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Headers and chips

/// Uppercase section label text.
struct SectionLabel: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title)
            .sectionLabelStyle()
            .accessibilityAddTraits(.isHeader)
    }
}

/// Section header: small uppercase label, optional subtitle and trailing action.
/// `systemImage` is accepted for API compatibility but not drawn (cleaner headers).
struct SectionHeader: View {
    let title: String
    var subtitle: String? = nil
    var systemImage: String? = nil
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                SectionLabel(title)
                if let subtitle {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.brand)
            }
        }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .contain)
    }
}

/// Filter chip (capsule). In lists: selected = inverted (primary fill); over a map (`onGlass`):
/// material chip, selected = primary text + solid dot, unselected = dimmed + hollow dot.
struct ChipToggle: View {
    let title: String
    let isOn: Bool
    /// Dot colour (e.g. a player's territory colour).
    var color: Color? = nil
    var systemImage: String? = nil
    /// Material look for chips floating over a map.
    var onGlass: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            content
        }
        .buttonStyle(.pressable)
        .sensoryFeedback(.selection, trigger: isOn)
        .accessibilityLabel(title)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }

    private var inverted: Bool { isOn && !onGlass }

    private var textColor: Color {
        if inverted { return Color(uiColor: .systemBackground) }
        return isOn ? Color.primary : Color.secondary
    }

    private var content: some View {
        HStack(spacing: 6) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption.weight(.medium))
            } else if let color {
                ZStack {
                    if isOn {
                        Circle().fill(color)
                    } else {
                        Circle().strokeBorder(color, lineWidth: 1.5)
                    }
                }
                .frame(width: 8, height: 8)
            }
            Text(title)
                .font(.footnote.weight(.medium))
                .lineLimit(1)
        }
        .foregroundStyle(textColor)
        .padding(.horizontal, 12)
        .frame(minHeight: 32)
        .background { chipBackground }
        .overlay(Capsule().strokeBorder(inverted ? Color.clear : Color.hairline, lineWidth: DS.Stroke.hairline))
        .contentShape(Capsule())
        .animation(.easeOut(duration: 0.15), value: isOn)
    }

    @ViewBuilder
    private var chipBackground: some View {
        if onGlass {
            Capsule()
                .fill(.regularMaterial)
                .opacity(isOn ? 1 : 0.75)
        } else if isOn {
            Capsule().fill(Color.primary)
        } else {
            Capsule().fill(Color.surface)
        }
    }
}

// MARK: - Errors

/// Compact inline error card with optional retry / dismiss.
struct ErrorBanner: View {
    let message: String
    var retry: (() -> Void)? = nil
    var onDismiss: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.circle")
                .font(.body.weight(.medium))
                .foregroundStyle(Color.steal)
            Text(message)
                .font(.footnote)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                Button("Reintentar", action: retry)
                    .buttonStyle(SecondaryButtonStyle(tint: .primary))
            }
            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                }
                .accessibilityLabel("Cerrar")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.surface, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
        .hairlineBorder(radius: DS.Radius.tile)
    }
}
