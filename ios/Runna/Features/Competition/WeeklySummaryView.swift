import SwiftUI

/// "Resumen semanal": a celebratory, story-like recap of the latest week of the active competition
/// (hero, your week, awards and the top 10).
struct WeeklySummaryView: View {
    /// Already loaded (automatic popup); otherwise the view loads the latest one.
    var initialSummary: WeeklySummary?

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var summary: WeeklySummary?
    @State private var isLoading = true

    private var store: CompetitionStore { CompetitionStore.shared }

    var body: some View {
        NavigationStack {
            Group {
                if let summary {
                    content(summary)
                } else if isLoading {
                    ProgressView()
                        .controlSize(.large)
                } else {
                    EmptyStateView(
                        systemImage: "party.popper.fill",
                        title: "La fiesta aún no ha empezado",
                        message: "El resumen semanal se publica cada domingo a las 20:00 durante la competición.",
                        tint: Color.grape
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .screenBackground()
            .navigationTitle("Resumen semanal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .task { await load() }
        }
    }

    private func content(_ summary: WeeklySummary) -> some View {
        ScrollView {
            VStack(spacing: DS.Spacing.xxl) {
                WeeklyHeroCard(
                    weekNumber: summary.weekNumber,
                    competitionName: summary.competitionName ?? store.competition?.name ?? "la competición",
                    participantCount: summary.participantCount
                )
                myWeek(summary)
                awardsSection(summary)
                rankingSection(summary)
                Button("¡A por la próxima semana!") { dismiss() }
                    .buttonStyle(PrimaryButtonStyle(color: Color.grape))
            }
            .padding(.horizontal, DS.Spacing.l)
            .padding(.top, DS.Spacing.s)
            .padding(.bottom, DS.Spacing.xxl)
        }
    }

    // MARK: Your week

    @ViewBuilder
    private func myWeek(_ summary: WeeklySummary) -> some View {
        let myId = session.userId
        let myAwards = summary.orderedAwards.filter { $0.award.user?.id == myId && myId != nil }
        let myEntry = summary.ranking.first { $0.user?.id == myId && myId != nil }
        if myEntry != nil || !myAwards.isEmpty {
            WeeklyMyWeekCard(
                rank: myEntry?.rank,
                area: myEntry?.totalArea,
                awardTitles: myAwards.map { $0.award.title }
            )
        }
    }

    // MARK: Awards

    @ViewBuilder
    private func awardsSection(_ summary: WeeklySummary) -> some View {
        let awards = summary.orderedAwards
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            SectionHeader(title: "Premios de la semana", subtitle: "Los que más se lo han currado", systemImage: "medal.fill")
            if awards.isEmpty {
                Text("Los premios aún se están calculando. Vuelve en un rato 🍿")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .card()
            } else {
                awardsGrid(awards)
            }
        }
    }

    private func awardsGrid(_ awards: [(key: String, award: WeeklyAward)]) -> some View {
        let featured = awards.first { $0.key == "mvp" }
        let others = awards.filter { $0.key != "mvp" }
        let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]
        return VStack(spacing: 12) {
            if let featured {
                WeeklyFeaturedAwardCard(award: featured.award, isMe: isMe(featured.award.user))
            }
            LazyVGrid(columns: columns, spacing: 12) {
                ForEach(others, id: \.key) { item in
                    WeeklyAwardCard(
                        awardKey: item.key,
                        award: item.award,
                        isMe: isMe(item.award.user)
                    )
                }
            }
        }
    }

    // MARK: Ranking

    @ViewBuilder
    private func rankingSection(_ summary: WeeklySummary) -> some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            SectionHeader(title: "Clasificación", subtitle: "Así queda la tabla esta semana", systemImage: "trophy.fill")
            if summary.ranking.isEmpty {
                Text("Sin datos aún")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .card()
            } else {
                RankingBoardView(items: rankingItems(summary), showsPosition: false)
            }
        }
    }

    private func rankingItems(_ summary: WeeklySummary) -> [RankingItem] {
        var items: [RankingItem] = []
        for entry in summary.ranking {
            guard let user = entry.user else { continue }
            items.append(RankingItem(user: user, rank: entry.rank, area: entry.totalArea, stolen: entry.areaStolen, isMe: user.id == session.userId))
        }
        return items
    }

    private func isMe(_ user: UserRef?) -> Bool {
        guard let user, let myId = session.userId else { return false }
        return user.id == myId
    }

    private func load() async {
        defer { isLoading = false }
        if let initialSummary {
            summary = initialSummary
            return
        }
        if store.info == nil {
            await store.refresh()
        }
        summary = await store.latestWeeklySummary()
        if let summary, let competitionId = store.competition?.id {
            CompetitionSeen.markWeek(competitionId, summary.weekNumber)
        }
    }
}

