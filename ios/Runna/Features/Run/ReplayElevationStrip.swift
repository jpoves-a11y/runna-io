import SwiftUI

/// The route's altitude profile, clean and quiet. The altitude where the runner is shows large, the
/// climb so far below it. Beside them, a smoothed curve: drawn in the runner's colour up to where they
/// are, with a soft fill under it, and thin and faint beyond. A marker on the curve shows where they
/// are. Colours follow the foreground style (white over the video, the app's primary on its glass).
/// Sizes scale with `unit` (the video's overlay is laid out 360 points wide).
struct ReplayElevationStrip: View {
    let points: [ReplayElevationPoint]
    /// 0...1 of the route run so far
    let fraction: Double
    let color: Color
    var unit: CGFloat = 1

    var body: some View {
        let profile = ElevationProfile(points: points)
        let done = min(1, max(0, fraction))
        let km = profile.totalKm * done
        let altitude = Int(profile.altitude(atKm: km).rounded())
        let gain = Int(profile.gain(upToKm: km).rounded())
        HStack(alignment: .center, spacing: 12 * unit) {
            VStack(alignment: .leading, spacing: 1 * unit) {
                HStack(alignment: .firstTextBaseline, spacing: 2 * unit) {
                    Text("\(altitude)")
                        .font(.system(size: 17 * unit, weight: .semibold))
                        .monospacedDigit()
                    Text("m")
                        .font(.system(size: 10 * unit, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 2.5 * unit) {
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 7.5 * unit, weight: .bold))
                    Text("\(gain) m")
                        .font(.system(size: 10 * unit, weight: .medium))
                        .monospacedDigit()
                }
                .foregroundStyle(.secondary)
            }
            .lineLimit(1)
            .fixedSize()
            .frame(minWidth: 46 * unit, alignment: .leading)
            ElevationChart(profile: profile, fraction: done, color: color, unit: unit)
        }
        .padding(.leading, 12 * unit)
        .padding(.trailing, 8 * unit)
        .padding(.vertical, 7 * unit)
        .frame(height: 48 * unit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Altitud")
        .accessibilityValue("\(altitude) metros, \(gain) metros de subida")
    }
}

/// The curve: the way run in the runner's colour over a fill that fades down, the way still to go
/// thin and faint, a hairline base, and the runner's marker with a fine line down to the base.
private struct ElevationChart: View {
    let profile: ElevationProfile
    let fraction: Double
    let color: Color
    let unit: CGFloat

    var body: some View {
        Canvas { context, size in
            // Room for the marker at the ends and the top
            let inset = 5 * unit
            let plot = CGRect(x: inset, y: 5 * unit, width: max(1, size.width - 2 * inset), height: max(1, size.height - 7 * unit))
            let line = profile.linePath(in: plot)
            let area = profile.areaPath(in: plot)
            let x = plot.minX + plot.width * fraction
            let y = plot.maxY - plot.height * profile.height(atKm: profile.totalKm * fraction)

            // The base
            var base = context
            base.opacity = 0.22
            base.stroke(
                Path { path in
                    path.move(to: CGPoint(x: plot.minX, y: plot.maxY))
                    path.addLine(to: CGPoint(x: plot.maxX, y: plot.maxY))
                },
                with: .foreground,
                lineWidth: max(0.5, 0.75 * unit)
            )

            // The way still to go
            var ahead = context
            ahead.clip(to: Path(CGRect(x: x, y: 0, width: max(0, size.width - x), height: size.height)))
            ahead.opacity = 0.08
            ahead.fill(area, with: .foreground)
            ahead.opacity = 0.42
            ahead.stroke(line, with: .foreground, style: StrokeStyle(lineWidth: 1.2 * unit, lineCap: .round, lineJoin: .round))

            // The way run
            var behind = context
            behind.clip(to: Path(CGRect(x: 0, y: 0, width: x, height: size.height)))
            behind.fill(
                area,
                with: .linearGradient(
                    Gradient(colors: [color.opacity(0.55), color.opacity(0.04)]),
                    startPoint: CGPoint(x: 0, y: plot.minY),
                    endPoint: CGPoint(x: 0, y: plot.maxY)
                )
            )
            behind.stroke(line, with: .color(color), style: StrokeStyle(lineWidth: 2 * unit, lineCap: .round, lineJoin: .round))

            // Where the runner is
            var marker = context
            marker.opacity = 0.55
            marker.stroke(
                Path { path in
                    path.move(to: CGPoint(x: x, y: y))
                    path.addLine(to: CGPoint(x: x, y: plot.maxY))
                },
                with: .color(color),
                lineWidth: max(0.5, 0.9 * unit)
            )
            let glow = 6.5 * unit
            context.fill(Path(ellipseIn: CGRect(x: x - glow, y: y - glow, width: glow * 2, height: glow * 2)), with: .color(color.opacity(0.25)))
            let dot = 3.4 * unit
            let disc = Path(ellipseIn: CGRect(x: x - dot, y: y - dot, width: dot * 2, height: dot * 2))
            context.fill(disc, with: .color(.white))
            context.stroke(disc, with: .color(color), lineWidth: 1.6 * unit)
        }
    }
}

/// The profile for drawing: the raw points for the figures (altitude, climb), and a smoothed curve of
/// evenly spaced samples (GPS altitude is noisy) normalised to 0...1 of the drawing's height, with
/// at least 30 m of range so a gentle route looks gentle.
private struct ElevationProfile {
    let kms: [Double]
    let metres: [Double]
    /// The smoothed curve: altitude at `totalKm * i / (count - 1)`
    let curve: [Double]
    let minimum: Double
    let range: Double

