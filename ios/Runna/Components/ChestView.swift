import SwiftUI

/// A chest with a light effect that grows with its rarity:
/// common — a glint now and then · rare — breathing blue glow · epic — purple aura and sparkles ·
/// legendary — flames licking the outline, golden glow and sparkles.
/// The effects draw outside the frame (they never change the layout) and ignore touches.
/// With Reduce Motion only a still glow is shown.
struct ChestView: View {
    let rarity: String
    let size: CGFloat
    /// false: just the image, no light at all (e.g. a tier that hasn't been reached).
    var animated: Bool = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if !animated {
                ChestEffects(tier: ChestTier(rarity), size: size, time: nil, lit: false)
            } else if reduceMotion {
                ChestEffects(tier: ChestTier(rarity), size: size, time: nil, lit: true)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                    ChestEffects(
                        tier: ChestTier(rarity),
                        size: size,
                        time: context.date.timeIntervalSinceReferenceDate,
                        lit: true
                    )
                }
            }
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Tier

private enum ChestTier: Int, Comparable {
    case common, rare, epic, legendary

    init(_ rarity: String) {
        switch rarity {
        case "rare": self = .rare
        case "epic": self = .epic
        case "legendary": self = .legendary
        default: self = .common
        }
    }

    static func < (lhs: ChestTier, rhs: ChestTier) -> Bool { lhs.rawValue < rhs.rawValue }

    var rarity: String {
        switch self {
        case .common: return "common"
        case .rare: return "rare"
        case .epic: return "epic"
        case .legendary: return "legendary"
        }
    }

    var glow: Color { Rarity.glowColor(rarity) }

    /// Seconds between two glints across the chest.
    var shinePeriod: Double {
        switch self {
        case .common: return 4.2
        case .rare: return 3.2
        case .epic: return 2.8
        case .legendary: return 2.4
        }
    }
}

// MARK: - Effects

private struct ChestEffects: View {
    let tier: ChestTier
    let size: CGFloat
    /// nil: a still frame (Reduce Motion or no animation).
    let time: Double?
    /// false: no glow either.
    let lit: Bool

    private var imageName: String { Rarity.chestImage(tier.rarity) }

    var body: some View {
        chest
            .scaleEffect(pulse)
            .background {
                if lit { behind }
            }
            .overlay {
                if lit, let time { front(time) }
            }
    }

    private var chest: some View {
        Image(imageName)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
    }

    /// The chest's exact outline, to be tinted and blurred into a glow.
    private var silhouette: some View {
        Image(imageName)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
    }

    private var pulse: CGFloat {
        guard let time, lit, tier >= .epic else { return 1 }
        return 1 + 0.025 * CGFloat(sin(time * 2 * .pi / 2.2))
    }

    /// 0…1 breathing value, 0.5 when still.
    private func breath(_ period: Double) -> Double {
        guard let time else { return 0.5 }
        return 0.5 + 0.5 * sin(time * 2 * .pi / period)
    }

    private var haloOpacity: Double {
        switch tier {
        case .common: return 0
        case .rare: return 0.35 + 0.35 * breath(2.4)
        case .epic: return 0.5 + 0.35 * breath(2.2)
        case .legendary:
            guard let time else { return 0.75 }
            // Flicker like firelight
            return min(1, 0.7 + 0.15 * sin(time * 7.3) + 0.1 * sin(time * 13.1 + 1.7))
        }
    }