// MARK: - Award catalogue

enum WeeklyAwardStyle {
    static func emoji(_ key: String) -> String {
        switch key {
        case "mvp": return "🌟"
        case "territory_king": return "👑"
        case "conqueror": return "🗡️"
        case "marathon": return "🏃"
        case "consistent": return "📅"
        case "treasure_hunter": return "💎"
        case "precise": return "🎯"
        case "social": return "🤝"
        default: return "🏅"
        }
    }

    static func tint(_ key: String) -> Color {
        switch key {
        case "mvp", "territory_king", "treasure_hunter": return Color.gold
        case "conqueror", "precise": return Color.steal
        case "marathon", "social": return Color.sky
        case "consistent": return Color.brand
        default: return Color.grape
        }
    }

    static func description(_ key: String) -> String {
        switch key {
        case "mvp": return "La mejor combinación de todo"
        case "territory_king": return "Más territorio"
        case "conqueror": return "Más área robada"
        case "marathon": return "Más distancia"
        case "consistent": return "Más actividades"
        case "treasure_hunter": return "Más tesoros"
        case "precise": return "Más rivales distintos atacados"
        case "social": return "Más carreras en compañía"
        default: return ""
        }
    }
}

// MARK: - Hero

/// Grape gradient "story" cover: week number, competition and confetti.
private struct WeeklyHeroCard: View {
    let weekNumber: Int
    let competitionName: String
    let participantCount: Int?

    @State private var appeared = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 10) {
            Text("🎉")
                .font(.system(size: 54))
                .scaleEffect(appeared ? 1 : 0.4)
                .rotationEffect(.degrees(appeared ? 0 : -30))
            CompetitionTag(emoji: "📊", text: "Resumen semanal")
            Text("Semana \(weekNumber)")
                .font(Font.stat(44, weight: .black))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(competitionName)
                .font(.system(.headline, design: .rounded, weight: .semibold))
                .multilineTextAlignment(.center)
                .opacity(0.92)
            if let participantCount, participantCount > 0 {
                Text("\(participantCount) corredor\(participantCount == 1 ? "" : "es") en liza")
                    .font(.system(.caption, design: .rounded, weight: .heavy))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color.white.opacity(0.22), in: Capsule())
            }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 28)
        .padding(.horizontal, 20)
        .background { WeeklyConfettiBackground() }
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .shadow(color: Color.grape.opacity(0.35), radius: 18, x: 0, y: 8)
        .accessibilityElement(children: .combine)
        .onAppear {
            if reduceMotion {
                appeared = true
            } else {
                withAnimation(.spring(response: 0.55, dampingFraction: 0.55).delay(0.1)) {
                    appeared = true
                }
            }
        }
    }
}

private struct WeeklyConfettiBackground: View {
    private struct Piece: Identifiable {
        let id: Int
        let emoji: String
        let x: CGFloat
        let y: CGFloat
        let size: CGFloat
        let angle: Double
    }

    private static let pieces: [Piece] = [
        Piece(id: 0, emoji: "✨", x: -140, y: -90, size: 22, angle: -10),
        Piece(id: 1, emoji: "🏆", x: 135, y: -80, size: 30, angle: 14),
        Piece(id: 2, emoji: "⚡", x: -150, y: 70, size: 24, angle: 18),
        Piece(id: 3, emoji: "🔥", x: 145, y: 75, size: 24, angle: -12),
        Piece(id: 4, emoji: "💎", x: -95, y: 120, size: 18, angle: 8),
        Piece(id: 5, emoji: "🎯", x: 100, y: -130, size: 18, angle: -20)
    ]

