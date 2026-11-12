import SwiftUI
import Charts

// MARK: - Model

/// GET /api/routes/:routeId/profile: what the activity screen draws (computed on the server).
struct ActivityProfile: Decodable {
    struct Sample: Decodable {
        /// km from the start
        let d: Double
        /// altitude (m)
        let e: Double?
        /// pace (s/km), nil while stopped
        let p: Double?
        /// grade (%)
        let g: Double?
    }

    struct Split: Decodable, Identifiable {
        let index: Int
        /// metres (1000 except the last one)
        let distance: Double
        /// moving seconds
        let duration: Double
        /// s/km
        let pace: Double
        let elevationGain: Double?
        let elevationLoss: Double?

        var id: Int { index }
    }

    struct Climb: Decodable {
        let startKm: Double
        let endKm: Double
        /// metres
        let length: Double
        let gain: Double
        let avgGrade: Double
        let maxGrade: Double
        let duration: Double?
        /// vertical metres per hour
        let vam: Double?
    }

    struct Stats: Decodable {
        let distance: Double?
        let movingTime: Double?
        let elapsedTime: Double?
        let avgPace: Double?
        let bestKmPace: Double?
        let bestKmStartKm: Double?
        let fastestSplit: Int?
        let slowestSplit: Int?
        let firstHalfPace: Double?
        let secondHalfPace: Double?
        let elevationGain: Double?
        let elevationLoss: Double?
        let minElevation: Double?
        let maxElevation: Double?
        let maxGrade: Double?
    }

    let available: Bool
    let hasPace: Bool
    let hasElevation: Bool
    let series: [Sample]
    let splits: [Split]
    let climbs: [Climb]
    let stats: Stats?

    enum CodingKeys: String, CodingKey {
        case available, hasPace, hasElevation, series, splits, climbs, stats
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = (try? c.decodeIfPresent(Bool.self, forKey: .available)) ?? false
        hasPace = (try? c.decodeIfPresent(Bool.self, forKey: .hasPace)) ?? false
        hasElevation = (try? c.decodeIfPresent(Bool.self, forKey: .hasElevation)) ?? false
        series = (try? c.decodeIfPresent([Sample].self, forKey: .series)) ?? []
        splits = (try? c.decodeIfPresent([Split].self, forKey: .splits)) ?? []
        climbs = (try? c.decodeIfPresent([Climb].self, forKey: .climbs)) ?? []
        stats = try? c.decodeIfPresent(Stats.self, forKey: .stats)
    }

    /// Something worth drawing.
    var hasCharts: Bool { available && (hasPace || hasElevation) && series.count >= 2 }

    /// The sample closest to `km`.
    func sample(near km: Double) -> Sample? {
        guard !series.isEmpty else { return nil }
        var lo = 0
        var hi = series.count - 1
        while hi - lo > 1 {
            let mid = (lo + hi) / 2
            if series[mid].d <= km { lo = mid } else { hi = mid }
        }
        return abs(series[lo].d - km) <= abs(series[hi].d - km) ? series[lo] : series[hi]
    }
}

// MARK: - Formatting

enum ProfileFormat {
    private static let spanish = Locale(identifier: "es_ES")

    /// 312 -> "5:12"
    static func pace(_ secondsPerKm: Double?) -> String {
        guard let secondsPerKm, secondsPerKm.isFinite, secondsPerKm > 0, secondsPerKm < 3600 else { return "--" }
        let total = Int(secondsPerKm.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    /// 2.5 -> "2,5"
    static func km(_ km: Double, decimals: Int = 1) -> String {
        km.formatted(.number.precision(.fractionLength(0...decimals)).locale(spanish))
    }

    static func meters(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "--" }
        return Int(value.rounded()).formatted(.number.locale(spanish))
    }

    static func percent(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "--" }
        return value.formatted(.number.precision(.fractionLength(0...1)).locale(spanish))
    }

