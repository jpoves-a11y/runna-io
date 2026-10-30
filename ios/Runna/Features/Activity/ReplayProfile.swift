import SwiftUI
import CoreLocation

/// The run's altitude spread evenly over its distance, for the replay's profile.
struct ReplayProfile {
    /// Altitude (metres) at evenly spaced fractions of the distance; nil without altitude data.
    let heights: [Double]?
    let low: Double
    let high: Double

    private static let samples = 120

    init(coordinates: [CLLocationCoordinate2D], altitudes: [Double?]?) {
        guard let altitudes, altitudes.count == coordinates.count, coordinates.count >= 2 else {
            heights = nil; low = 0; high = 1
            return
        }
        // Distance covered at each point
        var distances = [0.0]
        for index in 1..<coordinates.count {
            let a = CLLocation(latitude: coordinates[index - 1].latitude, longitude: coordinates[index - 1].longitude)
            let b = CLLocation(latitude: coordinates[index].latitude, longitude: coordinates[index].longitude)
            distances.append(distances[index - 1] + b.distance(from: a))
        }
        let known: [(distance: Double, altitude: Double)] = altitudes.indices.compactMap { index in
            altitudes[index].map { (distance: distances[index], altitude: $0) }
        }
        guard known.count >= 3, let total = distances.last, total > 0 else {
            heights = nil; low = 0; high = 1
            return
        }
        // Sampled evenly by distance (linear between known points), then smoothed
        var raw: [Double] = []
        var cursor = 0
        for step in 0..<Self.samples {
            let target = total * Double(step) / Double(Self.samples - 1)
            while cursor < known.count - 2 && known[cursor + 1].distance < target { cursor += 1 }
            let a = known[cursor]
            let b = known[min(cursor + 1, known.count - 1)]
            let span = b.distance - a.distance
            let t = span > 0 ? min(max((target - a.distance) / span, 0), 1) : 0
            raw.append(a.altitude + (b.altitude - a.altitude) * t)
        }
        let smoothed = raw.indices.map { index -> Double in
            let slice = raw[max(0, index - 3)...min(raw.count - 1, index + 3)]
            return slice.reduce(0, +) / Double(slice.count)
        }
        let minimum = smoothed.min() ?? 0
        let maximum = smoothed.max() ?? 1
        // At least 30 m of range so a flat run looks flat
        let padding = max(0, (30 - (maximum - minimum)) / 2)
        heights = smoothed
        low = minimum - padding
        high = maximum + padding
    }

    /// Altitude at a fraction of the distance.
    func altitude(at fraction: Double) -> Double? {
        guard let heights, heights.count >= 2 else { return nil }
        let position = min(max(fraction, 0), 1) * Double(heights.count - 1)
        let index = min(Int(position), heights.count - 2)
        let t = position - Double(index)
        return heights[index] + (heights[index + 1] - heights[index]) * t
    }

    /// 0 (bottom) ... 1 (top) of the chart.
    func level(at fraction: Double) -> Double {
        guard let altitude = altitude(at: fraction), high > low else { return 0 }
        return (altitude - low) / (high - low)
    }
}