    @ViewBuilder
    private var behind: some View {
        ZStack {
            if tier >= .rare {
                silhouette
                    .foregroundStyle(tier.glow)
                    .blur(radius: size * 0.08)
                    .scaleEffect(1.08)
                    .opacity(haloOpacity)
            }
            if tier == .legendary {
                silhouette
                    .foregroundStyle(Rarity.flameColor)
                    .blur(radius: size * 0.16)
                    .scaleEffect(1.2)
                    .opacity(haloOpacity * 0.6)
                if let time {
                    ChestFlames(time: time, size: size)
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func front(_ time: Double) -> some View {
        ZStack {
            shine(time)
            if tier >= .epic {
                ChestSparkles(time: time, size: size, color: tier.glow, count: tier == .legendary ? 7 : 5)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// A diagonal band of light that sweeps across the chest (only over the chest itself).
    private func shine(_ time: Double) -> some View {
        let period = tier.shinePeriod
        let phase = (time / period).truncatingRemainder(dividingBy: 1)
        // The sweep takes the first 35 % of the period; the rest is a pause
        let progress = phase / 0.35
        let x = (-0.8 + 1.6 * progress) * size
        return LinearGradient(
            colors: [.clear, .white.opacity(tier == .common ? 0.55 : 0.7), .clear],
            startPoint: .leading,
            endPoint: .trailing
        )
        .frame(width: size * 0.32, height: size * 1.6)
        .rotationEffect(.degrees(22))
        .offset(x: x)
        .opacity(progress <= 1 ? 1 : 0)
        .frame(width: size, height: size)
        .mask { chest }
        .blendMode(.plusLighter)
    }
}

// MARK: - Particles

/// Deterministic pseudo-random value in 0..<1 for a seed.
private func fract(_ value: Double) -> Double {
    value - floor(value)
}

/// Flames rising from the top and sides of the chest: blurred circles cut at an alpha threshold
/// (metaballs), so neighbouring particles merge into tongues of fire. Two layers: orange outside,
/// yellow core.
private struct ChestFlames: View {
    let time: Double
    let size: CGFloat

    /// The canvas reaches this far beyond the chest frame on every side (fraction of `size`).
    private let pad: CGFloat = 0.35

    private var count: Int { size < 48 ? 14 : 24 }
    /// Each particle is a vertical ellipse, so the merged shapes read as tongues of fire.
    private let stretch: CGFloat = 1.4

    var body: some View {
        Canvas { context, canvasSize in
            let particles = self.particles()
            var outer = context
            outer.addFilter(.alphaThreshold(min: 0.45, color: Rarity.flameColor))
            outer.addFilter(.blur(radius: size * 0.04))
            outer.drawLayer { layer in
                for particle in particles {
                    layer.fill(flame(at: particle.center, radius: particle.radius), with: .color(.black))
                }
            }
            var inner = context
            inner.addFilter(.alphaThreshold(min: 0.5, color: Rarity.flameCoreColor))
            inner.addFilter(.blur(radius: size * 0.028))
            inner.drawLayer { layer in
                for particle in particles {
                    // Smaller and a little lower: the hot core at the base of each tongue
                    let center = CGPoint(x: particle.center.x, y: particle.center.y + particle.radius * 0.3)
                    layer.fill(flame(at: center, radius: particle.radius * 0.55), with: .color(.black))
                }
            }
        }
        .frame(width: size * (1 + pad * 2), height: size * (1 + pad * 2))
        .opacity(0.95)
    }

    private func flame(at center: CGPoint, radius: CGFloat) -> Path {
        let height = radius * stretch
        return Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - height, width: radius * 2, height: height * 2))
    }

    private struct Particle {
        let center: CGPoint
        let radius: CGFloat
    }

    private func particles() -> [Particle] {
        var result: [Particle] = []
        result.reserveCapacity(count)
        let origin = size * pad
        for index in 0..<count {
            let seed = Double(index)
            let period = 0.8 + 0.5 * fract(seed * 0.731)
            let cycleTime = time / period + fract(seed * 0.377)
            let life = fract(cycleTime)
            let cycle = floor(cycleTime)
            // Evenly spread along the top half of the outline (left side → lid → right side),
            // with a small jitter that changes every time the particle is reborn
            let jitter = fract(seed * 0.618 + cycle * 0.29) - 0.5
            let theta = Double.pi * (seed + 0.5 + 0.7 * jitter) / Double(count)
            let startX = 0.5 + 0.44 * cos(theta)
            let startY = 0.53 - 0.33 * sin(theta)
            // Rises and leans outwards a little
            let rise = (0.13 + 0.1 * fract(seed * 0.913)) * life
            let lean = 0.05 * life * cos(theta)
            let wobble = 0.012 * sin(time * 6 + seed * 2.1)
            let x = startX + lean + wobble
            let y = startY - rise
            let radius = size * (0.02 + 0.045 * pow(1 - life, 0.7))
            result.append(Particle(
                center: CGPoint(x: origin + CGFloat(x) * size, y: origin + CGFloat(y) * size),
                radius: radius
            ))
        }
        return result
    }
}

/// Four-pointed sparkles that blink on and off around the chest.
private struct ChestSparkles: View {
    let time: Double
    let size: CGFloat
    let color: Color
    let count: Int

    private let pad: CGFloat = 0.3

    var body: some View {
        Canvas { context, _ in
            let origin = size * pad
            for index in 0..<count {
                let seed = Double(index)
                let period = 1.4 + 1.1 * fract(seed * 0.531)
                let cycleTime = time / period + fract(seed * 0.271)
                let life = fract(cycleTime)
                let cycle = floor(cycleTime)
                // A new spot around the outline each time it lights up
                let angle = 2 * Double.pi * fract(seed * 0.618 + cycle * 0.377)
                let x = 0.5 + 0.48 * cos(angle)
                let y = 0.5 + 0.36 * sin(angle)
                let strength = pow(sin(life * .pi), 2)
                guard strength > 0.02 else { continue }
                let radius = size * 0.075 * CGFloat(strength) * (0.7 + 0.3 * CGFloat(fract(seed * 0.83)))
                let center = CGPoint(x: origin + CGFloat(x) * size, y: origin + CGFloat(y) * size)
                context.fill(star(at: center, radius: radius * 1.6), with: .color(color.opacity(0.55 * strength)))
                context.fill(star(at: center, radius: radius), with: .color(.white.opacity(strength)))
            }
        }
        .frame(width: size * (1 + pad * 2), height: size * (1 + pad * 2))
        .blendMode(.plusLighter)
    }

    private func star(at center: CGPoint, radius: CGFloat) -> Path {
        let waist = radius * 0.22
        var path = Path()
        path.move(to: CGPoint(x: center.x, y: center.y - radius))
        path.addLine(to: CGPoint(x: center.x + waist, y: center.y - waist))
        path.addLine(to: CGPoint(x: center.x + radius, y: center.y))
        path.addLine(to: CGPoint(x: center.x + waist, y: center.y + waist))
        path.addLine(to: CGPoint(x: center.x, y: center.y + radius))
        path.addLine(to: CGPoint(x: center.x - waist, y: center.y + waist))
        path.addLine(to: CGPoint(x: center.x - radius, y: center.y))
        path.addLine(to: CGPoint(x: center.x - waist, y: center.y - waist))
        path.closeSubpath()
        return path
    }
}

#Preview("Cofres") {
    VStack(spacing: 40) {
        ForEach([38, 64, 100], id: \.self) { size in
            HStack(spacing: 28) {
                ForEach(["common", "rare", "epic", "legendary"], id: \.self) { rarity in
                    ChestView(rarity: rarity, size: CGFloat(size))
                }
            }
        }
    }
    .padding(40)
    .background(Color.canvas)
}
