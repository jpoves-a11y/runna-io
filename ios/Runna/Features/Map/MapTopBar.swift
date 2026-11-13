import SwiftUI

/// One glass capsule at the top of the map: my avatar (opens my profile), my number and my place on
/// the map being shown, and the Global / Competición switch as two icons.
struct MapTopBar: View {
    @Environment(AppRouter.self) private var router
    let user: AppUser?
    @Binding var mode: MapMode
    let isLoading: Bool
    let season: SeasonStore
    let onTapStats: () -> Void

    @Namespace private var switchSpace

    private var competition: ClubCompetition? {
        guard let competition = season.competition, competition.isActive else { return nil }
        return competition
    }

    private var competitionTheme: ModeTheme { ModeTheme(mode: competition?.mode ?? season.cycle?.mode ?? "ffa") }

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            avatar
            Button(action: onTapStats) {
                HStack(spacing: DS.Spacing.s) {
                    value
                    Spacer(minLength: 4)
                    place
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Rectangle()
                .fill(Color.primary.opacity(0.12))
                .frame(width: 1, height: 26)
            modeSwitch
        }
        .padding(.leading, 8)
        .padding(.trailing, 6)
        .frame(height: 58)
        .glassSurface(Capsule())
        .animation(.snappy, value: mode)
        // Moving up a place in the competition
        .sensoryFeedback(trigger: competition?.myRank) { old, new in
            guard let old, let new, new < old else { return nil }
            return .success
        }
    }

    // MARK: Pieces

    @ViewBuilder
    private var avatar: some View {
        if let user {
            Button {
                router.showProfile = true
            } label: {
                AvatarView(name: user.name, avatar: user.avatar, color: user.color, size: 40)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Perfil y ajustes")
        } else {
            ProgressView()
                .frame(width: 40, height: 40)
        }
    }

    private var amount: Double {
        mode == .global ? (season.globalMe?.area ?? 0) : (competition?.myScore ?? 0)
    }

    private var value: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(mode == .global ? "Mapa global" : (competition?.modeName ?? "Competición"))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                if mode == .competition && competition == nil {
                    Text("Sin competición")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                } else if let competition, mode == .competition, competition.mode == "flags" {
                    Text(competition.scoreText(amount))
                        .font(Font.stat(22, weight: .semibold))
                        .contentTransition(.numericText(value: amount))
                } else {
                    let parts = Format.areaParts(amount)
                    Text(parts.value)
                        .font(Font.stat(22, weight: .semibold))
                        .monospacedDigit()
                        .contentTransition(.numericText(value: amount))
                    Text(parts.unit)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                if isLoading {
                    ProgressView().controlSize(.mini)
                }
            }
            .animation(.snappy, value: amount)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var place: some View {
        if mode == .competition, let competition, let rank = competition.myRank {
            HStack(alignment: .firstTextBaseline, spacing: 1) {
                Text("\(rank)º")
                    .font(Font.stat(22, weight: .bold))
                    .foregroundStyle(rank == 1 ? Color.gold : Color.primary)
                    .contentTransition(.numericText(value: Double(rank)))
                Text("/\(competition.participants)")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            .animation(.snappy, value: rank)
            .accessibilityLabel("Puesto \(rank) de \(competition.participants)")
        } else if mode == .global, let rank = season.globalMe?.worldRank {
            Text("#\(rank)")
                .font(Font.stat(22, weight: .bold))
                .foregroundStyle(rank == 1 ? Color.gold : Color.primary)
                .contentTransition(.numericText(value: Double(rank)))
                .accessibilityLabel("Puesto \(rank) del mundo")
        }
    }

    private var modeSwitch: some View {
        HStack(spacing: 2) {
            switchButton(.global, symbol: "globe.europe.africa.fill", tint: Color.brand)
            switchButton(.competition, symbol: competitionTheme.symbol, tint: competitionTheme.accent)
        }
        .padding(3)
        .background(Color.primary.opacity(0.05), in: Capsule())
        .accessibilityRepresentation {
            Picker("Mapa", selection: $mode) {
                ForEach(MapMode.allCases) { item in
                    Text(item.title).tag(item)
                }
            }
        }
    }

    private func switchButton(_ item: MapMode, symbol: String, tint: Color) -> some View {
        let selected = mode == item
        return Button {
            guard mode != item else { return }
            withAnimation(.snappy) { mode = item }
        } label: {
            VStack(spacing: 2) {
                Image(systemName: symbol)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(selected ? tint : Color.secondary)
                Circle()
                    .fill(selected ? tint : Color.clear)
                    .frame(width: 4, height: 4)
            }
            .frame(width: 40, height: 40)
            .background {
                if selected {
                    Capsule()
                        .fill(Color(uiColor: .systemBackground).opacity(0.9))
                        .shadow(color: .black.opacity(0.08), radius: 3, y: 1)
                        .matchedGeometryEffect(id: "selected", in: switchSpace)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.selection, trigger: selected)
        .accessibilityLabel(item.title)
    }
}
