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

/// The Poderes icon: a potion flask of glowing KM2-green liquid (3D render, asset "powers_icon";
/// the chest outline if it's missing). `glow` (powers waiting to be used) adds a green light that
/// breathes behind it and a small sparkle.
struct PowersIcon: View {
    var size: CGFloat = 20
    var glow: Bool = false
    /// Only for the outline fallback.
    var lineWidth: CGFloat? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathe = false

    var body: some View {
        ZStack {
            if glow {
                Circle()
                    .fill(RadialGradient(
                        colors: [Color.brandNeon.opacity(0.55), Color.brandNeon.opacity(0)],
                        center: .center, startRadius: 0, endRadius: size * 0.8
                    ))
                    .frame(width: size * 1.6, height: size * 1.6)
                    .scaleEffect(breathe ? 1.08 : 0.85)
                    .opacity(breathe ? 1 : 0.65)
            }
            if let image = UIImage(named: "powers_icon") {
                Image(uiImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .frame(width: size * 1.15, height: size * 1.15)
                    .shadow(color: .black.opacity(0.3), radius: size * 0.06, y: size * 0.04)
            } else {
                ChestOutline()
                    .stroke(style: StrokeStyle(lineWidth: lineWidth ?? max(1.4, size / 13), lineCap: .round, lineJoin: .round))
                    .frame(width: size, height: size * 0.86)
                ChestLock()
                    .frame(width: size, height: size * 0.86)
            }
            if glow {
                Image(systemName: "sparkle")
                    .font(.system(size: size * 0.36, weight: .bold))
                    .foregroundStyle(Color.gold)
                    .offset(x: size * 0.5, y: -size * 0.48)
                    .opacity(breathe ? 1 : 0.4)
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
