import SwiftUI
import MapKit

// MARK: - Banner

/// Competition state: countdown before it starts, day counter while active, results link when finished.
/// `.compact` is the slim glass strip floating over the map; `.hero` is the flat card in Ranking.
struct CompetitionBanner: View {
    enum Style { case compact, hero }

    let store: CompetitionStore
    var style: Style = .compact
    var onShowResults: () -> Void = {}

    @AppStorage("competition_banner_collapsed") private var collapsed = false

    var body: some View {
        if let competition = store.competition {
            if store.isUpcoming {
                upcoming(competition)
                    .task(id: competition.id) {
                        // Reload the state when the countdown reaches zero, so the competition becomes active
                        let wait = remainingSeconds(competition, now: Date())
                        guard wait > 0 else { return }
                        try? await Task.sleep(nanoseconds: UInt64((wait + 1) * 1_000_000_000))
                        if Task.isCancelled { return }
                        await store.refresh()
                    }
            } else if store.isActive {
                active(competition)
            } else if store.isFinished {
                finished(competition)
            }
        }
    }

    @ViewBuilder
    private func upcoming(_ competition: CompetitionInfo.Competition) -> some View {
        switch style {
        case .hero:
            TimelineView(.periodic(from: .now, by: 1)) { context in
                CompetitionUpcomingCard(name: competition.name, remaining: remainingSeconds(competition, now: context.date))
            }
            .accessibilityElement(children: .combine)
        case .compact:
            Button {
                withAnimation(.snappy) { collapsed.toggle() }
            } label: {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    CompetitionCompactStrip(
                        systemImage: "flag",
                        title: competition.name,
                        subtitle: collapsed ? nil : "Empieza en",
                        trailing: compactCountdown(competition, now: context.date),
                        compact: collapsed,
                        showsChevron: false
                    )
                }
            }
            .buttonStyle(.pressable)
            .accessibilityLabel("\(competition.name), comienza pronto")
        }
    }

    @ViewBuilder
    private func active(_ competition: CompetitionInfo.Competition) -> some View {
        switch style {
        case .hero:
            CompetitionActiveCard(
                name: competition.name,
                day: store.info?.dayOfCompetition,
                totalDays: store.info?.totalDays,
                week: store.currentWeek
            )
            .accessibilityElement(children: .combine)
        case .compact:
            CompetitionCompactStrip(
                systemImage: "trophy",
                title: competition.name,
                subtitle: nil,
                trailing: dayText,
                compact: true,
                showsChevron: false
            )
            .accessibilityElement(children: .combine)
        }
    }

    private func finished(_ competition: CompetitionInfo.Competition) -> some View {
        Button(action: onShowResults) {
            finishedLabel(competition)
        }
        .buttonStyle(PressableButtonStyle(scale: 0.98))
        .accessibilityLabel("\(competition.name) ha terminado. Ver resultados")
    }

    @ViewBuilder
    private func finishedLabel(_ competition: CompetitionInfo.Competition) -> some View {
        switch style {
        case .hero:
            CompetitionFinishedCard(name: competition.name)
        case .compact:
            CompetitionCompactStrip(
                systemImage: "flag.checkered",
                title: "\(competition.name) ha terminado",
                subtitle: "Ver resultados finales",
                trailing: nil,
                compact: false,
                showsChevron: true
            )
        }
    }

    private var dayText: String? {
        guard let day = store.info?.dayOfCompetition, let total = store.info?.totalDays else { return nil }
        return "Día \(day)/\(total)"
    }

    private func compactCountdown(_ competition: CompetitionInfo.Competition, now: Date) -> String {
        let remaining = remainingSeconds(competition, now: now)
        return remaining <= 0 ? "Ahora" : Self.countdown(remaining, withSeconds: !collapsed)
    }

    private func remainingSeconds(_ competition: CompetitionInfo.Competition, now: Date) -> Double {
        if let start = competition.startDate { return start.timeIntervalSince(now) }
        return (store.info?.timeUntilStart ?? 0) / 1000
    }

    /// "3d 4h 12m 05s"
    static func countdown(_ seconds: Double, withSeconds: Bool) -> String {
        let total = max(0, Int(seconds))
        let days = total / 86_400
        let hours = (total % 86_400) / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        var text = days > 0 ? "\(days)d \(hours)h \(minutes)m" : (hours > 0 ? "\(hours)h \(minutes)m" : "\(minutes)m")
        if withSeconds { text += String(format: " %02ds", secs) }
        return text
    }
}

