import SwiftUI

/// The KM2 logo: "KM" and a green "2". `superscript` turns the 2 into a superscript — KM², square
/// kilometres, the territory you conquer — and can be animated (the launch intro does it).
/// Optionally with the "KAEMEDOS" tagline below.
struct KM2Logo: View {
    /// Font size of the letters.
    var size: CGFloat
    /// 0: KM2 · 1: KM²
    var superscript: CGFloat = 1
    /// White letters and neon 2 (on black); otherwise primary letters and the adaptive brand green.
    var onDark = false
    var tagline = false

    /// How much the 2 shrinks as a superscript, and roughly how wide it is (SF Pro Black digits).
    private let shrink: CGFloat = 0.52
    private let digitWidth: CGFloat = 0.64

    var body: some View {
        VStack(spacing: size * 0.24) {
            HStack(alignment: .top, spacing: size * 0.03) {
                Text("KM")
                    .foregroundStyle(onDark ? Color.white : Color.primary)
                Text("2")
                    .foregroundStyle(onDark ? Color.brandNeon : Color.brand)
                    // Shrinks towards its top left corner: it stays up by the top of the M
                    .scaleEffect(1 - shrink * superscript, anchor: .topLeading)
                    .offset(y: -size * 0.04 * superscript)
                    // Gives back the room it no longer takes, so the logo stays centred
                    .padding(.trailing, -size * digitWidth * shrink * superscript)
            }
            .font(.system(size: size, weight: .black))
            .tracking(-size * 0.035)
            .fixedSize()

            if tagline {
                Text("KAEMEDOS")
                    .font(.system(size: size * 0.135, weight: .bold))
                    .tracking(size * 0.07)
                    .foregroundStyle(onDark ? Color.white : Color.primary)
                    .fixedSize()
            }
        }
        .accessibilityElement(children: .ignore)
        // Written KM2, said "Kaemedos"
        .accessibilityLabel("Kaemedos")
    }
}

/// Launch intro, on black (like the launch screen): KM2 appears, then the 2 jumps up into KM².
/// Tap to skip; with Reduce Motion it just shows KM² for a moment.
struct KM2IntroView: View {
    let onFinished: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var superscript: CGFloat = 0
    @State private var shown = false
    @State private var done = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            KM2Logo(size: 96, superscript: superscript, onDark: true, tagline: true)
                .scaleEffect(shown ? 1 : 0.94)
                .opacity(shown ? 1 : 0)
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: finish)
        .statusBarHidden()
        .task { await play() }
    }

    private func play() async {
        if reduceMotion {
            superscript = 1
            withAnimation(.easeOut(duration: 0.25)) { shown = true }
            try? await Task.sleep(nanoseconds: 800_000_000)
            finish()
            return
        }
        withAnimation(.easeOut(duration: 0.35)) { shown = true }
        try? await Task.sleep(nanoseconds: 750_000_000)
        withAnimation(.spring(response: 0.42, dampingFraction: 0.6)) { superscript = 1 }
        try? await Task.sleep(nanoseconds: 180_000_000)
        UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.8)
        try? await Task.sleep(nanoseconds: 850_000_000)
        finish()
    }

    private func finish() {
        guard !done else { return }
        done = true
        onFinished()
    }
}

#Preview("Logo") {
    VStack(spacing: 40) {
        KM2Logo(size: 96, superscript: 0, onDark: true, tagline: true)
        KM2Logo(size: 96, onDark: true, tagline: true)
        KM2Logo(size: 44)
            .padding()
            .background(Color.white)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.black)
}

#Preview("Intro") {
    KM2IntroView {}
}
