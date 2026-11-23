import SwiftUI

/// A small burst of confetti, fired each time `trigger` changes (moving up a place, a better chest).
struct ConfettiBurst: View {
    let trigger: Int
    var colors: [Color] = [.brand, .gold]
    var pieces = 16

    @State private var progress: CGFloat = 0
    @State private var visible = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                if visible {
                    ForEach(0..<pieces, id: \.self) { index in
                        piece(index)
                    }
                }
            }
            .position(x: proxy.size.width / 2, y: proxy.size.height * 0.35)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onChange(of: trigger) { _, _ in
            guard !reduceMotion else { return }
            progress = 0
            visible = true
            withAnimation(.easeOut(duration: 0.9)) {
                progress = 1
            } completion: {
                visible = false
            }
        }
    }

    private func piece(_ index: Int) -> some View {
        let angle = Double(index) / Double(pieces) * 2 * .pi
        let distance = 70 + CGFloat((index * 37) % 60)
        return Capsule()
            .fill(colors[index % max(colors.count, 1)])
            .frame(width: 5, height: 11)
            .rotationEffect(.degrees(Double(index * 47) + Double(progress) * 300))
            .offset(
                x: CGFloat(cos(angle)) * distance * progress,
                y: CGFloat(sin(angle)) * distance * progress + 90 * progress * progress
            )
            .opacity(1 - Double(progress) * 0.85)
    }
}
