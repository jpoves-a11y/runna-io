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
                            .frame(width: size * 1.3, height: size * 1.5)
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

/// The light coming out of the open chest: the opening glows and pulses, a soft column of light rises
/// from its exact shape (in perspective), rays flicker inside it and motes of light drift up. All
/// added as light. Drawn in a frame 1.3× as wide and 1.5× as tall as the icon, sharing its bottom
/// edge (the light rises above the chest).
private struct PowerLight: View {
    let time: Double
    let size: CGFloat

    /// Corners of the chest's opening in the cropped render (0...1 from the top left): front left,
    /// front right, back right, back left. Exported by scripts/power-icons (crop.py).
    static let opening = [
        CGPoint(x: 0.126, y: 0.573),
        CGPoint(x: 0.597, y: 0.707),
        CGPoint(x: 0.764, y: 0.574),
        CGPoint(x: 0.314, y: 0.459),
    ]

    var body: some View {
        Canvas { context, canvas in
            let origin = CGPoint(x: (canvas.width - size) / 2, y: canvas.height - size)
            let corners = Self.opening.map { CGPoint(x: origin.x + $0.x * size, y: origin.y + $0.y * size) }
            /// A point inside the opening: u across (left to right), w in depth (front to back).
            func inside(_ u: CGFloat, _ w: CGFloat) -> CGPoint {
                let front = lerp(corners[0], corners[1], u)
                let back = lerp(corners[3], corners[2], u)
                return lerp(front, back, w)
            }
            let center = inside(0.5, 0.5)
            let rise = size * 0.82
            let pulse = 0.8 + 0.12 * sin(time * 3.1) + 0.08 * sin(time * 7.7)

            context.blendMode = .plusLighter

            // 1. The opening itself glows
            var mouth = Path()
            mouth.addLines(corners)
            mouth.closeSubpath()
            context.drawLayer { layer in
                layer.addFilter(.blur(radius: size * 0.05))
                layer.fill(mouth, with: .color(Color.brandNeon.opacity(0.35 * pulse)))
            }

            // 2. A column of light rising from the opening's outline, widening a little and fading
            func up(_ point: CGPoint, spread: CGFloat) -> CGPoint {
                CGPoint(x: center.x + (point.x - center.x) * spread, y: point.y - rise)
            }
            var column = Path()
            column.move(to: corners[0])
            column.addLine(to: corners[1])
            column.addLine(to: corners[2])
            column.addLine(to: up(corners[2], spread: 1.25))
            column.addLine(to: up(corners[3], spread: 1.25))
            column.addLine(to: up(corners[0], spread: 1.25))
            column.closeSubpath()
            context.drawLayer { layer in
                layer.addFilter(.blur(radius: size * 0.06))
                layer.fill(column, with: .linearGradient(
                    Gradient(stops: [
                        .init(color: Color.brandNeon.opacity(0.55 * pulse), location: 0),
                        .init(color: Color.brandNeon.opacity(0.22 * pulse), location: 0.45),
                        .init(color: Color.brandNeon.opacity(0), location: 1),
                    ]),
                    startPoint: CGPoint(x: center.x, y: center.y),
                    endPoint: CGPoint(x: center.x, y: center.y - rise * 1.05)
                ))
            }

            // 3. Rays flickering inside the column
            context.drawLayer { layer in
                layer.addFilter(.blur(radius: size * 0.015))
                for index in 0..<5 {
                    let seed = Double(index)
                    let base = inside(0.15 + 0.7 * CGFloat(fract(seed * 0.618 + 0.1)), 0.25 + 0.5 * CGFloat(fract(seed * 0.37)))
                    let flicker = 0.5 + 0.5 * sin(time * (2.2 + seed * 0.7) + seed * 2.1)
                    let length = rise * (0.55 + 0.35 * CGFloat(flicker))
                    let width = size * (0.025 + 0.015 * CGFloat(fract(seed * 0.53)))
                    let ray = Path(roundedRect: CGRect(x: base.x - width / 2, y: base.y - length, width: width, height: length), cornerRadius: width / 2)
                    layer.fill(ray, with: .linearGradient(
                        Gradient(colors: [Color.white.opacity(0.45 * flicker), Color.brandNeon.opacity(0)]),
                        startPoint: CGPoint(x: base.x, y: base.y),
                        endPoint: CGPoint(x: base.x, y: base.y - length)
                    ))
                }
            }

            // 4. Motes born inside the opening, drifting up and fading
            for index in 0..<9 {
                let seed = Double(index)
                let period = 1.4 + 0.9 * fract(seed * 0.618)
                let cycle = time / period + fract(seed * 0.37)
                let life = fract(cycle)
                let round = floor(cycle)
                let start = inside(0.1 + 0.8 * CGFloat(fract(seed * 0.43 + round * 0.29)), 0.15 + 0.7 * CGFloat(fract(seed * 0.71 + round * 0.53)))
                let x = start.x + CGFloat(sin(time * 2.4 + seed * 1.9)) * size * 0.04 * CGFloat(life)
                let y = start.y - CGFloat(life) * rise * 1.05
                let alpha = min(1, life / 0.12) * pow(1 - life, 1.3)
                let radius = size * (0.022 + 0.018 * CGFloat(fract(seed * 0.91))) * CGFloat(1 - life * 0.5)
                let color = index % 3 == 0 ? Color(red: 1, green: 0.85, blue: 0.4) : Color.brandNeon
                let halo = radius * 3.2
                context.fill(
                    Path(ellipseIn: CGRect(x: x - halo, y: y - halo, width: halo * 2, height: halo * 2)),
                    with: .radialGradient(Gradient(colors: [color.opacity(0.5 * alpha), color.opacity(0)]),
                                          center: CGPoint(x: x, y: y), startRadius: 0, endRadius: halo)
                )
                context.fill(
                    Path(ellipseIn: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2)),
                    with: .color(Color.white.opacity(0.95 * alpha))
                )
            }
        }
    }

    private func lerp(_ a: CGPoint, _ b: CGPoint, _ t: CGFloat) -> CGPoint {
        CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
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
