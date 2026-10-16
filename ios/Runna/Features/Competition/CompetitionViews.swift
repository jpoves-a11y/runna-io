import SwiftUI
import MapKit

// MARK: - Banner

/// Competition state: countdown before it starts, day counter while active, results link when finished.
struct CompetitionBanner: View {
    let store: CompetitionStore
    var onShowResults: () -> Void = {}

    @AppStorage("competition_banner_collapsed") private var collapsed = false

    var body: some View {
        if let competition = store.competition {
            if store.isUpcoming {
                upcoming(competition)
            } else if store.isActive {
                active(competition)
            } else if store.isFinished {
                finished(competition)
            }
        }
    }

    private func upcoming(_ competition: CompetitionInfo.Competition) -> some View {
        Button {
            withAnimation(.snappy) { collapsed.toggle() }
        } label: {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let remaining = remainingSeconds(competition, now: context.date)
                HStack(spacing: 8) {
                    Text("⚔️")
                    VStack(alignment: .leading, spacing: 1) {
                        Text(competition.name)
                            .font(.caption.weight(.bold))
                            .lineLimit(1)
                        if !collapsed {
                            Text("Comienza pronto...")
                                .font(.caption2)
                                .opacity(0.85)
                        }
                    }
                    Spacer(minLength: 6)
                    Text(remaining <= 0 ? "¡Ya!" : Self.countdown(remaining, withSeconds: !collapsed))
                        .font((collapsed ? Font.caption : Font.subheadline).weight(.heavy))
                        .monospacedDigit()
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, collapsed ? 6 : 9)
            .foregroundStyle(.white)
            .background(
                LinearGradient(colors: [.orange, .red], startPoint: .leading, endPoint: .trailing),
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(competition.name), comienza pronto")
        .task(id: competition.id) {
            // Reload the state when the countdown reaches zero, so the competition becomes active
            let wait = remainingSeconds(competition, now: Date())
            guard wait > 0 else { return }
            try? await Task.sleep(nanoseconds: UInt64((wait + 1) * 1_000_000_000))
            if Task.isCancelled { return }
            await store.refresh()
        }
    }

    private func active(_ competition: CompetitionInfo.Competition) -> some View {
        HStack(spacing: 8) {
            Text("🏆")
            Text(competition.name)
                .font(.caption.weight(.bold))
                .lineLimit(1)
            Spacer(minLength: 6)
            if let day = store.info?.dayOfCompetition, let total = store.info?.totalDays {
                Text("Día \(day)/\(total)")
                    .font(.caption2.weight(.heavy))
                    .monospacedDigit()
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.white.opacity(0.25), in: Capsule())
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .foregroundStyle(.white)
        .background(
            LinearGradient(colors: [Color.brand, Color(red: 0.05, green: 0.55, blue: 0.45)], startPoint: .leading, endPoint: .trailing),
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
        .accessibilityElement(children: .combine)
    }

    private func finished(_ competition: CompetitionInfo.Competition) -> some View {
        Button(action: onShowResults) {
            HStack(spacing: 8) {
                Text("👑")
                Text("¡\(competition.name) ha terminado! Toca para ver resultados")
                    .font(.caption.weight(.bold))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.caption.weight(.bold))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .foregroundStyle(.white)
            .background(
                LinearGradient(colors: [.purple, .indigo], startPoint: .leading, endPoint: .trailing),
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
        }
        .buttonStyle(.plain)
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

// MARK: - Treasures

/// Chest image with a pulsing halo in the rarity colour.
struct TreasureMarker: View {
    let treasure: Treasure
    @State private var pulse = false

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

    var body: some View {
        VStack(spacing: 14) {
            HStack(alignment: .center, spacing: 14) {
                Image(Rarity.chestImage(treasure.rarity))
                    .resizable()
                    .scaledToFit()
                    .frame(width: 64, height: 64)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Text(treasure.emoji ?? "🎁").font(.title2)
                        Text(treasure.name)
                            .font(.title3.weight(.bold))
                            .lineLimit(2)
                    }
                    RarityPill(rarity: treasure.rarity)
                }
                Spacer(minLength: 0)
            }
            if let description = treasure.powerDescription, !description.isEmpty {
                Text(description)
                    .font(.subheadline)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 6) {
                Text("⏳")
                if let expires = treasure.expiresDate {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let remaining = expires.timeIntervalSince(context.date)
                        Text(remaining > 0 ? Self.remaining(remaining) : "Expirado")
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(remaining > 0 ? Color.primary : Color.red)
                    }
                } else {
                    Text("Disponible hoy").font(.subheadline.weight(.semibold))
                }
                Spacer()
            }
            Label("Pasa corriendo a menos de 100 m para recogerlo", systemImage: "figure.run")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Entendido") { dismiss() }
                .buttonStyle(PrimaryButtonStyle(color: Rarity.color(treasure.rarity)))
        }
        .padding(20)
        .presentationDetents([.height(340), .medium])
        .presentationDragIndicator(.visible)
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
                .foregroundStyle(.pink)
                .lineLimit(1)
        } else {
            Text(isMe ? "\(user.name) (tú)" : user.name)
                .font(isMe ? font.weight(.bold) : font)
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
        let order = ["common": 0, "rare": 1, "epic": 2, "legendary": 3]
        return store.info?.treasurePowers
            .map { (key: $0.key, value: $0.value) }
            .sorted { (order[$0.value.rarity] ?? 0, $0.value.name) < (order[$1.value.rarity] ?? 0, $1.value.name) } ?? []
    }

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.06, green: 0.09, blue: 0.16), Color(red: 0.12, green: 0.08, blue: 0.22)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            VStack(spacing: 16) {
                HStack {
                    Spacer()
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill").font(.title2)
                    }
                    .foregroundStyle(.white.opacity(0.6))
                    .accessibilityLabel("Cerrar")
                }
                TabView(selection: $page) {
                    welcome.tag(0)
                    rules.tag(1)
                    treasures.tag(2)
                    finale.tag(3)
                }
                .tabViewStyle(.page(indexDisplayMode: .always))
                Button(page < pageCount - 1 ? "Siguiente" : "¡Vamos!") {
                    if page < pageCount - 1 {
                        withAnimation { page += 1 }
                    } else {
                        dismiss()
                    }
                }
                .buttonStyle(PrimaryButtonStyle(color: .orange))
            }
            .padding(20)
        }
        .foregroundStyle(.white)
    }

