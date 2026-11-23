import SwiftUI
import UIKit

/// Outline of a treasure chest: domed lid, body, the band between them and a lock.
struct ChestOutline: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width
        let h = rect.height
        let x = rect.minX
        let y = rect.minY
        var path = Path()
        let bandY = y + h * 0.42
        let radius = w * 0.1
        // Lid: a dome from left to right
        path.move(to: CGPoint(x: x + w * 0.04, y: bandY))
        path.addLine(to: CGPoint(x: x + w * 0.04, y: y + h * 0.3))
        path.addQuadCurve(to: CGPoint(x: x + w * 0.96, y: y + h * 0.3), control: CGPoint(x: x + w * 0.5, y: y - h * 0.06))
        path.addLine(to: CGPoint(x: x + w * 0.96, y: bandY))
        // Body
        path.addRoundedRect(
            in: CGRect(x: x + w * 0.04, y: bandY, width: w * 0.92, height: h * 0.54),
            cornerSize: CGSize(width: radius, height: radius),
            style: .continuous
        )
        // Straps on the lid
        path.move(to: CGPoint(x: x + w * 0.3, y: bandY))
        path.addLine(to: CGPoint(x: x + w * 0.3, y: y + h * 0.13))
        path.move(to: CGPoint(x: x + w * 0.7, y: bandY))
        path.addLine(to: CGPoint(x: x + w * 0.7, y: y + h * 0.13))
        return path
    }
}

/// Lock of the chest outline (filled).
private struct ChestLock: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width
        let h = rect.height
        let center = CGPoint(x: rect.midX, y: rect.minY + h * 0.52)
        let size = w * 0.13
        var path = Path()
        path.move(to: CGPoint(x: center.x, y: center.y - size))
        path.addLine(to: CGPoint(x: center.x + size * 0.8, y: center.y))
        path.addLine(to: CGPoint(x: center.x, y: center.y + size))
        path.addLine(to: CGPoint(x: center.x - size * 0.8, y: center.y))
        path.closeSubpath()
        return path
    }
}

/// The Poderes icon: an open treasure chest with green power pouring out (3D render, asset
/// "powers_icon"; the chest outline if it's missing). Just the chest, no circle behind.
///
/// `glow` (powers waiting to be used) brings it to life: the chest glows green along its outline
/// and breathes, a flickering beam of green light comes out of it and motes of light (green and
/// gold) drift up. With Reduce Motion it only glows.
struct PowersIcon: View {
    var size: CGFloat = 20
    var glow: Bool = false
    /// Only for the outline fallback.
    var lineWidth: CGFloat? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathe = false
    @State private var start = Date()