    var body: some View {
        ZStack {
            Rectangle().fill(LinearGradient.grapeGradient)
            RadialGradient(colors: [Color.gold.opacity(0.35), Color.clear], center: .top, startRadius: 4, endRadius: 220)
            Circle()
                .fill(Color.white.opacity(0.08))
                .frame(width: 260, height: 260)
                .offset(x: 140, y: 120)
            ForEach(Self.pieces) { piece in
                Text(piece.emoji)
                    .font(.system(size: piece.size))
                    .rotationEffect(.degrees(piece.angle))
                    .opacity(0.55)
                    .offset(x: piece.x, y: piece.y)
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Your week

private struct WeeklyMyWeekCard: View {
    let rank: Int?
    let area: Double?
    let awardTitles: [String]

    private var headline: String {
        if !awardTitles.isEmpty {
            let count = awardTitles.count
            return count == 1 ? "¡Te llevas un premio! 🏅" : "¡Te llevas \(count) premios! 🏅"
        }
        if let rank, rank <= 3 { return "¡Semana de podio! 🔥" }
        return "Tu semana"
    }

    var body: some View {
        HStack(spacing: 14) {
            if let rank {
                Text("#\(rank)")
                    .font(Font.stat(20, weight: .black))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .foregroundStyle(.white)
                    .frame(width: 58, height: 58)
                    .background(LinearGradient.goldGradient, in: Circle())
                    .shadow(color: Color.gold.opacity(0.4), radius: 8, x: 0, y: 4)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Tu semana")
                    .statLabelStyle()
                Text(headline)
                    .font(.system(.headline, design: .rounded, weight: .bold))
                if !awardTitles.isEmpty {
                    Text(awardTitles.joined(separator: " · "))
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Color.gold)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let area {
                    Text("Has sumado \(Format.area(area)) de territorio.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .card(padding: 14)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Award cards

/// Full-width golden card for the MVP.
private struct WeeklyFeaturedAwardCard: View {
    let award: WeeklyAward
    let isMe: Bool

    var body: some View {
        HStack(spacing: 14) {
            Text(WeeklyAwardStyle.emoji("mvp"))
                .font(.system(size: 50))
                .shadow(color: Color.black.opacity(0.2), radius: 6, x: 0, y: 3)
            VStack(alignment: .leading, spacing: 4) {
                Text("MVP de la semana")
                    .font(.system(size: 11, weight: .heavy, design: .rounded))
                    .textCase(.uppercase)
                    .tracking(0.8)
                    .opacity(0.9)
                Text(award.title)
                    .font(.system(.title3, design: .rounded, weight: .heavy))
                    .lineLimit(2)
                winner
            }
            Spacer(minLength: 4)
            Text(award.formattedValue)
                .font(Font.stat(18, weight: .heavy))
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
        }
        .foregroundStyle(.white)
        .padding(DS.Spacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(LinearGradient.goldGradient, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous).strokeBorder(Color.white.opacity(isMe ? 0.9 : 0.25), lineWidth: isMe ? 2.5 : 1))
        .shadow(color: Color.gold.opacity(0.4), radius: 14, x: 0, y: 6)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var winner: some View {
        if let user = award.user {
            HStack(spacing: 6) {
                AvatarView(name: user.name, avatar: user.avatar, color: user.color, size: 24)
                Text(WeeklyAwardCard.displayName(user, isMe: isMe))
                    .font(.system(.subheadline, design: .rounded, weight: .bold))
                    .lineLimit(1)
            }
        } else {
            Text("Desierto")
                .font(.system(.subheadline, design: .rounded, weight: .semibold))
                .opacity(0.85)
        }
    }
}

/// Award card: big emoji, title, what it rewards, winner and value.
private struct WeeklyAwardCard: View {
    let awardKey: String
    let award: WeeklyAward
    let isMe: Bool

    private var tint: Color { WeeklyAwardStyle.tint(awardKey) }
    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous) }

    static func displayName(_ user: UserRef, isMe: Bool) -> String {
        if let nickname = user.nickname, !nickname.isEmpty { return "🎭 \(nickname)" }
        return isMe ? "\(user.name) (tú)" : user.name
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Text(WeeklyAwardStyle.emoji(awardKey))
                    .font(.system(size: 38))
                Spacer(minLength: 0)
                if isMe {
                    RankingMeBadge()
                }
            }
            Text(award.title)
                .font(Font.cardTitle)
                .lineLimit(2, reservesSpace: true)
                .minimumScaleFactor(0.85)
            Text(WeeklyAwardStyle.description(awardKey))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(2, reservesSpace: true)
            winner
            Text(award.formattedValue)
                .font(Font.stat(19, weight: .heavy))
                .monospacedDigit()
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            shape
                .fill(LinearGradient(colors: [tint.opacity(0.16), tint.opacity(0.04)], startPoint: .topLeading, endPoint: .bottomTrailing))
                .background(shape.fill(Color.surface))
        }
        .overlay(shape.strokeBorder(isMe ? tint : tint.opacity(0.25), lineWidth: isMe ? 2 : 1))
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var winner: some View {
        if let user = award.user {
            HStack(spacing: 6) {
                AvatarView(name: user.name, avatar: user.avatar, color: user.color, size: 22)
                Text(Self.displayName(user, isMe: isMe))
                    .font(.system(.footnote, design: .rounded, weight: .bold))
                    .foregroundStyle(user.nickname?.isEmpty == false ? Color.pink : Color.primary)
                    .lineLimit(1)
            }
        } else {
            Text("Desierto")
                .font(.system(.footnote, design: .rounded, weight: .semibold))
                .foregroundStyle(.secondary)
        }
    }
}
