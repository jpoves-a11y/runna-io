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
/// "powers_icon"; the chest outline if it's missing). Just the chest, no circle behind: `glow`
/// (powers waiting to be used) makes the chest itself glow green and breathe.
struct PowersIcon: View {
    var size: CGFloat = 20
    var glow: Bool = false
    /// Only for the outline fallback.
    var lineWidth: CGFloat? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathe = false

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