    var body: some View {
        Group {
            if let image = UIImage(named: "powers_icon") {
                Image(uiImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    // The glow follows the chest's own outline
                    .shadow(color: Color.brandNeon.opacity(glow ? (breathe ? 0.85 : 0.35) : 0), radius: size * 0.18)
                    .shadow(color: .black.opacity(0.28), radius: size * 0.05, y: size * 0.04)
                    .scaleEffect(glow && breathe ? 1.04 : 1)
                    .overlay(alignment: .bottom) {
                        if glow && !reduceMotion {
                            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                                PowerLight(time: context.date.timeIntervalSince(start), size: size)
                            }
                            // Taller than the icon: the light rises above it
                            .frame(width: size * 1.3, height: size * 1.55)
                            .allowsHitTesting(false)
                        }
                    }
            } else {
                ZStack {
                    ChestOutline()
                        .stroke(style: StrokeStyle(lineWidth: lineWidth ?? max(1.4, size / 13), lineCap: .round, lineJoin: .round))
                        .frame(width: size, height: size * 0.86)
                    ChestLock()
                        .frame(width: size, height: size * 0.86)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
        .onAppear { startBreathing() }
        .onChange(of: glow) { _, _ in startBreathing() }
    }

    private func startBreathing() {
        guard glow, !reduceMotion else {
            breathe = glow
            return
        }
        withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) { breathe = true }
    }
}

/// The light coming out of the open chest: a flickering beam and rising motes, added as light.
/// Drawn in a frame 1.3× as wide and 1.55× as tall as the icon, sharing its bottom edge.
private struct PowerLight: View {
    let time: Double
    let size: CGFloat

    var body: some View {
        Canvas { context, canvas in
            context.blendMode = .plusLighter
            let width = canvas.width
            let height = canvas.height
            // Where the chest's opening is in the (cropped) render: 43% across, 47% down
            let openingX = width / 2 - size * 0.07
            let openingY = height - size * 0.53
            let flicker = 0.75 + 0.15 * sin(time * 7.3) + 0.1 * sin(time * 12.1)

            // Beam: a trapezoid from the opening up, fading to nothing
            var beam = Path()
            let baseHalf = size * 0.26
            let topHalf = size * 0.4
            let top = openingY - size * 0.8
            beam.move(to: CGPoint(x: openingX - baseHalf, y: openingY))
            beam.addLine(to: CGPoint(x: openingX + baseHalf, y: openingY))
            beam.addLine(to: CGPoint(x: openingX + topHalf, y: top))
            beam.addLine(to: CGPoint(x: openingX - topHalf, y: top))
            beam.closeSubpath()
            context.fill(beam, with: .linearGradient(
                Gradient(colors: [Color.brandNeon.opacity(0.5 * flicker), Color.brandNeon.opacity(0)]),
                startPoint: CGPoint(x: openingX, y: openingY),
                endPoint: CGPoint(x: openingX, y: top)
            ))

            // Motes drifting up, each on its own loop
            for index in 0..<7 {
                let seed = Double(index)
                let period = 1.3 + 0.9 * fract(seed * 0.618)
                let cycle = time / period + fract(seed * 0.37)
                let life = fract(cycle)
                let startX = openingX + (CGFloat(fract(seed * 0.43 + floor(cycle) * 0.29)) - 0.5) * size * 0.44
                let x = startX + CGFloat(sin(time * 2.4 + seed * 1.9)) * size * 0.05 * CGFloat(life)
                let y = openingY - CGFloat(life) * size * 0.9
                let alpha = min(1, life / 0.15) * (1 - life)
                let radius = size * (0.035 + 0.025 * CGFloat(fract(seed * 0.71))) * CGFloat(1 - life * 0.4)
                let color = index % 3 == 0 ? Color(red: 1, green: 0.85, blue: 0.4) : Color.brandNeon
                let halo = radius * 3
                context.fill(
                    Path(ellipseIn: CGRect(x: x - halo, y: y - halo, width: halo * 2, height: halo * 2)),
                    with: .radialGradient(Gradient(colors: [color.opacity(0.45 * alpha), color.opacity(0)]),
                                          center: CGPoint(x: x, y: y), startRadius: 0, endRadius: halo)
                )
                context.fill(
                    Path(ellipseIn: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2)),
                    with: .color(Color.white.opacity(0.9 * alpha))
                )
            }
        }
    }

    private func fract(_ value: Double) -> Double { value - floor(value) }
}

/// Count of powers waiting, in the brand's neon green (on the Poderes button).
struct PowersCountBadge: View {
    let count: Int

    var body: some View {
        Text(count > 9 ? "9+" : "\(count)")
            .font(.system(size: 10, weight: .heavy, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(Color(red: 0.01, green: 0.1, blue: 0.02))
            .padding(.horizontal, 4)
            .frame(minWidth: 15, minHeight: 15)
            .background(Color.brandNeon, in: Capsule())
            .shadow(color: Color.brandNeon.opacity(0.6), radius: 4)
            .shadow(color: .black.opacity(0.35), radius: 1.5, y: 1)
            .accessibilityHidden(true)
    }
}