    static func duration(_ seconds: Double?) -> String {
        guard let seconds, seconds.isFinite, seconds > 0 else { return "--" }
        return Format.duration(Int(seconds.rounded()))
    }

    /// Distance of a split: "Km 3", or "0,45 km" for the last short one.
    static func splitLabel(_ split: ActivityProfile.Split) -> String {
        split.distance >= 950 ? "\(split.index)" : km(split.distance / 1000, decimals: 2)
    }
}

// MARK: - Section

/// Charts and highlights of an activity: altitude profile, pace, km splits, climbs and notable data.
/// Hidden when the activity has no times or altitudes (e.g. old imports without them).
struct ActivityProfileSection: View {
    let routeId: String
    /// Route colour (the owner's territory colour).
    let accent: Color

    @State private var profile: ActivityProfile?
    @State private var isLoading = true
    @State private var selectedKm: Double?

    var body: some View {
        Group {
            if let profile, profile.hasCharts {
                VStack(alignment: .leading, spacing: DS.Spacing.xxl) {
                    if profile.hasElevation {
                        ElevationCard(profile: profile, accent: accent, selectedKm: $selectedKm)
                    }
                    if profile.hasPace {
                        PaceCard(profile: profile, selectedKm: $selectedKm)
                    }
                    HighlightsCard(profile: profile)
                    if !profile.splits.isEmpty {
                        SplitsCard(profile: profile)
                    }
                    if !profile.climbs.isEmpty {
                        ClimbsCard(profile: profile)
                    }
                }
                .transition(.opacity)
            } else if isLoading {
                loadingCard
            }
        }
        .animation(.easeOut(duration: 0.25), value: profile?.hasCharts ?? false)
        .task(id: routeId) { await load() }
    }

    private var loadingCard: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Perfil")
            RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous)
                .fill(Color(uiColor: .tertiarySystemFill))
                .frame(height: 180)
                .overlay { ProgressView() }
                .card()
        }
        .accessibilityLabel("Cargando el perfil de la actividad")
    }

    private func load() async {
        isLoading = true
        do {
            let result: ActivityProfile = try await APIClient.shared.request("GET", "/api/routes/\(routeId)/profile")
            profile = result
        } catch {
            // Charts are extra: the activity screen works without them
            profile = nil
        }
        isLoading = false
    }
}

// MARK: - Altitude profile

private struct ElevationCard: View {
    let profile: ActivityProfile
    let accent: Color
    @Binding var selectedKm: Double?

    private var samples: [ActivityProfile.Sample] { profile.series.filter { $0.e != nil } }

    private var domain: ClosedRange<Double> {
        let values = samples.compactMap(\.e)
        let low = values.min() ?? 0
        let high = values.max() ?? 1
        let pad = max(8, (high - low) * 0.15)
        return (low - pad)...(high + pad)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Perfil de altitud", subtitle: subtitle)
            VStack(alignment: .leading, spacing: DS.Spacing.m) {
                ElevationChart(profile: profile, samples: samples, domain: domain, accent: accent, selectedKm: $selectedKm)
                    .frame(height: 190)
                HairlineDivider()
                HStack(spacing: 0) {
                    ProfileStat(value: "+\(ProfileFormat.meters(profile.stats?.elevationGain))", unit: "m", label: "Desnivel +")
                    StatDivider(height: 36)
                    ProfileStat(value: "−\(ProfileFormat.meters(profile.stats?.elevationLoss))", unit: "m", label: "Desnivel −")
                    StatDivider(height: 36)
                    ProfileStat(value: ProfileFormat.meters(profile.stats?.maxElevation), unit: "m", label: "Alt. máx.")
                    StatDivider(height: 36)
                    ProfileStat(value: ProfileFormat.meters(profile.stats?.minElevation), unit: "m", label: "Alt. mín.")
                }
            }
            .card()
        }
    }

    private var subtitle: String? {
        guard !profile.climbs.isEmpty else { return nil }
        return profile.climbs.count == 1 ? "La subida, resaltada" : "Las \(profile.climbs.count) subidas, resaltadas"
    }
}

