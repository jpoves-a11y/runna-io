import SwiftUI
import MapKit

// MARK: - Banner

/// Competition state: countdown before it starts, day counter while active, results link when finished.
/// `.compact` is the slim strip floating over the map; `.hero` is the big gradient card in Ranking.
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
            CompetitionHeroCard(gradient: LinearGradient.stealGradient, glow: Color.steal, symbol: "flag.2.crossed.fill") {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    CompetitionUpcomingContent(name: competition.name, remaining: remainingSeconds(competition, now: context.date))
                }
            }
            .accessibilityElement(children: .combine)
        case .compact:
            Button {
                withAnimation(.snappy) { collapsed.toggle() }
            } label: {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    CompetitionCompactStrip(
                        emoji: "⚔️",
                        title: competition.name,
                        subtitle: collapsed ? nil : "Todos contra todos · empieza en",
                        trailing: compactCountdown(competition, now: context.date),
                        gradient: LinearGradient.stealGradient,
                        glow: Color.steal,
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
            CompetitionHeroCard(gradient: LinearGradient.brandGradient, glow: Color.brand, symbol: "trophy.fill") {
                CompetitionActiveContent(
                    name: competition.name,
                    day: store.info?.dayOfCompetition,
                    totalDays: store.info?.totalDays,
                    week: store.currentWeek
                )
            }
            .accessibilityElement(children: .combine)
        case .compact:
            CompetitionCompactStrip(
                emoji: "🏆",
                title: competition.name,
                subtitle: nil,
                trailing: dayText,
                gradient: LinearGradient.brandGradient,
                glow: Color.brand,
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
        .buttonStyle(PressableButtonStyle(scale: 0.97))
        .accessibilityLabel("\(competition.name) ha terminado. Ver resultados")
    }

    @ViewBuilder
    private func finishedLabel(_ competition: CompetitionInfo.Competition) -> some View {
        switch style {
        case .hero:
            CompetitionHeroCard(gradient: LinearGradient.grapeGradient, glow: Color.grape, symbol: "crown.fill") {
                CompetitionFinishedContent(name: competition.name)
            }
        case .compact:
            CompetitionCompactStrip(
                emoji: "👑",
                title: "¡\(competition.name) ha terminado!",
                subtitle: "Toca para ver quién se lleva la corona",
                trailing: nil,
                gradient: LinearGradient.grapeGradient,
                glow: Color.grape,
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
        return remaining <= 0 ? "¡Ya!" : Self.countdown(remaining, withSeconds: !collapsed)
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

/// Slim gradient strip (map).
private struct CompetitionCompactStrip: View {
    let emoji: String
    let title: String
    let subtitle: String?
    let trailing: String?
    let gradient: LinearGradient
    let glow: Color
    let compact: Bool
    let showsChevron: Bool

    private var trailingStyle: Font.TextStyle { compact ? Font.TextStyle.caption : Font.TextStyle.subheadline }

    var body: some View {
        HStack(spacing: 10) {
            Text(emoji)
                .font(.system(size: compact ? 15 : 18))
                .frame(width: compact ? 28 : 34, height: compact ? 28 : 34)
                .background(Color.white.opacity(0.22), in: Circle())
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(.subheadline, design: .rounded, weight: .heavy))
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(.caption2, design: .rounded, weight: .semibold))
                        .opacity(0.88)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            if let trailing {
                Text(trailing)
                    .font(.system(trailingStyle, design: .rounded, weight: .heavy))
                    .monospacedDigit()
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Color.white.opacity(0.22), in: Capsule())
            }
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.heavy))
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 10)
        .padding(.vertical, compact ? 6 : 8)
        .background(gradient, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.white.opacity(0.22), lineWidth: 1))
        .shadow(color: glow.opacity(0.35), radius: 10, x: 0, y: 4)
    }
}

/// Big vibrant gradient card with a watermark symbol.
private struct CompetitionHeroCard<Content: View>: View {
    let gradient: LinearGradient
    let glow: Color
    let symbol: String
    @ViewBuilder let content: Content