    private var welcome: some View {
        IntroPage(emoji: "⚔️", title: store.competition?.name ?? "Competición") {
            Text("Una competición épica de \(store.info?.totalDays ?? 28) días donde todos luchan contra todos por conquistar el mapa.")
                .multilineTextAlignment(.center)
            Text("TODOS CONTRA TODOS")
                .font(.caption.weight(.heavy))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.red.opacity(0.8), in: Capsule())
        }
    }

    private var rules: some View {
        IntroPage(emoji: "📜", title: "Reglas") {
            VStack(alignment: .leading, spacing: 14) {
                IntroRule(emoji: "🏃", text: "Corre para conquistar territorio: cada vuelta cerrada es tuya.")
                IntroRule(emoji: "🗡️", text: "Puedes robar territorio a CUALQUIER participante, no solo a tus amigos.")
                IntroRule(emoji: "🏰", text: "Volver a correr por tu zona la fortifica y cuesta más robarla.")
                IntroRule(emoji: "📊", text: "Cada domingo a las 20:00 hay resumen semanal con premios.")
            }
        }
    }

    private var treasures: some View {
        IntroPage(emoji: "💎", title: "Tesoros") {
            Text("Cada día aparecen tesoros en el mapa. Pasa corriendo a menos de 100 m para recogerlos y conseguir poderes.")
                .multilineTextAlignment(.center)
                .font(.subheadline)
            ScrollView {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    ForEach(powers, id: \.key) { item in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 4) {
                                Text(item.value.emoji)
                                Text(item.value.name)
                                    .font(.caption.weight(.bold))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.8)
                            }
                            Text(item.value.description)
                                .font(.caption2)
                                .opacity(0.75)
                                .lineLimit(3)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(Rarity.color(item.value.rarity).opacity(0.22), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                }
            }
        }
    }

    private var finale: some View {
        IntroPage(emoji: "🏆", title: "¡A conquistar!") {
            Text("Quien tenga más territorio al final de la competición gana.")
                .multilineTextAlignment(.center)
            Text("👑 👑 👑").font(.largeTitle)
        }
    }
}

