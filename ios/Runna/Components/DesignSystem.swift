import SwiftUI
import UIKit

// MARK: - Runna design system — quick guide
//
// Read this before styling a screen. Everything here works on iOS 17+ and upgrades
// to Liquid Glass on iOS 26 automatically (never call .glassEffect directly in a screen:
// use `.glassSurface(...)` / `GlassCircleButton` so the iOS 17 fallback is kept).
//
// COLOURS (adaptive light/dark, always write them as `Color.xxx` — `.foregroundStyle(.brand)`
// does NOT compile, `.foregroundStyle(Color.brand)` does):
//   Color.brand        vivid emerald, main brand colour (buttons, selected states, own stats)
//   Color.brandDeep    darker emerald (gradient start, text on light tints)
//   Color.brandLime    lime (gradient end, highlights)
//   Color.steal        coral/orange: stealing, attacks, "te han robado", destructive-but-playful
//   Color.gold         competitions, treasures, podiums, rank #1
//   Color.sky          info, distance, neutral highlights
//   Color.grape        finished competitions, special/epic things
//   Color.canvas       screen background (use `.screenBackground()`)
//   Color.surface      card background (use `.card()`)
//   Color.surfaceRaised  nested element inside a card (inputs, inner tiles)
//   Color.hairline     1pt separators / card outlines
//   Territory colours: `Color(hex: user.color)` — that colour IS the user's identity:
//   use it for avatar rings (AvatarView does it), chips, accents next to their name.
//
// GRADIENTS (`ShapeStyle`, so `.fill(.brandGradient)` / `.background(.brandGradient, in: Capsule())`):
//   .brandGradient  hero elements (Correr button, splash, big highlights)
//   .stealGradient  steal / attack moments
//   .goldGradient   competition / treasures / winners
//   .grapeGradient  finished competition, special
//
// TYPOGRAPHY (SF Pro Rounded for numbers and titles):
//   Font.statNumber    big bold stat value (title2 rounded bold) — add .monospacedDigit()
//   Font.statHero      hero number (largeTitle rounded heavy)
//   Font.statLabel     tiny label under a stat; pair with `.statLabelStyle()` (uppercase + tracking)
//   Font.sectionTitle  section headers (title3 rounded bold)
//   Font.cardTitle     title inside a card (headline rounded)
//   Font.stat(_ size:) custom-size rounded bold number
//
// SPACING / SHAPES:  DS.Spacing.s (8) .m (12) .l (16) .xl (20) .xxl (24)
//                    DS.Radius.card (22) .tile (16) .small (12); chips & buttons are Capsules.
//
// MODIFIERS:
//   .card(padding:radius:)    rounded surface card with soft shadow (THE container for content)
//   .cardStyle()              legacy name, same look as .card()
//   .screenBackground()       grouped adaptive canvas behind a whole screen
//   .listBackground()         for List/Form: hides the default background and uses the canvas
//   .glassSurface(shape, interactive:)  floating control over a map: Liquid Glass on iOS 26,
//                              ultraThinMaterial + hairline + shadow on iOS 17/18
//   .statLabelStyle()         uppercase small label for stats
//   .pressableScale()         springy scale-down while pressed (use as buttonStyle: .buttonStyle(.pressable))
//
// COMPONENTS (Components/DesignSystem.swift + Components/CommonViews.swift):
//   GlassCircleButton(systemImage:accessibilityLabel:badge:tint:isActive:action:)
//                             round floating map control (48pt), optional count badge
//   GlassCircleLabel          the same visual without a Button (for Menu labels)
//   GlassGroup { }            wraps several glass controls (GlassEffectContainer on iOS 26)
//   PrimaryActionButton(title:systemImage:style:pulse:action:)
//                             big gradient capsule for the screen's main action ("Correr")
//   PrimaryButtonStyle(color:)  full-width capsule button style (forms, sheets)
//   SecondaryButtonStyle(tint:) tinted soft capsule for secondary actions
//   StatTile(value:label:unit:tint:)   value + label column (run screens, profile)
//   StatPill(value:label:systemImage:tint:)  compact capsule with icon + value (+ label)
//   AvatarView(name:avatar:color:size:ring:)  avatar with territory-colour ring
//   SectionHeader(title:subtitle:systemImage:actionTitle:action:)
//   ChipToggle(title:isOn:color:systemImage:onGlass:action:)  filter chips (horizontal rows)
//   CountBadge(count:)        small red/coral count bubble
//   EmptyStateView(systemImage:title:message:actionTitle:action:tint:)  friendly empty states
//   ErrorView(message:retry:) full-screen-ish load error with retry
//   ErrorBanner(message:retry:onDismiss:)  compact inline error card
//   RouteShape(coordinates:)  route path drawing for list thumbnails
//   Haptics.tap()/success()   or prefer `.sensoryFeedback(...)` on the view
//
// MOTION: springs (`.snappy`, `.spring(duration: 0.35)`), `.symbolEffect(.bounce, value:)` on icons,
// `.contentTransition(.numericText())` on counters, sensory feedback on key actions.
// Respect `accessibilityReduceMotion` for anything that loops.