    var body: some View {
        content
            .foregroundStyle(.white)
            .padding(DS.Spacing.xl)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background { backdrop }
            .clipShape(RoundedRectangle(cornerRadius: DS.Radius.card + 2, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: DS.Radius.card + 2, style: .continuous).strokeBorder(Color.white.opacity(0.2), lineWidth: 1))
            .shadow(color: glow.opacity(0.35), radius: 16, x: 0, y: 8)
    }

    private var backdrop: some View {
        ZStack(alignment: .topTrailing) {
            Rectangle().fill(gradient)
            Circle()
                .fill(Color.white.opacity(0.10))
                .frame(width: 220, height: 220)
                .offset(x: 70, y: -110)
            Image(systemName: symbol)
                .font(.system(size: 120, weight: .black))
                .foregroundStyle(Color.white.opacity(0.14))
                .rotationEffect(.degrees(-14))
                .offset(x: 26, y: 14)
        }
        .accessibilityHidden(true)
    }
}

/// Small white-on-glass tag at the top of a hero card ("EN JUEGO").
struct CompetitionTag: View {
    let emoji: String
    let text: String

    var body: some View {
        HStack(spacing: 5) {
            Text(emoji)
            Text(text)
                .textCase(.uppercase)
                .tracking(0.8)
        }
        .font(.system(size: 11, weight: .heavy, design: .rounded))
        .foregroundStyle(.white)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Color.white.opacity(0.22), in: Capsule())
    }
}

private struct CompetitionUpcomingContent: View {
    let name: String
    let remaining: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CompetitionTag(emoji: "⚔️", text: "Próximamente")
            VStack(alignment: .leading, spacing: 4) {
                Text(name)
                    .font(.system(.title2, design: .rounded, weight: .heavy))
                    .lineLimit(2)
                Text(remaining > 0 ? "Todos contra todos. Calienta, que empieza en…" : "¡Arranca ya! Prepárate para correr.")
                    .font(.system(.subheadline, design: .rounded, weight: .medium))
                    .opacity(0.9)
            }
            if remaining > 0 {
                CompetitionCountdownBlocks(seconds: remaining)
            }
        }
    }
}

/// Days / hours / minutes / seconds tiles.
private struct CompetitionCountdownBlocks: View {
    let seconds: Double

    private var total: Int { max(0, Int(seconds)) }

    var body: some View {
        HStack(spacing: 8) {
            block(total / 86_400, label: "días")
            block((total % 86_400) / 3600, label: "horas")
            block((total % 3600) / 60, label: "min")
            block(total % 60, label: "seg")
        }
    }

    private func block(_ value: Int, label: String) -> some View {
        VStack(spacing: 1) {
            Text(String(format: "%02d", value))
                .font(Font.stat(26, weight: .heavy))
                .monospacedDigit()
            Text(label)
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .textCase(.uppercase)
                .tracking(0.6)
                .opacity(0.85)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(Color.white.opacity(0.18), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.white.opacity(0.18), lineWidth: 1))
    }
}

private struct CompetitionActiveContent: View {
    let name: String
    let day: Int?
    let totalDays: Int?
    let week: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                CompetitionTag(emoji: "🔥", text: "En juego")
                Spacer()
                if let week {
                    Text("Semana \(week)")
                        .font(.system(.caption, design: .rounded, weight: .bold))
                        .opacity(0.9)
                }
            }
            Text(name)
                .font(.system(.title2, design: .rounded, weight: .heavy))
                .lineLimit(2)
            if let day, let totalDays, totalDays > 0 {
                CompetitionDayProgress(day: day, total: totalDays)
            } else {
                Text("Gana quien tenga más territorio al final.")
                    .font(.system(.subheadline, design: .rounded, weight: .medium))
                    .opacity(0.9)
            }
        }
    }
}

/// "Día 12 de 28" + "Quedan 16 días" + progress bar.
private struct CompetitionDayProgress: View {
    let day: Int
    let total: Int