private struct ElevationChart: View {
    let profile: ActivityProfile
    let samples: [ActivityProfile.Sample]
    let domain: ClosedRange<Double>
    let accent: Color
    @Binding var selectedKm: Double?

    private var selected: ActivityProfile.Sample? {
        guard let selectedKm else { return nil }
        return profile.sample(near: selectedKm)
    }

    var body: some View {
        Chart {
            ForEach(Array(profile.climbs.enumerated()), id: \.offset) { _, climb in
                RectangleMark(
                    xStart: .value("Inicio", climb.startKm),
                    xEnd: .value("Fin", climb.endKm)
                )
                .foregroundStyle(Color.gold.opacity(0.12))
            }
            ForEach(Array(samples.enumerated()), id: \.offset) { _, sample in
                AreaMark(
                    x: .value("Km", sample.d),
                    yStart: .value("Base", domain.lowerBound),
                    yEnd: .value("Altitud", sample.e ?? domain.lowerBound)
                )
                .interpolationMethod(.monotone)
                .foregroundStyle(
                    LinearGradient(colors: [accent.opacity(0.45), accent.opacity(0.04)], startPoint: .top, endPoint: .bottom)
                )
            }
            ForEach(Array(samples.enumerated()), id: \.offset) { _, sample in
                LineMark(x: .value("Km", sample.d), y: .value("Altitud", sample.e ?? domain.lowerBound))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(accent)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            if let selected, let altitude = selected.e {
                RuleMark(x: .value("Km", selected.d))
                    .foregroundStyle(Color.secondary.opacity(0.4))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .annotation(position: .top, spacing: 4, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        ChartCallout(lines: [
                            "\(ProfileFormat.km(selected.d, decimals: 2)) km",
                            "\(ProfileFormat.meters(altitude)) m",
                            selected.g.map { "\(ProfileFormat.percent($0)) %" },
                        ].compactMap { $0 })
                    }
                PointMark(x: .value("Km", selected.d), y: .value("Altitud", altitude))
                    .foregroundStyle(accent)
                    .symbolSize(60)
            }
        }
        .chartYScale(domain: domain)
        .chartXScale(domain: 0...(profile.series.last?.d ?? 1))
        .chartXAxis { kmAxis }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 3]))
                AxisValueLabel {
                    if let meters = value.as(Double.self) {
                        Text("\(ProfileFormat.meters(meters)) m")
                    }
                }
            }
        }
        .chartXSelection(value: $selectedKm)
        .accessibilityLabel("Perfil de altitud")
        .accessibilityValue("Desnivel positivo \(ProfileFormat.meters(profile.stats?.elevationGain)) metros, altitud máxima \(ProfileFormat.meters(profile.stats?.maxElevation)) metros")
    }

    private var kmAxis: some AxisContent {
        AxisMarks(values: .automatic(desiredCount: 5)) { value in
            AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 3]))
            AxisValueLabel {
                if let km = value.as(Double.self) {
                    Text("\(ProfileFormat.km(km)) km")
                }
            }
        }
    }
}

// MARK: - Pace

private struct PaceCard: View {
    let profile: ActivityProfile
    @Binding var selectedKm: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Ritmo", subtitle: "Arriba, más rápido")
            VStack(alignment: .leading, spacing: DS.Spacing.m) {
                PaceChart(profile: profile, selectedKm: $selectedKm)
                    .frame(height: 170)
                HairlineDivider()
                HStack(spacing: 0) {
                    ProfileStat(value: ProfileFormat.pace(profile.stats?.avgPace), unit: "/km", label: "Medio")
                    StatDivider(height: 36)
                    ProfileStat(value: ProfileFormat.pace(profile.stats?.bestKmPace), unit: "/km", label: "Mejor km")
                    StatDivider(height: 36)
                    ProfileStat(value: ProfileFormat.duration(profile.stats?.movingTime), unit: nil, label: "En movimiento")
                }
            }
            .card()
        }
    }
}

