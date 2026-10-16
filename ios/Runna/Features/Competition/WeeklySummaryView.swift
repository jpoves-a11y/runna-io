import SwiftUI

/// "Resumen semanal": the latest weekly summary of the active competition (top 10 and awards).
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
                        systemImage: "chart.bar",
                        title: "Aún no hay resumen",
                        message: "El resumen semanal se publica cada domingo a las 20:00 durante la competición."
                    )
                }
            }
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
            VStack(spacing: 20) {
                VStack(spacing: 4) {
                    Text("📊 Semana \(summary.weekNumber)")
                        .font(.title.weight(.heavy))
                    Text("Resumen semanal de \(summary.competitionName ?? store.competition?.name ?? "la competición")")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    if let count = summary.participantCount, count > 0 {
                        Text("\(count) participante\(count == 1 ? "" : "s")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.top, 8)

                rankingCard(summary)
                awardsCard(summary)
            }
            .padding()
        }
        .background(Color(.systemGroupedBackground))
    }

    private func rankingCard(_ summary: WeeklySummary) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("🏆 Clasificación")
                .font(.headline)
            if summary.ranking.isEmpty {
                Text("Sin datos aún")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(summary.ranking) { entry in
                    if let user = entry.user {
                        HStack(spacing: 12) {
                            Text(Self.medal(entry.rank))
                                .font(entry.rank <= 3 ? Font.title3 : Font.subheadline.weight(.bold))
                                .foregroundStyle(.secondary)
                                .frame(width: 30)
                            AvatarView(name: user.name, avatar: user.avatar, color: user.color, size: entry.rank <= 3 ? 38 : 32)
                            VStack(alignment: .leading, spacing: 1) {
                                CompetitorName(user: user, isMe: user.id == session.userId, font: .subheadline)
                                if entry.areaStolen > 0 {
                                    Text("🗡️ \(Format.area(entry.areaStolen)) robados")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer(minLength: 4)
                            Text(Format.area(entry.totalArea))
                                .font(.subheadline.weight(.semibold))
                                .monospacedDigit()
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
    }

    private func awardsCard(_ summary: WeeklySummary) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("🏅 Premios de la semana")
                .font(.headline)
            let awards = summary.orderedAwards
            if awards.isEmpty {
                Text("Premios pendientes de calcular")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(awards, id: \.key) { item in
                    HStack(alignment: .center, spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.award.title)
                                .font(.subheadline.weight(.semibold))
                            Text(Self.awardDescription(item.key))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 6)
                        VStack(alignment: .trailing, spacing: 2) {
                            if let user = item.award.user {
                                CompetitorName(user: user, isMe: user.id == session.userId, font: .subheadline)
                            } else {
                                Text("—").font(.subheadline).foregroundStyle(.secondary)
                            }
                            Text(item.award.formattedValue)
                                .font(.caption.weight(.semibold))
                                .monospacedDigit()
                                .foregroundStyle(.orange)
                        }
                    }
                    if item.key != awards.last?.key {
                        Divider()
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
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

    private static func medal(_ rank: Int) -> String {
        switch rank {
        case 1: return "🥇"
        case 2: return "🥈"
        case 3: return "🥉"
        default: return "\(rank)"
        }
    }

    private static func awardDescription(_ key: String) -> String {
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