private struct IntroPage<Content: View>: View {
    let emoji: String
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 16) {
            Text(emoji).font(.system(size: 60))
            Text(title)
                .font(.title.weight(.heavy))
                .multilineTextAlignment(.center)
            content
            Spacer(minLength: 24)
        }
        .padding(.horizontal, 4)
        .padding(.top, 8)
    }
}

private struct IntroRule: View {
    let emoji: String
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(emoji).font(.title3)
            Text(text).font(.subheadline)
            Spacer(minLength: 0)
        }
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

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    Text("👑 👑 👑").font(.largeTitle)
                    VStack(spacing: 4) {
                        Text("¡\(competitionName) ha terminado!")
                            .font(.title2.weight(.heavy))
                            .multilineTextAlignment(.center)
                        Text("Resultados finales")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    if isLoading {
                        ProgressView().padding(.top, 30)
                    } else if entries.isEmpty {
                        Text("Sin resultados")
                            .foregroundStyle(.secondary)
                            .padding(.top, 30)
                    } else {
                        podium
                        VStack(spacing: 0) {
                            ForEach(Array(entries.enumerated().dropFirst(3).prefix(7)), id: \.element.id) { index, entry in
                                HStack(spacing: 12) {
                                    Text("\(index + 1)")
                                        .font(.subheadline.weight(.bold))
                                        .foregroundStyle(.secondary)
                                        .frame(width: 26)
                                    AvatarView(name: entry.user.name, avatar: entry.user.avatar, color: entry.user.color, size: 32)
                                    CompetitorName(user: entry.user, isMe: entry.user.id == session.userId, font: .subheadline)
                                    Spacer()
                                    Text(Format.area(entry.totalArea))
                                        .font(.subheadline.weight(.semibold))
                                        .monospacedDigit()
                                }
                                .padding(.vertical, 8)
                                Divider()
                            }
                        }
                        .padding(.horizontal)
                    }
                    Button("¡Ha sido épico!") { dismiss() }
                        .buttonStyle(PrimaryButtonStyle(color: .purple))
                        .padding(.horizontal)
                        .padding(.top, 8)
                }
                .padding(.vertical)
            }
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

    private var podium: some View {
        HStack(alignment: .bottom, spacing: 10) {
            podiumStep(place: 2, height: 110, colors: [Color(white: 0.85), Color(white: 0.6)])
            podiumStep(place: 1, height: 160, colors: [.yellow, .orange])
            podiumStep(place: 3, height: 80, colors: [Color(red: 0.85, green: 0.55, blue: 0.3), Color(red: 0.6, green: 0.35, blue: 0.15)])
        }
        .padding(.horizontal)
    }

    @ViewBuilder
    private func podiumStep(place: Int, height: CGFloat, colors: [Color]) -> some View {
        VStack(spacing: 6) {
            if entries.count >= place {
                let entry = entries[place - 1]
                AvatarView(name: entry.user.name, avatar: entry.user.avatar, color: entry.user.color, size: place == 1 ? 56 : 44)
                CompetitorName(user: entry.user, isMe: entry.user.id == session.userId, font: .caption)
                Text(Format.area(entry.totalArea))
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(LinearGradient(colors: colors, startPoint: .top, endPoint: .bottom))
                .frame(height: height)
                .overlay(alignment: .top) {
                    Text(place == 1 ? "🥇" : (place == 2 ? "🥈" : "🥉"))
                        .font(.title)
                        .padding(.top, 8)
                }
        }
        .frame(maxWidth: .infinity)
    }

    private func load() async {
        defer { isLoading = false }
        if let response = try? await APIClient.shared.request("GET", "/api/competition/leaderboard", as: CompetitionLeaderboardResponse.self) {
            entries = response.leaderboard.sorted { $0.totalArea > $1.totalArea }
        }
    }
}