private struct PaceChart: View {
    let profile: ActivityProfile
    @Binding var selectedKm: Double?

    private var samples: [ActivityProfile.Sample] { profile.series.filter { $0.p != nil } }

    /// Slowest pace drawn: very slow moments (walking a bit, a traffic light) would flatten the rest.
    private var domain: ClosedRange<Double> {
        let paces = samples.compactMap(\.p).sorted()
        guard let fastest = paces.first else { return 180...600 }
        let p95 = paces[min(paces.count - 1, Int(Double(paces.count) * 0.95))]
        let low = max(120, fastest - 15)
        let high = max(low + 60, p95 + 20)
        return low...high
    }

    private var selected: ActivityProfile.Sample? {
        guard let selectedKm else { return nil }
        return profile.sample(near: selectedKm)
    }

    /// Plotted as negative seconds so faster paces (fewer seconds per km) are at the top.
    private func plotted(_ pace: Double, _ domain: ClosedRange<Double>) -> Double {
        -min(max(pace, domain.lowerBound), domain.upperBound)
    }

    var body: some View {
        let yDomain = self.domain
        Chart {
            ForEach(Array(samples.enumerated()), id: \.offset) { _, sample in
                AreaMark(
                    x: .value("Km", sample.d),
                    yStart: .value("Base", -yDomain.upperBound),
                    yEnd: .value("Ritmo", plotted(sample.p ?? yDomain.upperBound, yDomain))
                )
                .interpolationMethod(.monotone)
                .foregroundStyle(
                    LinearGradient(colors: [Color.brand.opacity(0.28), Color.brand.opacity(0.02)], startPoint: .top, endPoint: .bottom)
                )
            }
            ForEach(Array(samples.enumerated()), id: \.offset) { _, sample in
                LineMark(x: .value("Km", sample.d), y: .value("Ritmo", plotted(sample.p ?? yDomain.upperBound, yDomain)))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(Color.brand)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
            if let average = profile.stats?.avgPace, yDomain.contains(average) {
                RuleMark(y: .value("Medio", -average))
                    .foregroundStyle(Color.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    .annotation(position: .top, alignment: .trailing, spacing: 2) {
                        Text("medio \(ProfileFormat.pace(average))")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
            }
            if let selected {
                RuleMark(x: .value("Km", selected.d))
                    .foregroundStyle(Color.secondary.opacity(0.4))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .annotation(position: .top, spacing: 4, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        ChartCallout(lines: [
                            "\(ProfileFormat.km(selected.d, decimals: 2)) km",
                            selected.p.map { "\(ProfileFormat.pace($0)) /km" } ?? "parado",
                        ])
                    }
                if let pace = selected.p {
                    PointMark(x: .value("Km", selected.d), y: .value("Ritmo", plotted(pace, yDomain)))
                        .foregroundStyle(Color.brand)
                        .symbolSize(60)
                }
            }
        }
        .chartYScale(domain: (-yDomain.upperBound)...(-yDomain.lowerBound))
        .chartXScale(domain: 0...(profile.series.last?.d ?? 1))
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 5)) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 3]))
                AxisValueLabel {
                    if let km = value.as(Double.self) {
                        Text("\(ProfileFormat.km(km)) km")
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [2, 3]))
                AxisValueLabel {
                    if let plottedValue = value.as(Double.self) {
                        Text(ProfileFormat.pace(-plottedValue))
                    }
                }
            }
        }
        .chartXSelection(value: $selectedKm)
        .accessibilityLabel("Ritmo a lo largo de la actividad")
        .accessibilityValue("Ritmo medio \(ProfileFormat.pace(profile.stats?.avgPace)) por kilómetro")
    }
}

// MARK: - Highlights

private struct HighlightsCard: View {
    let profile: ActivityProfile