    private var fraction: Double { min(1, max(0, Double(day) / Double(total))) }
    private var left: Int { max(0, total - day) }
    private var leftText: String {
        if left == 0 { return "¡Último día!" }
        return left == 1 ? "Queda 1 día" : "Quedan \(left) días"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("Día \(day)")
                    .font(Font.stat(30, weight: .black))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                Text("de \(total)")
                    .font(.system(.headline, design: .rounded, weight: .semibold))
                    .opacity(0.85)
                Spacer(minLength: 6)
                Text(leftText)
                    .font(.system(.caption, design: .rounded, weight: .heavy))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Color.white.opacity(0.22), in: Capsule())
            }
            bar
        }
    }

    private var bar: some View {
        Capsule()
            .fill(Color.white.opacity(0.25))
            .frame(height: 8)
            .overlay(alignment: .leading) {
                GeometryReader { proxy in
                    Capsule()
                        .fill(Color.white)
                        .frame(width: max(8, proxy.size.width * fraction))
                }
            }
            .accessibilityHidden(true)
    }
}

private struct CompetitionFinishedContent: View {
    let name: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CompetitionTag(emoji: "👑", text: "Finalizada")
            VStack(alignment: .leading, spacing: 4) {
                Text("¡\(name) ha terminado!")
                    .font(.system(.title2, design: .rounded, weight: .heavy))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text("Descubre quién se ha llevado la corona.")
                    .font(.system(.subheadline, design: .rounded, weight: .medium))
                    .opacity(0.9)
            }
            HStack(spacing: 6) {
                Text("Ver resultados")
                Image(systemName: "arrow.right")
            }
            .font(.system(.subheadline, design: .rounded, weight: .heavy))
            .foregroundStyle(Color.grape)
            .padding(.horizontal, 16)
            .frame(minHeight: 40)
            .background(Color.white, in: Capsule())
        }
    }
}

// MARK: - Treasures

/// Chest image with a pulsing halo in the rarity colour.
struct TreasureMarker: View {
    let treasure: Treasure
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let color = Rarity.color(treasure.rarity)
        ZStack {
            Circle()
                .fill(color.opacity(0.35))
                .frame(width: 46, height: 46)
                .scaleEffect(pulse ? 1.35 : 0.85)
                .opacity(pulse ? 0 : 0.9)
            Circle()
                .fill(.thinMaterial)
                .frame(width: 40, height: 40)
                .overlay(Circle().stroke(color, lineWidth: 2))
                .shadow(color: color.opacity(0.6), radius: 6)
            Image(Rarity.chestImage(treasure.rarity))
                .resizable()
                .scaledToFit()
                .frame(width: 30, height: 30)
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) {
                pulse = true
            }
        }
        .accessibilityLabel("Tesoro \(Rarity.label(treasure.rarity)): \(treasure.name)")
    }
}

/// Tapped treasure: power, rarity, description and time left.
struct TreasureDetailView: View {
    let treasure: Treasure
    @Environment(\.dismiss) private var dismiss

    private var tint: Color { Rarity.color(treasure.rarity) }

