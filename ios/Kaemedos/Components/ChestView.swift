import SwiftUI

/// A chest with a light effect that grows with its rarity (Metal shaders in ChestEffects.metal):
/// common — a metallic glint now and then · rare — blue wisps of light around the outline ·
/// epic — swirling purple aura and twinkling sparkles · legendary — soft diamond-blue flames
/// rising from the outline, their light flickering on the chest, rising embers and sparkles.
/// The effects draw outside the frame (they never change the layout) and ignore touches.
/// With Reduce Motion only a still glow is shown.
struct ChestView: View {
    let rarity: String
    let size: CGFloat
    /// false: just the image, no light at all (e.g. a tier that hasn't been reached).
    var animated: Bool = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start = Date()

    var body: some View {
        Group {
            if !animated {
                ChestEffects(style: ChestStyle(rarity), size: size, time: nil, lit: false)
            } else if reduceMotion {
                ChestEffects(style: ChestStyle(rarity), size: size, time: nil, lit: true)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                    ChestEffects(
                        style: ChestStyle(rarity),
                        size: size,
                        // Seconds since it appeared: small numbers keep the shaders' Float precise
                        time: context.date.timeIntervalSince(start),
                        lit: true
                    )
                }
            }
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Style per rarity

private struct ChestStyle {
    struct Aura {
        let color: Color
        /// 0: wisps rise; 1: they also swirl around the chest.
        let swirl: Double
        let strength: Double
    }

    let rarity: String
    let glintPeriod: Double
    let glint: Double
    let glintTint: Color
    let aura: Aura?
    let fire: Bool
    let sparkles: Int
    let embers: Int

    init(_ rarity: String) {
        self.rarity = rarity
        switch rarity {
        case "rare":
            glintPeriod = 3.4; glint = 1.4; glintTint = Color(red: 0.4, green: 0.7, blue: 1)
            aura = Aura(color: Color(red: 0.30, green: 0.64, blue: 1), swirl: 0, strength: 1.5)
            fire = false; sparkles = 0; embers = 0
        case "epic":
            glintPeriod = 3.0; glint = 1.4; glintTint = Color(red: 0.75, green: 0.5, blue: 1)
            aura = Aura(color: Color(red: 0.70, green: 0.42, blue: 1), swirl: 1, strength: 1.7)
            fire = false; sparkles = 5; embers = 0
        case "legendary":
            glintPeriod = 2.6; glint = 1.3; glintTint = Color(red: 0.6, green: 0.85, blue: 1)
            aura = Aura(color: Rarity.diamondLight, swirl: 0, strength: 0.55)
            fire = true; sparkles = 4; embers = 12
        default:
            glintPeriod = 4.2; glint = 1.3; glintTint = Color(red: 1, green: 0.95, blue: 0.85)
            aura = nil; fire = false; sparkles = 0; embers = 0
        }
    }

    var particleColor: Color { aura?.color ?? .white }
}

// MARK: - Effects

private struct ChestEffects: View {
    let style: ChestStyle
    let size: CGFloat
    /// nil: a still frame (Reduce Motion or no animation).
    let time: Double?
    /// false: no light at all.
    let lit: Bool

    @Environment(\.colorScheme) private var colorScheme

    /// Room around the chest for the glow and the flames (fraction of `size` on each side).
    private let pad: CGFloat = 0.35
    private var side: CGFloat { size * (1 + pad * 2) }
    private var imageName: String { Rarity.chestImage(style.rarity) }
    private var isDark: Bool { colorScheme == .dark }

    var body: some View {
        surface
            .background {
                if lit { behind }
            }
            .overlay {
                if lit, let time {
                    ChestParticles(style: style, size: size, time: time, isDark: isDark)
                        .frame(width: side, height: side)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
    }

    private var chest: some View {
        Image(imageName)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
    }

    /// The chest with its glint (and the flames' light on it).
    @ViewBuilder
    private var surface: some View {
        if lit, let time {
            chest.colorEffect(ShaderLibrary.chestSurface(
                .float(time),
                .float(size),
                .float(style.glintPeriod),
                .float(style.glint),
                .color(style.glintTint),
                .float(style.fire ? 1 : 0),
                .color(Rarity.diamondLight)
            ))
        } else {
            chest
        }
    }

    /// The chest's exact outline in white, with transparent room around it.
    private var silhouette: some View {
        Image(imageName)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .padding(size * pad)
    }

    private var behind: some View {
        ZStack {
            if let aura = style.aura {
                silhouette
                    .blur(radius: size * 0.11)
                    .layerEffect(ShaderLibrary.chestAura(
                        // Still frame: a fixed moment of the wisps
                        .float(time ?? 1.3),
                        .float(size),
                        .float(side),
                        .color(aura.color),
                        .float(aura.swirl),
                        .float(aura.strength)
                    ), maxSampleOffset: .zero)
            }
            if style.fire, let time {
                let flames = silhouette
                    .blur(radius: size * 0.03)
                    .layerEffect(
                        ShaderLibrary.chestFire(.float(time), .float(size), .float(1)),
                        maxSampleOffset: CGSize(width: size * 0.2, height: size * 0.4)
                    )
                // Bloom: a blurred copy, adding light on dark backgrounds
                flames
                    .blur(radius: size * 0.06)
                    .opacity(isDark ? 0.8 : 0.6)
                    .blendMode(isDark ? .plusLighter : .normal)
                flames
            }
        }
        .frame(width: side, height: side)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Particles

/// Deterministic pseudo-random value in 0..<1.
private func fract(_ value: Double) -> Double {
    value - floor(value)
}

/// Twinkling four-point sparkles around the top and sides, and (legendary) embers rising from the
/// flames. Drawn as soft radial glows, added as light on dark backgrounds.
private struct ChestParticles: View {
    let style: ChestStyle
    let size: CGFloat
    let time: Double
    let isDark: Bool

    private let pad: CGFloat = 0.35

    var body: some View {
        Canvas { context, _ in
            context.blendMode = isDark ? .plusLighter : .normal
            context.opacity = isDark ? 1 : 0.6
            if style.embers > 0 {
                drawEmbers(in: &context, count: size < 48 ? style.embers / 2 : style.embers)
            }
            if style.sparkles > 0 {
                drawSparkles(in: &context)
            }
        }
    }

    private func point(_ x: Double, _ y: Double) -> CGPoint {
        CGPoint(x: size * pad + CGFloat(x) * size, y: size * pad + CGFloat(y) * size)
    }

    /// A soft dot: bright core plus a wide faint halo.
    private func glow(_ context: inout GraphicsContext, at center: CGPoint, radius: CGFloat, color: Color, intensity: Double) {
        guard radius > 0.05, intensity > 0.01 else { return }
        let halo = radius * 3
        context.fill(
            Path(ellipseIn: CGRect(x: center.x - halo, y: center.y - halo, width: halo * 2, height: halo * 2)),
            with: .radialGradient(
                Gradient(colors: [color.opacity(0.35 * intensity), color.opacity(0)]),
                center: center, startRadius: 0, endRadius: halo
            )
        )
        context.fill(
            Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)),
            with: .radialGradient(
                Gradient(colors: [color.opacity(min(1, intensity)), color.opacity(0)]),
                center: center, startRadius: 0, endRadius: radius
            )
        )
    }

    private func drawEmbers(in context: inout GraphicsContext, count: Int) {
        for index in 0..<count {
            let seed = Double(index)
            let period = 1.6 + 1.2 * fract(seed * 0.613)
            let cycleTime = time / period + fract(seed * 0.419)
            let life = fract(cycleTime)
            let cycle = floor(cycleTime)
            let startX = 0.12 + 0.76 * fract(seed * 0.618 + cycle * 0.31)
            let startY = 0.24 + 0.16 * abs(startX - 0.5)
            let x = startX + 0.06 * sin(time * 2.3 + seed * 1.7) * life + 0.03 * sin(time * 5.1 + seed) * life
            let y = startY - 0.55 * life
            let flicker = 0.7 + 0.3 * sin(time * 17 + seed * 3)
            let fade = pow(1 - life, 1.5) * min(1, life / 0.08)
            // White-blue when born, deeper blue as it cools
            let color = Color(red: 0.85 - 0.70 * life, green: 0.97 - 0.52 * life, blue: 1)
            glow(&context, at: point(x, y), radius: size * 0.012 * CGFloat(1.2 - life * 0.5) * 2.2, color: color, intensity: fade * flicker)
        }
    }

    private func drawSparkles(in context: inout GraphicsContext) {
        for index in 0..<style.sparkles {
            let seed = Double(index)
            let period = 1.7 + 1.3 * fract(seed * 0.531)
            let cycleTime = time / period + fract(seed * 0.271)
            let life = fract(cycleTime)
            let cycle = floor(cycleTime)
            // A new spot each time it lights up, around the top and the sides
            let angle = Double.pi * (0.85 + 1.3 * fract(seed * 0.618 + cycle * 0.377))
            let distance = 0.30 + 0.16 * fract(seed * 0.77 + cycle * 0.53)
            let x = 0.5 + distance * 1.25 * cos(angle)
            let y = 0.5 + distance * 0.95 * sin(angle) - 0.02
            // Sharp attack, slow decay
            let attack = min(1, life / 0.12)
            let decay = 1 - smoothstep(0.12, 1, life)
            let strength = attack * decay
            guard strength > 0.02 else { continue }
            let radius = size * 0.075 * CGFloat(strength)
            let center = point(x, y)
            glow(&context, at: center, radius: radius * 0.7, color: style.particleColor, intensity: strength * 0.45)
            glow(&context, at: center, radius: radius * 0.35, color: .white, intensity: strength)
            // Cross flare, slowly turning
            var flare = context
            flare.translateBy(x: center.x, y: center.y)
            flare.rotate(by: .radians(life * 0.6))
            let length = radius * 2.2
            let thickness = max(0.6, radius * 0.08)
            for turn in 0..<2 {
                var arm = flare
                arm.rotate(by: .degrees(Double(turn) * 90))
                arm.fill(
                    Path(roundedRect: CGRect(x: -length, y: -thickness / 2, width: length * 2, height: thickness), cornerRadius: thickness / 2),
                    with: .linearGradient(
                        Gradient(stops: [
                            .init(color: .white.opacity(0), location: 0),
                            .init(color: .white.opacity(strength * 0.9), location: 0.5),
                            .init(color: .white.opacity(0), location: 1)
                        ]),
                        startPoint: CGPoint(x: -length, y: 0),
                        endPoint: CGPoint(x: length, y: 0)
                    )
                )
            }
        }
    }

    private func smoothstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
        let t = min(max((x - edge0) / (edge1 - edge0), 0), 1)
        return t * t * (3 - 2 * t)
    }
}

#Preview("Cofres") {
    VStack(spacing: 48) {
        ForEach([38, 64, 100], id: \.self) { size in
            HStack(spacing: 32) {
                ForEach(["common", "rare", "epic", "legendary"], id: \.self) { rarity in
                    ChestView(rarity: rarity, size: CGFloat(size))
                }
            }
        }
    }
    .padding(48)
    .background(Color.canvas)
}