    private struct Highlight: Identifiable {
        let id: String
        let systemImage: String
        let tint: Color
        let title: String
        let value: String
        let detail: String?
    }

    private var highlights: [Highlight] {
        guard let stats = profile.stats else { return [] }
        var items: [Highlight] = []
        if let best = stats.bestKmPace {
            items.append(Highlight(
                id: "best", systemImage: "bolt.fill", tint: .brand, title: "Mejor kilómetro",
                value: "\(ProfileFormat.pace(best)) /km",
                detail: stats.bestKmStartKm.map { "Desde el km \(ProfileFormat.km($0))" }
            ))
        }
        if let first = stats.firstHalfPace, let second = stats.secondHalfPace {
            let faster = second < first - 2
            let slower = second > first + 2
            items.append(Highlight(
                id: "halves", systemImage: faster ? "arrow.up.right" : (slower ? "arrow.down.right" : "equal"),
                tint: faster ? .brand : (slower ? .steal : .sky), title: "1.ª y 2.ª mitad",
                value: "\(ProfileFormat.pace(first)) → \(ProfileFormat.pace(second))",
                detail: faster ? "Negative split: acabaste más rápido" : (slower ? "La segunda mitad fue más lenta" : "Ritmo muy constante")
            ))
        }
        if let moving = stats.movingTime, let elapsed = stats.elapsedTime {
            let stopped = elapsed - moving
            items.append(Highlight(
                id: "moving", systemImage: "timer", tint: .sky, title: "En movimiento",
                value: ProfileFormat.duration(moving),
                detail: stopped >= 30 ? "Parado \(ProfileFormat.duration(stopped)) de \(ProfileFormat.duration(elapsed))" : "Sin paradas"
            ))
        }
        if let grade = stats.maxGrade, grade >= 3 {
            items.append(Highlight(
                id: "grade", systemImage: "arrow.up.forward", tint: .gold, title: "Pendiente máxima",
                value: "\(ProfileFormat.percent(grade)) %",
                detail: profile.climbs.isEmpty ? nil : (profile.climbs.count == 1 ? "1 subida" : "\(profile.climbs.count) subidas")
            ))
        }
        if let gain = stats.elevationGain, let distance = stats.distance, distance >= 1000, gain >= 10 {
            let perKm = gain / (distance / 1000)
            items.append(Highlight(
                id: "gainPerKm", systemImage: "mountain.2", tint: .grape, title: "Desnivel por km",
                value: "\(ProfileFormat.meters(perKm)) m/km",
                detail: perKm >= 40 ? "Terreno de trail" : (perKm >= 15 ? "Rompepiernas" : "Bastante llano")
            ))
        }
        if let fastest = stats.fastestSplit, let slowest = stats.slowestSplit, fastest != slowest,
           let fast = profile.splits.first(where: { $0.index == fastest }),
           let slow = profile.splits.first(where: { $0.index == slowest }) {
            items.append(Highlight(
                id: "spread", systemImage: "chart.bar.xaxis", tint: .sky, title: "Km más rápido y más lento",
                value: "\(ProfileFormat.pace(fast.pace)) · \(ProfileFormat.pace(slow.pace))",
                detail: "Km \(fastest) y km \(slowest)"
            ))
        }
        return items
    }

    var body: some View {
        let items = highlights
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                SectionHeader(title: "Datos destacados")
                LazyVGrid(columns: [GridItem(.flexible(), spacing: DS.Spacing.m), GridItem(.flexible(), spacing: DS.Spacing.m)], spacing: DS.Spacing.m) {
                    ForEach(items) { item in
                        HighlightTile(systemImage: item.systemImage, tint: item.tint, title: item.title, value: item.value, detail: item.detail)
                    }
                }
            }
        }
    }
}