/// Bottom of the replay: distance covered over a km ruler, with the elevation profile when the run
/// has altitude. Translucent so the map shows through.
struct ReplayProfileCard<Trailing: View>: View {
    let profile: ReplayProfile
    let progress: Double
    let totalDistance: Double
    let color: Color
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .lastTextBaseline, spacing: 14) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("DISTANCIA")
                        .font(.system(size: 9, weight: .semibold))
                        .tracking(1.6)
                        .opacity(0.55)
                    Text(Format.distance(totalDistance * progress))
                        .font(Font.stat(22, weight: .semibold))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                }
                if let altitude = profile.altitude(at: progress) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("ALTITUD")
                            .font(.system(size: 9, weight: .semibold))
                            .tracking(1.6)
                            .opacity(0.55)
                        Text("\(Int(altitude.rounded())) m")
                            .font(Font.stat(22, weight: .semibold))
                            .monospacedDigit()
                    }
                }
                Spacer(minLength: 0)
                trailing()
            }
            chart
                .frame(height: profile.heights == nil ? 26 : 62)
        }
        .foregroundStyle(Color.white)
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .background(Color.black.opacity(0.28), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5))
        .environment(\.colorScheme, .dark)
    }

    private var chart: some View {
        Canvas { context, size in
            let labelHeight: CGFloat = 13
            let plotHeight = size.height - labelHeight - 4
            let baseline = plotHeight
            let x = size.width * progress
            let line = Color.white

            func y(_ fraction: Double) -> CGFloat {
                baseline - CGFloat(profile.level(at: fraction)) * (plotHeight - 6) - 2
            }

            if let heights = profile.heights {
                // Elevation: the whole run faint, the stretch covered in the run's colour
                var outline = Path()
                for index in heights.indices {
                    let fraction = Double(index) / Double(heights.count - 1)
                    let point = CGPoint(x: size.width * fraction, y: y(fraction))
                    if index == 0 { outline.move(to: point) } else { outline.addLine(to: point) }
                }
                var area = outline
                area.addLine(to: CGPoint(x: size.width, y: baseline))
                area.addLine(to: CGPoint(x: 0, y: baseline))
                area.closeSubpath()
                context.fill(area, with: .color(line.opacity(0.1)))
                context.stroke(outline, with: .color(line.opacity(0.32)), style: StrokeStyle(lineWidth: 1.2, lineJoin: .round))

                var covered = context
                covered.clip(to: Path(CGRect(x: 0, y: 0, width: x, height: baseline + 1)))
                covered.fill(area, with: .linearGradient(
                    Gradient(colors: [color.opacity(0.6), color.opacity(0.08)]),
                    startPoint: CGPoint(x: 0, y: 0), endPoint: CGPoint(x: 0, y: baseline)
                ))
                covered.stroke(outline, with: .color(color), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }

            // Ruler: baseline, km ticks and labels
            var rule = Path()
            rule.move(to: CGPoint(x: 0, y: baseline))
            rule.addLine(to: CGPoint(x: size.width, y: baseline))
            context.stroke(rule, with: .color(line.opacity(0.28)), lineWidth: 1)
            var done = Path()
            done.move(to: CGPoint(x: 0, y: baseline))
            done.addLine(to: CGPoint(x: x, y: baseline))
            context.stroke(done, with: .color(color), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))

            let km = totalDistance / 1000
            if km > 0 {
                let step = Self.step(for: km)
                let minor = step / 4
                var mark = 0.0
                while mark <= km + 0.0001 {
                    let fraction = mark / km
                    let tickX = size.width * fraction
                    let isMajor = abs((mark / step).rounded() - mark / step) < 0.001
                    var tick = Path()
                    tick.move(to: CGPoint(x: tickX, y: baseline))
                    tick.addLine(to: CGPoint(x: tickX, y: baseline + (isMajor ? 5 : 2.5)))
                    context.stroke(tick, with: .color(line.opacity(isMajor ? 0.55 : 0.25)), lineWidth: 1)
                    // Labels on major ticks, leaving room for the total at the end
                    if isMajor && tickX < size.width - 30 {
                        let text = Text(Self.label(mark))
                            .font(.system(size: 9, weight: .medium).monospacedDigit())
                            .foregroundColor(line.opacity(0.55))
                        context.draw(text, at: CGPoint(x: max(tickX, 4), y: size.height), anchor: mark == 0 ? .bottomLeading : .bottom)
                    }
                    mark += minor
                }
                let end = Text("\(Self.label(km)) km")
                    .font(.system(size: 9, weight: .semibold).monospacedDigit())
                    .foregroundColor(line.opacity(0.75))
                context.draw(end, at: CGPoint(x: size.width, y: size.height), anchor: .bottomTrailing)
            }

            // Where the runner is
            let markerY = profile.heights == nil ? baseline : y(progress)
            var cursor = Path()
            cursor.move(to: CGPoint(x: x, y: 0))
            cursor.addLine(to: CGPoint(x: x, y: baseline))
            context.stroke(cursor, with: .color(line.opacity(0.35)), style: StrokeStyle(lineWidth: 1, dash: [2, 3]))
            let dot = CGRect(x: x - 5, y: markerY - 5, width: 10, height: 10)
            context.fill(Path(ellipseIn: dot), with: .color(color))
            context.stroke(Path(ellipseIn: dot), with: .color(.white), lineWidth: 2)
        }
    }

    /// Distance between labelled ticks: at most ~6 labels.
    static func step(for km: Double) -> Double {
        for step in [0.5, 1, 2, 5, 10, 20, 50] where km / step <= 6 { return step }
        return 100
    }

    static func label(_ km: Double) -> String {
        km.rounded() == km || km >= 10 ? "\(Int(km.rounded()))" : String(format: "%.1f", km).replacingOccurrences(of: ".", with: ",")
    }
}
