import SwiftUI

/// "Resumen semanal": an editorial report of the latest week of the active competition
/// (title block, your week, award rows and the ranking list).
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
                } else {
                    EmptyStateView(
                        systemImage: "chart.bar.doc.horizontal",
                        title: "Aún no hay resumen",
                        message: "El resumen se publica cada domingo a las 20:00 mientras dura la competición."
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
            VStack(alignment: .leading, spacing: DS.Spacing.xxl) {
                WeeklyReportHeader(
                    weekNumber: summary.weekNumber,
                    competitionName: summary.competitionName ?? store.competition?.name ?? "Competición",
                    participantCount: summary.participantCount
                )
                myWeek(summary)
                awardsSection(summary)
                rankingSection(summary)
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
            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                SectionHeader(title: "Tu semana")
                WeeklyMyWeekCard(
                    rank: myEntry?.rank,
                    area: myEntry?.totalArea,
                    awardTitles: myAwards.map { $0.award.title }
                )
            }
        }
    }

    // MARK: Awards

    @ViewBuilder
    private func awardsSection(_ summary: WeeklySummary) -> some View {
        let awards = summary.orderedAwards
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Premios")
            if awards.isEmpty {
                Text("Los premios se están calculando. Vuelve en un rato.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .card()
            } else {
                awardsList(awards)
            }
        }
    }

    private func awardsList(_ awards: [(key: String, award: WeeklyAward)]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(awards.enumerated()), id: \.element.key) { index, item in
                if index > 0 {
                    HairlineDivider()
                        .padding(.leading, 52)
                }
                WeeklyAwardRow(awardKey: item.key, award: item.award, isMe: isMe(item.award.user))
            }
        }
        .background(Color.surface, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
        .hairlineBorder(radius: DS.Radius.card)
    }

    // MARK: Ranking

    @ViewBuilder
    private func rankingSection(_ summary: WeeklySummary) -> some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Clasificación")
            if summary.ranking.isEmpty {
                Text("Sin datos todavía.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .card()
            } else {
                RankingBoardView(items: rankingItems(summary), showsPosition: false, showsTopThree: false)
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
    /// SF Symbol for an award.
    static func symbol(_ key: String) -> String {
        switch key {
        case "mvp": return "star"
        case "territory_king": return "crown"
        case "conqueror": return "arrow.left.arrow.right"
        case "marathon": return "figure.run"
        case "consistent": return "calendar"
        case "treasure_hunter": return "shippingbox"
        case "precise": return "scope"
        case "social": return "person.2"
        default: return "medal"
        }
    }

    /// Only the MVP gets the #1 gold; everything else stays neutral.
    static func tint(_ key: String) -> Color {
        key == "mvp" ? Color.gold : Color.secondary
    }

    static func description(_ key: String) -> String {
        switch key {
        case "mvp": return "Mejor rendimiento global"
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

    /// Winner name as shown in the report (nickname when active).
    static func displayName(_ user: UserRef) -> String {
        if let nickname = user.nickname, !nickname.isEmpty { return nickname }
        return user.name
    }
}

// MARK: - Header

/// Editorial title block: label, "Semana N", competition and participants. No card, no colour.
private struct WeeklyReportHeader: View {
    let weekNumber: Int
    let competitionName: String
    let participantCount: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionLabel("Resumen semanal")
            Text("Semana \(weekNumber)")
                .font(Font.screenTitle)
                .tracking(DS.Tracking.title)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            HStack(spacing: 6) {
                Text(competitionName)
                    .lineLimit(1)
                if let participantCount, participantCount > 0 {
                    Text("·")
                    Text("\(participantCount) participante\(participantCount == 1 ? "" : "s")")
                        .monospacedDigit()
                        .lineLimit(1)
                }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, DS.Spacing.s)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Your week

/// Position · territory · awards, split by hairlines; award names underneath.
private struct WeeklyMyWeekCard: View {
    let rank: Int?
    let area: Double?
    let awardTitles: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            HStack(spacing: 0) {
                if let rank {
                    StatTile(value: "#\(rank)", label: "Puesto", tint: rank == 1 ? Color.gold : Color.primary)
                    StatDivider()
                }
                if let area {
                    let parts = Format.areaParts(area)
                    StatTile(value: parts.value, label: "Territorio", unit: parts.unit)
                    StatDivider()
                }
                StatTile(value: "\(awardTitles.count)", label: awardTitles.count == 1 ? "Premio" : "Premios")
            }
            if !awardTitles.isEmpty {
                HairlineDivider()
                Text(awardTitles.joined(separator: " · "))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .card(padding: 14)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Award rows

/// Award row: symbol · title + what it rewards + winner · value.
private struct WeeklyAwardRow: View {
    let awardKey: String
    let award: WeeklyAward
    let isMe: Bool

    var body: some View {
        HStack(alignment: .top, spacing: DS.Spacing.m) {
            Image(systemName: WeeklyAwardStyle.symbol(awardKey))
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(WeeklyAwardStyle.tint(awardKey))
                .frame(width: 24, height: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(award.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                let detail = WeeklyAwardStyle.description(awardKey)
                if !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                winner
                    .padding(.top, 3)
            }
            Spacer(minLength: DS.Spacing.s)
            Text(award.formattedValue)
                .font(Font.stat(17, weight: .semibold))
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
                .frame(maxWidth: 110, alignment: .trailing)
        }
        .padding(.horizontal, DS.Spacing.m)
        .padding(.vertical, DS.Spacing.m)
        .background(isMe ? Color.brand.opacity(0.07) : Color.clear)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var winner: some View {
        if let user = award.user {
            HStack(spacing: 6) {
                AvatarView(name: user.name, avatar: user.avatar, color: user.color, size: 20, ring: false)
                if user.nickname?.isEmpty == false {
                    Image(systemName: "theatermasks")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text(WeeklyAwardStyle.displayName(user))
                    .font(.footnote.weight(.medium))
                    .lineLimit(1)
                if isMe {
                    RankingMeBadge()
                }
            }
        } else {
            Text("Desierto")
                .font(.footnote)
                .foregroundStyle(.tertiary)
        }
    }
}