private struct HighlightTile: View {
    let systemImage: String
    let tint: Color
    let title: String
    let value: String
    let detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.xs) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(tint)
                Text(title)
                    .statLabelStyle()
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Text(value)
                .font(Font.stat(22, weight: .semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if let detail {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
        .card(padding: DS.Spacing.m)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Splits

private struct SplitsCard: View {
    let profile: ActivityProfile

    /// Bars show speed: the fastest km fills the row.
    private var fastestPace: Double { profile.splits.map(\.pace).min() ?? 1 }
    private var slowestPace: Double { profile.splits.map(\.pace).max() ?? 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Parciales", subtitle: profile.hasElevation ? "Ritmo y desnivel de cada kilómetro" : "Ritmo de cada kilómetro")
            VStack(spacing: 0) {
                HStack(spacing: DS.Spacing.m) {
                    Text("KM").frame(width: 34, alignment: .leading)
                    Text("RITMO").frame(width: 44, alignment: .leading)
                    Spacer(minLength: 0)
                    if profile.hasElevation {
                        Text("DESNIVEL").frame(width: 64, alignment: .trailing)
                    }
                }
                .font(Font.statLabel)
                .foregroundStyle(.secondary)
                .padding(.bottom, DS.Spacing.s)
                ForEach(profile.splits) { split in
                    SplitRow(
                        split: split,
                        ratio: fastestPace / max(split.pace, 1),
                        isFastest: split.index == profile.stats?.fastestSplit,
                        isSlowest: split.index == profile.stats?.slowestSplit && slowestPace > fastestPace,
                        showsElevation: profile.hasElevation
                    )
                }
            }
            .card()
        }
    }
}

private struct SplitRow: View {
    let split: ActivityProfile.Split
    /// 0...1, 1 for the fastest km
    let ratio: Double
    let isFastest: Bool
    let isSlowest: Bool
    let showsElevation: Bool

    private var barColor: Color {
        if isFastest { return .brand }
        if isSlowest { return Color.steal.opacity(0.75) }
        return Color.brand.opacity(0.35)
    }

    private var elevationText: String {
        let gain = split.elevationGain ?? 0
        let loss = split.elevationLoss ?? 0
        if gain < 1 && loss < 1 { return "—" }
        return gain >= loss ? "+\(ProfileFormat.meters(gain)) m" : "−\(ProfileFormat.meters(loss)) m"
    }

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            Text(ProfileFormat.splitLabel(split))
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .frame(width: 34, alignment: .leading)
            Text(ProfileFormat.pace(split.pace))
                .font(.subheadline.weight(isFastest ? .bold : .regular))
                .monospacedDigit()
                .frame(width: 44, alignment: .leading)
            GeometryReader { geometry in
                Capsule()
                    .fill(barColor)
                    .frame(width: max(6, geometry.size.width * min(1, max(0.08, ratio))), height: 10)
                    .frame(maxHeight: .infinity, alignment: .center)
            }
            .frame(height: 22)
            if showsElevation {
                Text(elevationText)
                    .font(.caption.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .frame(width: 64, alignment: .trailing)
            }
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Kilómetro \(ProfileFormat.splitLabel(split)): \(ProfileFormat.pace(split.pace)) por kilómetro\(showsElevation ? ", \(elevationText)" : "")\(isFastest ? ", el más rápido" : "")")
    }
}

// MARK: - Climbs

private struct ClimbsCard: View {
    let profile: ActivityProfile

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Subidas", subtitle: profile.climbs.count == 1 ? "1 subida" : "\(profile.climbs.count) subidas")
            VStack(spacing: 0) {
                ForEach(Array(profile.climbs.enumerated()), id: \.offset) { index, climb in
                    if index > 0 {
                        HairlineDivider()
                    }
                    ClimbRow(number: index + 1, climb: climb, samples: profile.series.filter { $0.e != nil && $0.d >= climb.startKm && $0.d <= climb.endKm })
                        .padding(.vertical, DS.Spacing.m)
                }
            }
            .padding(.horizontal, DS.Spacing.l)
            .card(padding: 0)
        }
    }
}