    var body: some View {
        VStack(spacing: 16) {
            header
            if let description = treasure.powerDescription, !description.isEmpty {
                Text(description)
                    .font(.subheadline)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 10) {
                timeLeft
                Spacer(minLength: 0)
            }
            Label("Pasa corriendo a menos de 100 m para recogerlo", systemImage: "figure.run")
                .font(.system(.footnote, design: .rounded, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("¡A por él!") { dismiss() }
                .buttonStyle(PrimaryButtonStyle(color: tint))
        }
        .padding(20)
        .presentationDetents([.height(360), .medium])
        .presentationDragIndicator(.visible)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            Image(Rarity.chestImage(treasure.rarity))
                .resizable()
                .scaledToFit()
                .frame(width: 58, height: 58)
                .frame(width: 76, height: 76)
                .background(
                    RadialGradient(colors: [tint.opacity(0.35), tint.opacity(0.08)], center: .center, startRadius: 2, endRadius: 44),
                    in: RoundedRectangle(cornerRadius: 20, style: .continuous)
                )
                .shadow(color: tint.opacity(0.35), radius: 10, x: 0, y: 4)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(treasure.emoji ?? "🎁").font(.title2)
                    Text(treasure.name)
                        .font(.system(.title3, design: .rounded, weight: .heavy))
                        .lineLimit(2)
                }
                RarityPill(rarity: treasure.rarity)
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var timeLeft: some View {
        if let expires = treasure.expiresDate {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let remaining = expires.timeIntervalSince(context.date)
                StatPill(
                    value: remaining > 0 ? Self.remaining(remaining) : "Expirado",
                    label: remaining > 0 ? "para que desaparezca" : nil,
                    systemImage: "hourglass",
                    tint: remaining > 0 ? Color.gold : Color.steal
                )
            }
        } else {
            StatPill(value: "Disponible hoy", systemImage: "hourglass", tint: Color.gold)
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
    /// 1 + layers × 0.5
    let level: Double

    var fillOpacity: Double { min(0.30 + level * 0.12, 0.65) }
}

/// Castle marker for a zone fortified several times.
struct CastleZone: Identifiable {
    let id: String
    let userId: String
    let coordinate: CLLocationCoordinate2D
    let level: Double
    let color: Color

    var levelText: String {
        level == level.rounded() ? String(Int(level)) : level.formatted(.number.precision(.fractionLength(1)).locale(Locale(identifier: "es_ES")))
    }
}

struct CastleMarker: View {
    let zone: CastleZone

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Text("🏰")
                .font(.title3)
                .padding(4)
                .background(.thinMaterial, in: Circle())
                .overlay(Circle().stroke(zone.color, lineWidth: 1.5))
            Text(zone.levelText)
                .font(.system(size: 10, weight: .heavy, design: .rounded))
                .monospacedDigit()
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                .background(zone.color, in: Capsule())
                .foregroundStyle(.white)
                .offset(x: 8, y: -6)
        }
        .accessibilityLabel("Fortaleza nivel \(zone.levelText)")
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

/// Name as shown in competition lists: "🎭 nickname" when a nickname is active.
struct CompetitorName: View {
    let user: UserRef
    var isMe = false
    var font: Font = .body

    var body: some View {
        if let nickname = user.nickname, !nickname.isEmpty {
            Text("🎭 \(nickname)")
                .font(font.weight(.semibold))
                .fontDesign(.rounded)
                .foregroundStyle(Color.pink)
                .lineLimit(1)
        } else {
            Text(isMe ? "\(user.name) (tú)" : user.name)
                .font(isMe ? font.weight(.bold) : font.weight(.medium))
                .fontDesign(.rounded)
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
        ZStack {
            CompetitionIntroBackground(page: page)
            VStack(spacing: 18) {
                topBar
                TabView(selection: $page) {
                    welcome.tag(0)
                    rules.tag(1)
                    treasures.tag(2)
                    finale.tag(3)
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                pageDots
                Button(isLastPage ? "¡A conquistar!" : "Siguiente") {
                    if isLastPage {
                        dismiss()
                    } else {
                        withAnimation(.snappy) { page += 1 }
                    }
                }
                .buttonStyle(PrimaryButtonStyle(color: isLastPage ? Color.gold : Color.steal))
                .sensoryFeedback(.impact(weight: .light), trigger: page)
            }
            .padding(20)
        }
        .foregroundStyle(.white)
        .environment(\.colorScheme, .dark)
    }

    private var topBar: some View {
        HStack {
            CompetitionTag(emoji: "⚔️", text: "Nueva competición")
            Spacer()
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.subheadline.weight(.bold))
                    .frame(width: 34, height: 34)
                    .background(Color.white.opacity(0.14), in: Circle())
            }
            .foregroundStyle(Color.white.opacity(0.85))
            .accessibilityLabel("Cerrar")
        }
    }

    private var pageDots: some View {
        HStack(spacing: 6) {
            ForEach(0..<pageCount, id: \.self) { index in
                Capsule()
                    .fill(index == page ? Color.white : Color.white.opacity(0.3))
                    .frame(width: index == page ? 22 : 7, height: 7)
            }
        }
        .animation(.snappy, value: page)
        .accessibilityHidden(true)
    }

    private var welcome: some View {
        CompetitionIntroPage(emoji: "⚔️", title: store.competition?.name ?? "Competición", glow: Color.steal) {
            Text("Una competición épica de \(store.info?.totalDays ?? 28) días donde todos luchan contra todos por conquistar el mapa.")
                .font(.system(.body, design: .rounded, weight: .medium))
                .multilineTextAlignment(.center)
                .opacity(0.9)
            Text("Todos contra todos")
                .font(.system(.caption, design: .rounded, weight: .heavy))
                .textCase(.uppercase)
                .tracking(1)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(LinearGradient.stealGradient, in: Capsule())
                .shadow(color: Color.steal.opacity(0.5), radius: 10, x: 0, y: 4)
        }
    }

    private var rules: some View {
        CompetitionIntroPage(emoji: "📜", title: "Reglas del juego", glow: Color.brand) {
            VStack(spacing: 10) {
                CompetitionIntroRule(emoji: "🏃", text: "Corre para conquistar territorio: cada vuelta cerrada es tuya.")
                CompetitionIntroRule(emoji: "🗡️", text: "Puedes robar territorio a CUALQUIER participante, no solo a tus amigos.")
                CompetitionIntroRule(emoji: "🏰", text: "Volver a correr por tu zona la fortifica y cuesta más robarla.")
                CompetitionIntroRule(emoji: "📊", text: "Cada domingo a las 20:00 hay resumen semanal con premios.")
            }
        }
    }

    private var treasures: some View {
        CompetitionIntroPage(emoji: "💎", title: "Tesoros y poderes", glow: Color.grape) {
            Text("Cada día aparecen tesoros en el mapa. Pasa corriendo a menos de 100 m para recogerlos y conseguir poderes.")
                .font(.system(.subheadline, design: .rounded, weight: .medium))
                .multilineTextAlignment(.center)
                .opacity(0.9)
            ScrollView {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                    ForEach(powers, id: \.key) { item in
                        CompetitionIntroPowerTile(power: item.value)
                    }
                }
            }
            .scrollIndicators(.hidden)
        }
    }

    private var finale: some View {
        CompetitionIntroPage(emoji: "🏆", title: "¡A conquistar!", glow: Color.gold) {
            Text("Quien tenga más territorio al final de la competición gana. Sin excusas.")
                .font(.system(.body, design: .rounded, weight: .medium))
                .multilineTextAlignment(.center)
                .opacity(0.9)
            HStack(spacing: 14) {
                Text("🥈").font(.system(size: 40))
                Text("👑").font(.system(size: 56))
                Text("🥉").font(.system(size: 40))
            }
        }
    }
}

/// Night-sky gradient with soft coloured blobs that shift per page.
private struct CompetitionIntroBackground: View {
    let page: Int

    private var blobColor: Color {
        switch page {
        case 0: return Color.steal
        case 1: return Color.brand
        case 2: return Color.grape
        default: return Color.gold
        }
    }

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 0.05, green: 0.08, blue: 0.10), Color(red: 0.10, green: 0.07, blue: 0.20)],
                startPoint: .top,
                endPoint: .bottom
            )
            Circle()
                .fill(blobColor.opacity(0.45))
                .frame(width: 340, height: 340)
                .blur(radius: 90)
                .offset(x: -110, y: -260)
            Circle()
                .fill(Color.brand.opacity(0.25))
                .frame(width: 300, height: 300)
                .blur(radius: 90)
                .offset(x: 140, y: 300)
        }
        .animation(.easeInOut(duration: 0.6), value: page)
        .ignoresSafeArea()
    }
}