// MARK: - Tokens

enum DS {
    enum Spacing {
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 16
        static let xl: CGFloat = 20
        static let xxl: CGFloat = 24
    }

    enum Radius {
        static let card: CGFloat = 22
        static let tile: CGFloat = 16
        static let small: CGFloat = 12
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

    /// Vivid emerald, the brand colour.
    static let brand = Color.adaptive(light: 0x12A85E, dark: 0x2FD27F)
    /// Darker emerald (gradient start).
    static let brandDeep = Color.adaptive(light: 0x07875A, dark: 0x17B26A)
    /// Fresh lime (gradient end, highlights).
    static let brandLime = Color.adaptive(light: 0x7CCB1E, dark: 0xA3E635)
    /// Coral: stealing / attacks.
    static let steal = Color.adaptive(light: 0xFF5F45, dark: 0xFF7A5C)
    /// Gold: competitions, treasures, podiums.
    static let gold = Color.adaptive(light: 0xF2A900, dark: 0xFFC53D)
    /// Sky blue: info and neutral highlights.
    static let sky = Color.adaptive(light: 0x2B8CFF, dark: 0x5AA9FF)
    /// Grape: finished competitions, special items.
    static let grape = Color.adaptive(light: 0x7C4DFF, dark: 0x9D7BFF)

    /// Screen background (subtly green-tinted grouped background).
    static let canvas = Color.adaptive(light: 0xF2F5F3, dark: 0x0A0E0C)
    /// Card background.
    static let surface = Color.adaptive(light: 0xFFFFFF, dark: 0x161D19)
    /// Element nested inside a card.
    static let surfaceRaised = Color.adaptive(light: 0xF3F6F4, dark: 0x212A25)
    /// Hairline outlines and separators.
    static let hairline = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor.white.withAlphaComponent(0.08) : UIColor.black.withAlphaComponent(0.06)
    })
}