private struct ClimbRow: View {
    let number: Int
    let climb: ActivityProfile.Climb
    let samples: [ActivityProfile.Sample]

    /// Steeper climbs read warmer.
    private var tint: Color {
        if climb.avgGrade >= 8 { return .steal }
        if climb.avgGrade >= 5 { return .gold }
        return .brandLime
    }

    private var difficulty: String {
        if climb.avgGrade >= 8 { return "Dura" }
        if climb.avgGrade >= 5 { return "Exigente" }
        return "Suave"
    }

    var body: some View {
        HStack(alignment: .center, spacing: DS.Spacing.m) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text("Subida \(number)")
                        .font(.subheadline.weight(.semibold))
                    Text(difficulty)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(tint)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(tint.opacity(0.14), in: Capsule())
                }
                Text("Km \(ProfileFormat.km(climb.startKm)) – \(ProfileFormat.km(climb.endKm))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(spacing: DS.Spacing.m) {
                    StatValue(value: "+\(ProfileFormat.meters(climb.gain))", unit: "m", font: Font.stat(20, weight: .semibold), tint: tint)
                    StatValue(value: ProfileFormat.km(climb.length / 1000, decimals: 2), unit: "km", font: Font.stat(20, weight: .semibold))
                    StatValue(value: ProfileFormat.percent(climb.avgGrade), unit: "%", font: Font.stat(20, weight: .semibold))
                }
                HStack(spacing: DS.Spacing.s) {
                    Text("Máx. \(ProfileFormat.percent(climb.maxGrade)) %")
                    if let duration = climb.duration {
                        Text("· \(ProfileFormat.duration(duration))")
                    }
                    if let vam = climb.vam, vam > 0 {
                        Text("· \(ProfileFormat.meters(vam)) m/h")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            ClimbSparkline(samples: samples, tint: tint)
                .frame(width: 96, height: 52)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The climb's own altitude profile.
private struct ClimbSparkline: View {
    let samples: [ActivityProfile.Sample]
    let tint: Color

    private var domain: ClosedRange<Double> {
        let values = samples.compactMap(\.e)
        let low = values.min() ?? 0
        let high = values.max() ?? 1
        return (low - 2)...(max(high, low + 1) + 2)
    }

    var body: some View {
        let yDomain = self.domain
        Chart {
            ForEach(Array(samples.enumerated()), id: \.offset) { _, sample in
                AreaMark(
                    x: .value("Km", sample.d),
                    yStart: .value("Base", yDomain.lowerBound),
                    yEnd: .value("Altitud", sample.e ?? yDomain.lowerBound)
                )
                .interpolationMethod(.monotone)
                .foregroundStyle(LinearGradient(colors: [tint.opacity(0.4), tint.opacity(0.05)], startPoint: .top, endPoint: .bottom))
            }
            ForEach(Array(samples.enumerated()), id: \.offset) { _, sample in
                LineMark(x: .value("Km", sample.d), y: .value("Altitud", sample.e ?? yDomain.lowerBound))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(tint)
                    .lineStyle(StrokeStyle(lineWidth: 1.5, lineCap: .round))
            }
        }
        .chartYScale(domain: yDomain)
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .accessibilityHidden(true)
    }
}

// MARK: - Shared pieces

private struct ProfileStat: View {
    let value: String
    let unit: String?
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            StatValue(value: value, unit: unit, font: Font.stat(19, weight: .semibold))
            Text(label)
                .statLabelStyle()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, DS.Spacing.xs)
        .accessibilityElement(children: .combine)
    }
}

/// Value bubble over the selected point of a chart.
private struct ChartCallout: View {
    let lines: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                Text(line)
                    .font(index == 0 ? .caption2.weight(.medium) : .caption.weight(.semibold))
                    .foregroundStyle(index == 0 ? Color.secondary : Color.primary)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Color.hairline, lineWidth: 0.5))
    }
}
