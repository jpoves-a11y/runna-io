import SwiftUI

/// The route's altitude profile, filled in the runner's colour up to where they are, with the
/// altitude there and the climb so far. Sizes scale with `unit` (the video's overlay is laid out 360
/// points wide).
struct ReplayElevationStrip: View {
    let points: [ReplayElevationPoint]
    /// 0...1 of the route run so far
    let fraction: Double
    let color: Color
    var unit: CGFloat = 1

    var body: some View {
        let profile = ElevationProfile(points: points)
        let km = profile.totalKm * min(1, max(0, fraction))
        HStack(spacing: 10 * unit) {
            VStack(alignment: .leading, spacing: 1 * unit) {
                Text("\(Int(profile.altitude(atKm: km).rounded())) m")
                    .font(.system(size: 13 * unit, weight: .bold).width(.condensed))
                    .monospacedDigit()
                Text("↑ \(Int(profile.gain(upToKm: km).rounded())) m")
                    .font(.system(size: 10 * unit, weight: .semibold))
                    .monospacedDigit()
                    .opacity(0.8)
            }
            .fixedSize()
            GeometryReader { geometry in
                let shape = ElevationShape(profile: profile)
                ZStack(alignment: .leading) {
                    shape.fill(Color.white.opacity(0.18))
                    shape.fill(color)
                        .mask(alignment: .leading) {
                            Rectangle().frame(width: geometry.size.width * min(1, max(0, fraction)))
                        }
                    // Where the runner is
                    Circle()
                        .fill(Color.white)
                        .frame(width: 6 * unit, height: 6 * unit)
                        .position(
                            x: geometry.size.width * min(1, max(0, fraction)),
                            y: geometry.size.height * (1 - profile.height(atKm: km))
                        )
                }
            }
        }
        .padding(.horizontal, 10 * unit)
        .padding(.vertical, 6 * unit)
        .frame(height: 40 * unit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Altitud")
        .accessibilityValue("\(Int(profile.altitude(atKm: km).rounded())) metros, \(Int(profile.gain(upToKm: km).rounded())) metros de subida")
    }
}

/// The profile's points normalised for drawing: x in km, y as 0...1 of the altitude range (with a
/// little room so a flat route isn't a line on the floor).
private struct ElevationProfile {
    let kms: [Double]
    let metres: [Double]
    let minimum: Double
    let range: Double

    init(points: [ReplayElevationPoint]) {
        let sorted = points.sorted { $0.km < $1.km }
        kms = sorted.map(\.km)
        metres = sorted.map(\.metres)
        let low = metres.min() ?? 0
        let high = metres.max() ?? 0
        // At least 30 m of range: gentle routes look gentle
        range = max(30, high - low)
        minimum = low - (range - (high - low)) / 2
    }

    var totalKm: Double { max(0.001, kms.last ?? 0) }

    func altitude(atKm km: Double) -> Double {
        guard let first = kms.first else { return 0 }
        if km <= first { return metres[0] }
        guard let index = kms.firstIndex(where: { $0 >= km }) else { return metres.last ?? 0 }
        let span = kms[index] - kms[index - 1]
        let f = span > 0 ? (km - kms[index - 1]) / span : 0
        return metres[index - 1] + (metres[index] - metres[index - 1]) * f
    }

    /// 0...1 of the drawing's height (a 10% margin at the bottom and top).
    func height(atKm km: Double) -> Double {
        0.1 + 0.8 * (altitude(atKm: km) - minimum) / range
    }

    /// Metres climbed up to `km` (rises of at least a metre, so GPS noise doesn't add up).
    func gain(upToKm km: Double) -> Double {
        var gain = 0.0
        var base = metres.first ?? 0
        for (index, value) in metres.enumerated() where kms[index] <= km {
            if value - base >= 1 {
                gain += value - base
                base = value
            } else if value < base {
                base = value
            }
        }
        return gain
    }
}

private struct ElevationShape: Shape {
    let profile: ElevationProfile

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard profile.kms.count >= 2 else { return path }
        path.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        for (index, km) in profile.kms.enumerated() {
            let x = rect.minX + rect.width * CGFloat(km / profile.totalKm)
            let y = rect.maxY - rect.height * CGFloat(profile.height(atKm: profile.kms[index]))
            path.addLine(to: CGPoint(x: x, y: y))
        }
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}
