import SwiftUI
import Charts

/// Km splits with a bar per km (faster = longer), fastest km highlighted.
struct RouteSplitsSection: View {
    let splits: [RouteAnalysis.Split]

    private var fastest: Double { splits.filter { $0.length >= 1 }.map(\.pace).min() ?? splits.map(\.pace).min() ?? 0 }
    private var slowest: Double { splits.map(\.pace).max() ?? 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Parciales")
            VStack(spacing: DS.Spacing.s) {
                ForEach(splits) { split in
                    row(split)
                }
            }
            .card()
        }
    }

    private func row(_ split: RouteAnalysis.Split) -> some View {
        let isFastest = split.length >= 1 && split.pace == fastest && splits.count > 1
        return HStack(spacing: DS.Spacing.m) {
            Text(split.length >= 1 ? "\(split.km)" : Format.distance(split.length * 1000))
                .font(.subheadline.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(width: 52, alignment: .leading)
            GeometryReader { proxy in
                Capsule()
                    .fill(isFastest ? Color.brand : Color.brand.opacity(0.35))
                    .frame(width: max(8, proxy.size.width * barFraction(split.pace)))
                    .frame(maxHeight: .infinity, alignment: .center)
            }
            .frame(height: 8)
            Text(RouteAnalysis.paceText(split.pace))
                .font(.subheadline.weight(isFastest ? .semibold : .regular))
                .monospacedDigit()
                .frame(width: 48, alignment: .trailing)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Kilómetro \(split.km), \(RouteAnalysis.paceText(split.pace)) por kilómetro")
    }

    /// Fastest split fills the bar; the slowest gets 35 %.
    private func barFraction(_ pace: Double) -> CGFloat {
        guard slowest > fastest else { return 1 }
        let t = (pace - fastest) / (slowest - fastest)
        return CGFloat(1 - 0.65 * min(max(t, 0), 1))
    }
}

/// Pace along the run (faster higher up).
struct RoutePaceChart: View {
    let samples: [RouteAnalysis.Sample]
    let averagePace: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Ritmo")
            Chart {
                ForEach(samples) { sample in
                    LineMark(x: .value("Km", sample.km), y: .value("Ritmo", sample.value))
                        .interpolationMethod(.monotone)
                        .foregroundStyle(Color.brand)
                }
                if let averagePace {
                    RuleMark(y: .value("Medio", averagePace))
                        .foregroundStyle(Color.secondary.opacity(0.6))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                }
            }
            .chartYScale(domain: .automatic(includesZero: false, reversed: true))
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let pace = value.as(Double.self) {
                            Text(RouteAnalysis.paceText(pace))
                        }
                    }
                }
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 5)) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let km = value.as(Double.self) {
                            Text("\(km.formatted(.number.precision(.fractionLength(0...1)))) km")
                        }
                    }
                }
            }
            .frame(height: 170)
            .card()
            .accessibilityLabel("Gráfica de ritmo")
        }
    }
}

/// Altitude profile with the metres climbed.
struct RouteElevationChart: View {
    let samples: [RouteAnalysis.Sample]
    let gain: Double

    private var range: ClosedRange<Double> {
        let values = samples.map(\.value)
        let low = values.min() ?? 0
        let high = values.max() ?? 1
        // At least 20 m of range so a flat run looks flat
        let padding = max(5, (20 - (high - low)) / 2)
        return (low - padding)...(high + padding)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            HStack(alignment: .firstTextBaseline) {
                SectionHeader(title: "Altitud")
                Spacer()
                Text("+\(Int(gain.rounded())) m de desnivel")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Chart(samples) { sample in
                AreaMark(
                    x: .value("Km", sample.km),
                    yStart: .value("Base", range.lowerBound),
                    yEnd: .value("Altitud", sample.value)
                )
                .interpolationMethod(.monotone)
                .foregroundStyle(Color.secondary.opacity(0.18))
                LineMark(x: .value("Km", sample.km), y: .value("Altitud", sample.value))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(Color.secondary)
            }
            .chartYScale(domain: range)
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let meters = value.as(Double.self) {
                            Text("\(Int(meters.rounded())) m")
                        }
                    }
                }
            }
            .frame(height: 130)
            .card()
            .accessibilityLabel("Perfil de altitud, \(Int(gain.rounded())) metros de desnivel positivo")
        }
    }
}