    private static let samples = 120

    init(points: [ReplayElevationPoint]) {
        let sorted = points.filter { $0.km.isFinite && $0.metres.isFinite }.sorted { $0.km < $1.km }
        let xs = sorted.map(\.km)
        let ys = sorted.map(\.metres)
        kms = xs
        metres = ys
        let total = max(0.001, xs.last ?? 0)
        guard !ys.isEmpty else {
            curve = []
            minimum = 0
            range = 30
            return
        }
        // Each sample the mean of the altitude around it (a sample's width), then a light second pass
        let count = Self.samples
        let step = total / Double(count - 1)
        var raw: [Double] = []
        raw.reserveCapacity(count)
        for index in 0..<count {
            let km = step * Double(index)
            var sum = 0.0
            for offset in -2...2 {
                sum += Self.interpolate(xs, ys, at: min(total, max(0, km + Double(offset) * step * 0.5)))
            }
            raw.append(sum / 5)
        }
        var smooth = raw
        for index in raw.indices {
            let low = max(0, index - 1)
            let high = min(raw.count - 1, index + 1)
            smooth[index] = raw[low...high].reduce(0, +) / Double(high - low + 1)
        }
        curve = smooth
        let low = smooth.min() ?? 0
        let high = smooth.max() ?? 0
        range = max(30, high - low)
        minimum = low - (range - (high - low)) / 2
    }

    var totalKm: Double { max(0.001, kms.last ?? 0) }

    /// The altitude at `km` from the raw points (between two, in proportion).
    func altitude(atKm km: Double) -> Double {
        Self.interpolate(kms, metres, at: km)
    }

    /// 0...1 of the drawing's height of the curve at `km` (an 8% margin at the bottom, 4% at the top).
    func height(atKm km: Double) -> Double {
        guard curve.count >= 2 else { return 0.5 }
        let position = min(1, max(0, km / totalKm)) * Double(curve.count - 1)
        let index = min(curve.count - 2, Int(position))
        let f = position - Double(index)
        let value = curve[index] + (curve[index + 1] - curve[index]) * f
        return 0.08 + 0.88 * (value - minimum) / range
    }

    /// Metres climbed up to `km` (rises of at least a metre, so GPS noise doesn't add up).
    func gain(upToKm km: Double) -> Double {
        var gain = 0.0
        var base = metres.first ?? 0
        for (index, value) in metres.enumerated() {
            guard kms[index] <= km else { break }
            if value - base >= 1 {
                gain += value - base
                base = value
            } else if value < base {
                base = value
            }
        }
        return gain
    }

    func linePath(in rect: CGRect) -> Path {
        var path = Path()
        guard curve.count >= 2 else { return path }
        path.move(to: point(0, in: rect))
        for index in 1..<curve.count {
            path.addLine(to: point(index, in: rect))
        }
        return path
    }

    func areaPath(in rect: CGRect) -> Path {
        var path = linePath(in: rect)
        guard curve.count >= 2 else { return path }
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }

    private func point(_ index: Int, in rect: CGRect) -> CGPoint {
        let f = Double(index) / Double(curve.count - 1)
        let value = 0.08 + 0.88 * (curve[index] - minimum) / range
        return CGPoint(x: rect.minX + rect.width * f, y: rect.maxY - rect.height * value)
    }

    /// The value at `x` between the sorted `xs` (binary search).
    private static func interpolate(_ xs: [Double], _ ys: [Double], at x: Double) -> Double {
        guard let first = xs.first, let last = xs.last else { return 0 }
        if x <= first { return ys[0] }
        if x >= last { return ys[ys.count - 1] }
        var low = 0
        var high = xs.count - 1
        while high - low > 1 {
            let middle = (low + high) / 2
            if xs[middle] <= x {
                low = middle
            } else {
                high = middle
            }
        }
        let span = xs[high] - xs[low]
        let f = span > 0 ? (x - xs[low]) / span : 0
        return ys[low] + (ys[high] - ys[low]) * f
    }
}
