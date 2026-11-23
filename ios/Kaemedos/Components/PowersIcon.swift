import SwiftUI

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

/// The Poderes icon: a chest outline in the current foreground colour. `glow` adds a soft golden
/// light behind it and a small sparkle (there are powers waiting to be used).
struct PowersIcon: View {
    var size: CGFloat = 20
    var glow: Bool = false
    var lineWidth: CGFloat? = nil

    var body: some View {
        ZStack {
            if glow {
                Circle()
                    .fill(Color.gold)
                    .frame(width: size * 1.1, height: size * 1.1)
                    .blur(radius: size * 0.35)
                    .opacity(0.45)
            }
            ChestOutline()
                .stroke(style: StrokeStyle(lineWidth: lineWidth ?? max(1.4, size / 13), lineCap: .round, lineJoin: .round))
                .frame(width: size, height: size * 0.86)
            ChestLock()
                .frame(width: size, height: size * 0.86)
            if glow {
                Image(systemName: "sparkle")
                    .font(.system(size: size * 0.38, weight: .bold))
                    .foregroundStyle(Color.gold)
                    .offset(x: size * 0.52, y: -size * 0.5)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