private struct CompetitionIntroPage<Content: View>: View {
    let emoji: String
    let title: String
    let glow: Color
    @ViewBuilder let content: Content

    @State private var floating = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 18) {
            ZStack {
                Circle()
                    .fill(RadialGradient(colors: [glow.opacity(0.55), glow.opacity(0.0)], center: .center, startRadius: 4, endRadius: 70))
                    .frame(width: 140, height: 140)
                Circle()
                    .fill(Color.white.opacity(0.08))
                    .frame(width: 104, height: 104)
                    .overlay(Circle().strokeBorder(Color.white.opacity(0.18), lineWidth: 1))
                Text(emoji).font(.system(size: 54))
            }
            .offset(y: floating ? -4 : 4)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true)) {
                    floating = true
                }
            }
            Text(title)
                .font(.system(.title, design: .rounded, weight: .heavy))
                .multilineTextAlignment(.center)
            content
            Spacer(minLength: 12)
        }
        .padding(.horizontal, 4)
        .padding(.top, 4)
    }
}

private struct CompetitionIntroRule: View {
    let emoji: String
    let text: String

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Text(emoji)
                .font(.title3)
                .frame(width: 40, height: 40)
                .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            Text(text)
                .font(.system(.subheadline, design: .rounded, weight: .medium))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
    }
}