extension ShapeStyle where Self == LinearGradient {
    /// Emerald → lime, for hero elements.
    static var brandGradient: LinearGradient {
        LinearGradient(colors: [Color.brandDeep, Color.brand, Color.brandLime], startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    /// Coral → orange, for steal / attack moments.
    static var stealGradient: LinearGradient {
        LinearGradient(colors: [Color.steal, Color.adaptive(light: 0xFF9A2E, dark: 0xFFB14D)], startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    /// Amber → gold, for competitions and treasures.
    static var goldGradient: LinearGradient {
        LinearGradient(colors: [Color.adaptive(light: 0xFF8A00, dark: 0xFFA733), Color.gold], startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    /// Grape → indigo, for finished competitions and special things.
    static var grapeGradient: LinearGradient {
        LinearGradient(colors: [Color.grape, Color.adaptive(light: 0x4F46E5, dark: 0x6D68F0)], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

// MARK: - Typography

extension Font {
    /// Big bold stat value.
    static let statNumber = Font.system(.title2, design: .rounded, weight: .bold)
    /// Hero number (summary screens).
    static let statHero = Font.system(.largeTitle, design: .rounded, weight: .heavy)
    /// Small label under a stat (use with `.statLabelStyle()`).
    static let statLabel = Font.system(.caption2, design: .rounded, weight: .semibold)
    /// Section header.
    static let sectionTitle = Font.system(.title3, design: .rounded, weight: .bold)
    /// Title inside a card.
    static let cardTitle = Font.system(.headline, design: .rounded, weight: .bold)

    /// Rounded bold number of a custom size.
    static func stat(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight, design: .rounded)
    }
}

// MARK: - Modifiers

/// Rounded surface card with a soft shadow.
struct CardBackground: ViewModifier {
    var padding: CGFloat = DS.Spacing.l
    var radius: CGFloat = DS.Radius.card
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .padding(padding)
            .background(Color.surface, in: shape)
            .overlay(shape.strokeBorder(Color.hairline, lineWidth: 1))
            .shadow(color: .black.opacity(colorScheme == .dark ? 0 : 0.06), radius: 12, x: 0, y: 4)
    }
}

/// Floating glass control background (Liquid Glass on iOS 26, material on iOS 17/18).
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
                .background(.ultraThinMaterial, in: shape)
                .overlay(shape.stroke(Color.white.opacity(0.22), lineWidth: 0.75))
                .shadow(color: .black.opacity(0.14), radius: 10, x: 0, y: 4)
        }
    }
}

extension View {
    /// Rounded surface card with a soft shadow — the default container for content.
    func card(padding: CGFloat = DS.Spacing.l, radius: CGFloat = DS.Radius.card) -> some View {
        modifier(CardBackground(padding: padding, radius: radius))
    }

    /// Floating glass background for controls drawn over a map or photo.
    func glassSurface<S: Shape>(_ shape: S, interactive: Bool = false) -> some View {
        modifier(GlassSurface(shape: shape, interactive: interactive))
    }

    /// Adaptive grouped canvas behind the whole screen.
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
            .tracking(0.6)
            .foregroundStyle(.secondary)
    }
}

/// Springy scale-down while pressed.
struct PressableButtonStyle: ButtonStyle {
    var scale: CGFloat = 0.95

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == PressableButtonStyle {
    /// Springy scale-down while pressed.
    static var pressable: PressableButtonStyle { PressableButtonStyle() }
}

// MARK: - Glass controls

/// Groups several glass controls so they blend together on iOS 26 (GlassEffectContainer).
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 12
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
    var size: CGFloat = 48
    var bounceTrigger: Int = 0

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: size * 0.38, weight: .semibold))
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(isActive ? Color.white : (tint ?? Color.primary))
            .symbolEffect(.bounce, value: bounceTrigger)
            .frame(width: size, height: size)
            .background {
                if isActive {
                    Circle().fill(tint ?? Color.brand)
                }
            }
            .glassSurface(Circle(), interactive: true)
            .contentShape(Circle())
            .overlay(alignment: .topTrailing) {
                if let badge, badge > 0 {
                    CountBadge(count: badge)
                        .offset(x: 4, y: -4)
                }
            }
    }
}

/// Round floating map control: glass on iOS 26, material on older systems.
struct GlassCircleButton: View {
    let systemImage: String
    let accessibilityLabel: String
    var badge: Int? = nil
    var tint: Color? = nil
    var isActive: Bool = false
    var size: CGFloat = 48
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
    }
}

/// Small count bubble (coral, white outline).
struct CountBadge: View {
    let count: Int
    var color: Color = .steal

    var body: some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(.system(size: 11, weight: .heavy, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(.white)
            .contentTransition(.numericText())
            .padding(.horizontal, 5)
            .frame(minWidth: 20, minHeight: 20)
            .background(color, in: Capsule())
            .overlay(Capsule().stroke(Color.white, lineWidth: 1.5))
            .accessibilityHidden(true)
    }
}

// MARK: - Primary action

/// Big gradient capsule for the screen's main action (e.g. "Correr").
struct PrimaryActionButton: View {
    enum Style {
        case brand, steal, gold

        var glow: Color {
            switch self {
            case .brand: return Color.brand
            case .steal: return Color.steal
            case .gold: return Color.gold
            }
        }

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
    var style: Style = .brand
    /// Soft halo that keeps expanding behind the button.
    var pulse: Bool = false
    let action: () -> Void

    @State private var taps = 0
    @State private var pulsing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            taps += 1
            action()
        } label: {
            label
        }
        .buttonStyle(PressableButtonStyle(scale: 0.96))
        .sensoryFeedback(.impact(weight: .medium), trigger: taps)
        .onAppear {
            guard pulse, !reduceMotion else { return }
            withAnimation(.easeOut(duration: 1.8).repeatForever(autoreverses: false)) {
                pulsing = true
            }
        }
    }