/// Slim glass strip over the map: symbol, name, optional subtitle and a monospaced trailing value.
private struct CompetitionCompactStrip: View {
    let systemImage: String
    let title: String
    let subtitle: String?
    let trailing: String?
    let compact: Bool
    let showsChevron: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            if let trailing {
                Text(trailing)
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
            }
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, compact ? 8 : 10)
        .glassSurface(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
    }
}

/// Card header row: uppercase status label (+ optional trailing meta).
private struct CompetitionCardHeader: View {
    let label: String
    var trailing: String? = nil
    var accent: Bool = false

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(Font.sectionLabel)
                .textCase(.uppercase)
                .tracking(DS.Tracking.label)
                .foregroundStyle(accent ? Color.brand : Color.secondary)
            Spacer(minLength: 8)
            if let trailing {
                Text(trailing)
                    .font(Font.meta)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct CompetitionUpcomingCard: View {
    let name: String
    let remaining: Double

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            CompetitionCardHeader(label: "Próximamente")
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(Font.sectionTitle)
                    .lineLimit(2)
                Text(remaining > 0 ? "Todos contra todos. Empieza en" : "Empieza ahora.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if remaining > 0 {
                CompetitionCountdownRow(seconds: remaining)
                    .padding(.top, DS.Spacing.xs)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

/// Days · hours · minutes · seconds, separated by hairlines.
private struct CompetitionCountdownRow: View {
    let seconds: Double

    private var total: Int { max(0, Int(seconds)) }

    var body: some View {
        HStack(spacing: 0) {
            StatTile(value: String(format: "%02d", total / 86_400), label: "días")
            StatDivider()
            StatTile(value: String(format: "%02d", (total % 86_400) / 3600), label: "horas")
            StatDivider()
            StatTile(value: String(format: "%02d", (total % 3600) / 60), label: "min")
            StatDivider()
            StatTile(value: String(format: "%02d", total % 60), label: "seg")
        }
    }
}

private struct CompetitionActiveCard: View {
    let name: String
    let day: Int?
    let totalDays: Int?
    let week: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            CompetitionCardHeader(label: "En curso", trailing: week.map { "Semana \($0)" }, accent: true)
            Text(name)
                .font(Font.sectionTitle)
                .lineLimit(2)
            if let day, let totalDays, totalDays > 0 {
                CompetitionDayProgress(day: day, total: totalDays)
            } else {
                Text("Gana quien tenga más territorio al final.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

/// "Día 12 de 28" · "Quedan 16 días" + a thin progress bar.
private struct CompetitionDayProgress: View {
    let day: Int
    let total: Int

    private var fraction: Double { min(1, max(0, Double(day) / Double(total))) }
    private var left: Int { max(0, total - day) }
    private var leftText: String {
        if left == 0 { return "Último día" }
        return left == 1 ? "Queda 1 día" : "Quedan \(left) días"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("Día \(day)")
                    .font(Font.statNumber)
                    .monospacedDigit()
                    .contentTransition(.numericText())
                Text("de \(total)")
                    .font(Font.statUnit)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 6)
                Text(leftText)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            bar
        }
    }

    private var bar: some View {
        Capsule()
            .fill(Color(uiColor: .tertiarySystemFill))
            .frame(height: 4)
            .overlay(alignment: .leading) {
                GeometryReader { proxy in
                    Capsule()
                        .fill(Color.brand)
                        .frame(width: max(4, proxy.size.width * fraction))
                }
            }
            .accessibilityHidden(true)
    }
}

private struct CompetitionFinishedCard: View {
    let name: String

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            CompetitionCardHeader(label: "Finalizada")
            VStack(alignment: .leading, spacing: 2) {
                Text("\(name) ha terminado")
                    .font(Font.sectionTitle)
                    .foregroundStyle(Color.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text("Consulta la clasificación final.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 4) {
                Text("Ver resultados")
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.brand)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

// MARK: - Treasures

/// Treasure on the map: a small solid disc with a rarity-coloured ring and a box glyph. Static.
struct TreasureMarker: View {
    let treasure: Treasure

    var body: some View {
        let color: Color = Rarity.color(treasure.rarity)
        Image(systemName: "shippingbox.fill")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(color)
            .frame(width: 32, height: 32)
            .background(Color(uiColor: .systemBackground), in: Circle())
            .overlay(Circle().strokeBorder(color, lineWidth: 2))
            .shadow(color: Color.black.opacity(0.18), radius: 2, x: 0, y: 1)
            .contentShape(Circle())
            .accessibilityLabel("Tesoro \(Rarity.label(treasure.rarity)): \(treasure.name)")
    }
}

/// Tapped treasure: power, rarity, description and time left.
struct TreasureDetailView: View {
    let treasure: Treasure
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.l) {
            header
            if let description = treasure.powerDescription, !description.isEmpty {
                Text(description)
                    .font(.subheadline)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                timeLeft
                Label("Pasa corriendo a menos de 100 m para recogerlo.", systemImage: "figure.run")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Button("Entendido") { dismiss() }
                .buttonStyle(PrimaryButtonStyle())
        }
        .padding(DS.Spacing.xl)
        .presentationDetents([.height(340), .medium])
        .presentationDragIndicator(.visible)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            Image(systemName: PowerSymbol.name(treasure.powerType))
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(Color.primary)
                .frame(width: 52, height: 52)
                .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
                .hairlineBorder(radius: DS.Radius.tile)
            VStack(alignment: .leading, spacing: 4) {
                RarityPill(rarity: treasure.rarity)
                Text(treasure.powerName ?? treasure.name)
                    .font(Font.sectionTitle)
                    .lineLimit(2)
                if let powerName = treasure.powerName, powerName != treasure.name {
                    Text(treasure.name)
                        .font(Font.meta)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var timeLeft: some View {
        if let expires = treasure.expiresDate {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let remaining = expires.timeIntervalSince(context.date)
                Label {
                    if remaining > 0 {
                        Text("Desaparece en \(Self.remaining(remaining))")
                            .monospacedDigit()
                    } else {
                        Text("Ha caducado")
                            .foregroundStyle(Color.steal)
                    }
                } icon: {
                    Image(systemName: "hourglass")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        } else {
            Label("Disponible hoy", systemImage: "hourglass")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    /// "5h 07m 32s"
    static func remaining(_ seconds: Double) -> String {
        let total = max(0, Int(seconds))
        return String(format: "%dh %02dm %02ds", total / 3600, (total % 3600) / 60, total % 60)
    }
}

// MARK: - Fortifications

/// A fortified zone drawn over a territory.
struct FortificationShape: Identifiable {
    let id: String
    let userId: String
    let color: Color
    let polygon: MKPolygon
    /// Fortification layers of its zone (1 or more).
    let layers: Int
    /// Diagonal hatch lines clipped to the polygon (drawn close up).
    let hatch: [[CLLocationCoordinate2D]]

    var fillOpacity: Double { min(0.30 + Double(layers) * 0.08, 0.6) }
    /// The wall gets thicker with every layer.
    var wallWidth: CGFloat { CGFloat(min(1.5 + Double(layers) * 1.5, 7.5)) }
}

/// Castle marker for a zone fortified several times.
struct CastleZone: Identifiable {
    let id: String
    let userId: String
    let coordinate: CLLocationCoordinate2D
    /// Fortification layers stacked on the zone.
    let layers: Int
    let color: Color

    var levelText: String { "×\(layers)" }
}

/// Fortress on the map: a compact solid capsule with a shield glyph and the level, ringed in the owner's colour.
struct CastleMarker: View {
    let zone: CastleZone

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "shield.lefthalf.filled")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(zone.color)
            Text(zone.levelText)
                .font(.system(size: 12, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(Color.primary)
        }
        .padding(.horizontal, 7)
        .frame(height: 24)
        .background(Color(uiColor: .systemBackground), in: Capsule())
        .overlay(Capsule().strokeBorder(zone.color, lineWidth: 1.5))
        .shadow(color: Color.black.opacity(0.15), radius: 2, x: 0, y: 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Fortaleza de \(zone.layers) capas")
    }
}

extension Color {
    /// The colour mixed with black (amount 0...1).
    func darkened(_ amount: Double) -> Color {
        let ui = UIColor(self)
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        guard ui.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return self }
        let factor = CGFloat(max(0, min(1, 1 - amount)))
        return Color(red: Double(red * factor), green: Double(green * factor), blue: Double(blue * factor), opacity: Double(alpha))
    }
}

// MARK: - Leaderboard names

/// Name as shown in competition lists: the nickname (with a small masks glyph) when one is active.
struct CompetitorName: View {
    let user: UserRef
    var isMe = false
    var font: Font = .body

    var body: some View {
        if let nickname = user.nickname, !nickname.isEmpty {
            HStack(spacing: 4) {
                Image(systemName: "theatermasks")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                Text(nickname)
                    .font(font.weight(.semibold))
                    .lineLimit(1)
            }
        } else {
            Text(isMe ? "\(user.name) (tú)" : user.name)
                .font(isMe ? font.weight(.semibold) : font.weight(.medium))
                .lineLimit(1)
        }
    }
}

// MARK: - Intro

/// Shown the first time a competition is active: what it is, rules, treasures and powers.
struct CompetitionIntroView: View {
    let store: CompetitionStore
    @Environment(\.dismiss) private var dismiss
    @State private var page = 0

    private let pageCount = 4

    private var powers: [(key: String, value: PowerDefinition)] {
        let order: [String: Int] = ["common": 0, "rare": 1, "epic": 2, "legendary": 3]
        let definitions: [String: PowerDefinition] = store.info?.treasurePowers ?? [:]
        let items: [(key: String, value: PowerDefinition)] = definitions.map { (key: $0.key, value: $0.value) }
        return items.sorted { a, b in
            let rankA = order[a.value.rarity] ?? 0
            let rankB = order[b.value.rarity] ?? 0
            return rankA != rankB ? rankA < rankB : a.value.name < b.value.name
        }
    }

    private var isLastPage: Bool { page >= pageCount - 1 }

    var body: some View {
        VStack(spacing: DS.Spacing.l) {
            topBar
            TabView(selection: $page) {
                welcome.tag(0)
                rules.tag(1)
                treasures.tag(2)
                finale.tag(3)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            pageDots
            Button(isLastPage ? "Empezar" : "Siguiente") {
                if isLastPage {
                    dismiss()
                } else {
                    withAnimation(.snappy) { page += 1 }
                }
            }
            .buttonStyle(PrimaryButtonStyle())
            .sensoryFeedback(.selection, trigger: page)
        }
        .padding(DS.Spacing.xl)
        .screenBackground()
    }

    private var topBar: some View {
        HStack {
            SectionLabel("Nueva competición")
            Spacer()
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 32)
                    .background(Color(uiColor: .tertiarySystemFill), in: Circle())
            }
            .accessibilityLabel("Cerrar")
        }
    }

    private var pageDots: some View {
        HStack(spacing: 6) {
            ForEach(0..<pageCount, id: \.self) { index in
                Circle()
                    .fill(index == page ? Color.primary : Color(uiColor: .tertiaryLabel))
                    .frame(width: 6, height: 6)
            }
        }
        .animation(.snappy, value: page)
        .accessibilityHidden(true)
    }

    private var welcome: some View {
        CompetitionIntroPage(systemImage: "flag.checkered", title: store.competition?.name ?? "Competición") {
            Text("Una competición de \(store.info?.totalDays ?? 28) días en la que todos los participantes compiten por el mismo mapa.")
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            SectionLabel("Todos contra todos")
                .padding(.top, DS.Spacing.xs)
        }
    }

    private var rules: some View {
        CompetitionIntroPage(systemImage: "list.bullet", title: "Reglas") {
            VStack(spacing: 0) {
                CompetitionIntroRule(systemImage: "figure.run", text: "Cada recorrido cerrado conquista el territorio que encierra.")
                HairlineDivider().padding(.leading, 48)
                CompetitionIntroRule(systemImage: "arrow.left.arrow.right", text: "Puedes robar territorio a cualquier participante, no solo a tus amigos.")
                HairlineDivider().padding(.leading, 48)
                CompetitionIntroRule(systemImage: "shield.lefthalf.filled", text: "Volver a correr por tu zona la fortifica y la hace más difícil de robar.")
                HairlineDivider().padding(.leading, 48)
                CompetitionIntroRule(systemImage: "calendar", text: "Cada domingo a las 20:00 se publica el resumen semanal con premios.")
            }
            .background(Color.surface, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
            .hairlineBorder(radius: DS.Radius.card)
        }
    }

    private var treasures: some View {
        CompetitionIntroPage(systemImage: "shippingbox", title: "Tesoros y poderes") {
            Text("Cada día aparecen tesoros en el mapa. Pasa a menos de 100 m corriendo para recogerlos y conseguir poderes.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(powers.enumerated()), id: \.element.key) { index, item in
                        if index > 0 {
                            HairlineDivider().padding(.leading, 48)
                        }
                        CompetitionIntroPowerRow(powerType: item.key, power: item.value)
                    }
                }
                .background(Color.surface, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
                .hairlineBorder(radius: DS.Radius.card)
            }
            .scrollIndicators(.hidden)
        }
    }

    private var finale: some View {
        CompetitionIntroPage(systemImage: "trophy", title: "Cómo se gana") {
            Text("Gana quien tenga más territorio cuando termine la competición. La clasificación se actualiza con cada carrera.")
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct CompetitionIntroPage<Content: View>: View {
    let systemImage: String
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.l) {
            Image(systemName: systemImage)
                .font(.system(size: 30, weight: .regular))
                .foregroundStyle(Color.brand)
                .frame(height: 36)
                .padding(.top, DS.Spacing.xxl)
            Text(title)
                .font(Font.screenTitle)
                .tracking(DS.Tracking.title)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
            content
            Spacer(minLength: DS.Spacing.m)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 2)
    }
}

private struct CompetitionIntroRule: View {
    let systemImage: String
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.m) {
            Image(systemName: systemImage)
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            Text(text)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, DS.Spacing.m)
        .padding(.vertical, DS.Spacing.m)
    }
}

private struct CompetitionIntroPowerRow: View {
    let powerType: String
    let power: PowerDefinition

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.m) {
            Image(systemName: PowerSymbol.name(powerType))
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.s) {
                    Text(power.name)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    RarityPill(rarity: power.rarity)
                }
                Text(power.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(DS.Spacing.m)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Final results

/// Final standings when the competition has finished (top 10).
struct CompetitionFinalView: View {
    let competitionName: String
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [CompetitionEntry] = []
    @State private var isLoading = true

    private var items: [RankingItem] {
        var result: [RankingItem] = []
        for (index, entry) in entries.prefix(10).enumerated() {
            result.append(RankingItem(entry: entry, rank: index + 1, isMe: entry.user.id == session.userId))
        }
        return result
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: DS.Spacing.xl) {
                    CompetitionFinalHeader(competitionName: competitionName, winner: items.first, me: items.first(where: { $0.isMe }))
                    results
                }
                .padding(.horizontal, DS.Spacing.l)
                .padding(.vertical, DS.Spacing.l)
            }
            .screenBackground()
            .navigationTitle("Resultados finales")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .task { await load() }
        }
    }

    @ViewBuilder
    private var results: some View {
        if isLoading {
            RankingSkeleton()
        } else if entries.isEmpty {
            EmptyStateView(
                systemImage: "flag.checkered",
                title: "Sin resultados",
                message: "Nadie conquistó territorio en esta competición."
            )
            .card()
        } else {
            VStack(alignment: .leading, spacing: DS.Spacing.m) {
                SectionHeader(title: "Clasificación final")
                RankingBoardView(items: items, showsPosition: false)
            }
        }
    }

    private func load() async {
        defer { isLoading = false }
        if let response = try? await APIClient.shared.request("GET", "/api/competition/leaderboard", as: CompetitionLeaderboardResponse.self) {
            entries = response.leaderboard.sorted { $0.totalArea > $1.totalArea }
        }
    }
}

/// Editorial header: competition over, champion and the user's final place.
private struct CompetitionFinalHeader: View {
    let competitionName: String
    let winner: RankingItem?
    let me: RankingItem?

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.l) {
            VStack(alignment: .leading, spacing: 4) {
                SectionLabel("Competición finalizada")
                Text(competitionName)
                    .font(Font.screenTitle)
                    .tracking(DS.Tracking.title)
                    .lineLimit(2)
                    .minimumScaleFactor(0.7)
            }
            if winner != nil || me != nil {
                stats
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var stats: some View {
        HStack(spacing: DS.Spacing.l) {
            if let winner {
                HStack(spacing: DS.Spacing.m) {
                    AvatarView(name: winner.name, avatar: winner.avatar, color: winner.color, size: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            Image(systemName: "crown.fill")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Color.gold)
                            Text("Campeón")
                                .statLabelStyle()
                        }
                        Text(winner.displayName)
                            .font(Font.cardTitle)
                            .lineLimit(1)
                        Text(Format.area(winner.area))
                            .font(Font.meta)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            if let me {
                StatDivider(height: 44)
                VStack(spacing: 2) {
                    Text("#\(me.rank)")
                        .font(Font.statNumber)
                        .monospacedDigit()
                        .foregroundStyle(me.rank == 1 ? Color.gold : Color.primary)
                    Text("Tu puesto")
                        .statLabelStyle()
                }
                .frame(minWidth: 72)
            }
        }
        .card()
    }
}