private struct CompetitionIntroPowerTile: View {
    let power: PowerDefinition

    private var tint: Color { Rarity.color(power.rarity) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(power.emoji)
                Text(power.name)
                    .font(.system(.caption, design: .rounded, weight: .heavy))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Text(power.description)
                .font(.caption2)
                .opacity(0.78)
                .lineLimit(3, reservesSpace: true)
            Text(Rarity.label(power.rarity))
                .font(.system(size: 9, weight: .heavy, design: .rounded))
                .textCase(.uppercase)
                .tracking(0.6)
                .foregroundStyle(tint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(tint.opacity(0.20), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(tint.opacity(0.45), lineWidth: 1))
    }
}

// MARK: - Final results

/// Podium and places 4-10 when the competition has finished.
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
                    CompetitionFinalHero(competitionName: competitionName, winner: items.first, me: items.first(where: { $0.isMe }))
                    results
                    Button("¡Ha sido épico!") { dismiss() }
                        .buttonStyle(PrimaryButtonStyle(color: Color.grape))
                        .padding(.top, DS.Spacing.s)
                }
                .padding(.horizontal, DS.Spacing.l)
                .padding(.vertical, DS.Spacing.l)
            }
            .screenBackground()
            .navigationTitle("Resultados finales")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Cerrar")
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
                message: "Nadie llegó a conquistar territorio en esta competición.",
                tint: Color.grape
            )
            .card()
        } else {
            RankingBoardView(items: items, showsPosition: false)
        }
    }

    private func load() async {
        defer { isLoading = false }
        if let response = try? await APIClient.shared.request("GET", "/api/competition/leaderboard", as: CompetitionLeaderboardResponse.self) {
            entries = response.leaderboard.sorted { $0.totalArea > $1.totalArea }
        }
    }
}

/// Grape gradient header: competition over, champion and the user's final place.
private struct CompetitionFinalHero: View {
    let competitionName: String
    let winner: RankingItem?
    let me: RankingItem?

    var body: some View {
        VStack(spacing: 10) {
            Text("👑").font(.system(size: 56))
            Text("¡\(competitionName) ha terminado!")
                .font(.system(.title2, design: .rounded, weight: .heavy))
                .multilineTextAlignment(.center)
            if let winner {
                Text("Campeón: \(winner.hasNickname ? (winner.nickname ?? winner.name) : winner.name) · \(Format.area(winner.area))")
                    .font(.system(.subheadline, design: .rounded, weight: .bold))
                    .multilineTextAlignment(.center)
                    .opacity(0.92)
            }
            if let me {
                Text(me.rank == 1 ? "¡Has ganado! 🏆" : "Has terminado #\(me.rank)")
                    .font(.system(.caption, design: .rounded, weight: .heavy))
                    .textCase(.uppercase)
                    .tracking(0.8)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color.white.opacity(0.22), in: Capsule())
            }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 26)
        .padding(.horizontal, 20)
        .background(LinearGradient.grapeGradient, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .shadow(color: Color.grape.opacity(0.35), radius: 18, x: 0, y: 8)
        .accessibilityElement(children: .combine)
    }
}