    private var label: some View {
        HStack(spacing: 10) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 22, weight: .bold))
                    .symbolEffect(.bounce, value: taps)
            }
            Text(title)
                .font(.system(size: 22, weight: .heavy, design: .rounded))
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 36)
        .frame(minHeight: 62)
        .background { halo }
        .background(style.gradient, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.28), lineWidth: 1))
        .shadow(color: style.glow.opacity(0.45), radius: 16, x: 0, y: 8)
        .contentShape(Capsule())
    }

    @ViewBuilder
    private var halo: some View {
        if pulse && !reduceMotion {
            Capsule()
                .fill(style.glow.opacity(0.45))
                .scaleEffect(x: pulsing ? 1.14 : 1, y: pulsing ? 1.45 : 1)
                .opacity(pulsing ? 0 : 0.9)
        }
    }
}

/// Tinted soft capsule for secondary actions.
struct SecondaryButtonStyle: ButtonStyle {
    var tint: Color = .brand

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(.subheadline, design: .rounded, weight: .bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 16)
            .frame(minHeight: 40)
            .background(tint.opacity(configuration.isPressed ? 0.24 : 0.14), in: Capsule())
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

// MARK: - Stats

/// Compact capsule: icon + value (+ small label).
struct StatPill: View {
    let value: String
    var label: String? = nil
    var systemImage: String? = nil
    var tint: Color = .brand

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(tint)
            }
            Text(value)
                .font(.system(.subheadline, design: .rounded, weight: .bold))
                .monospacedDigit()
                .contentTransition(.numericText())
            if let label {
                Text(label)
                    .font(.system(.caption, design: .rounded, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
        .lineLimit(1)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(tint.opacity(0.14), in: Capsule())
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Headers and chips

/// Section title with optional icon, subtitle and trailing action.
struct SectionHeader: View {
    let title: String
    var subtitle: String? = nil
    var systemImage: String? = nil
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.headline)
                    .foregroundStyle(Color.brand)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Font.sectionTitle)
                if let subtitle {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.system(.subheadline, design: .rounded, weight: .semibold))
                    .foregroundStyle(Color.brand)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// Filter chip (capsule) that toggles on/off, optionally with the user's colour dot.
struct ChipToggle: View {
    let title: String
    let isOn: Bool
    /// Dot and tint colour (e.g. a player's territory colour).
    var color: Color? = nil
    var systemImage: String? = nil
    /// Glass look for chips floating over a map.
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

    private var tint: Color { color ?? Color.brand }

    private var content: some View {
        HStack(spacing: 6) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption.weight(.bold))
            } else if let color {
                Circle()
                    .fill(color)
                    .frame(width: 10, height: 10)
                    .overlay(Circle().stroke(Color.white.opacity(0.8), lineWidth: isOn ? 1.5 : 0))
            }
            Text(title)
                .font(.system(.footnote, design: .rounded, weight: .semibold))
                .lineLimit(1)
        }
        .foregroundStyle(isOn ? Color.primary : Color.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background { chipBackground }
        .overlay(Capsule().strokeBorder(isOn ? tint.opacity(0.9) : Color.clear, lineWidth: 1.5))
        .opacity(isOn ? 1 : 0.7)
        .contentShape(Capsule())
    }

    @ViewBuilder
    private var chipBackground: some View {
        if onGlass {
            Capsule()
                .fill(isOn ? tint.opacity(0.22) : Color.clear)
                .glassSurface(Capsule())
        } else {
            Capsule()
                .fill(isOn ? tint.opacity(0.16) : Color.surfaceRaised)
        }
    }
}

// MARK: - Errors

/// Compact inline error card (coral) with optional retry / dismiss.
struct ErrorBanner: View {
    let message: String
    var retry: (() -> Void)? = nil
    var onDismiss: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(Color.steal)
            Text(message)
                .font(.footnote.weight(.medium))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let retry {
                Button("Reintentar", action: retry)
                    .buttonStyle(SecondaryButtonStyle(tint: .steal))
            }
            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                }
                .accessibilityLabel("Cerrar")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.surface, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous).strokeBorder(Color.steal.opacity(0.35), lineWidth: 1))
    }
}
