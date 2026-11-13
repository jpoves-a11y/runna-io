import SwiftUI

// MARK: - Mode theme

/// Colours and emblem of each competition mode: the banner, the map header and the phase chip.
struct ModeTheme {
    let colors: [Color]
    let symbol: String

    var accent: Color { colors.last ?? .brand }
    var gradient: LinearGradient {
        LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    init(mode: String) {
        func hex(_ a: String, _ b: String) -> [Color] { [Color(hex: a), Color(hex: b)] }
        switch mode {
        case "teams": colors = hex("#1E3A8A", "#3B82F6")
        case "target": colors = hex("#0F5F59", "#14B8A6")
        case "duel": colors = hex("#3B1A7A", "#7C3AED")
        case "derby": colors = hex("#7A1446", "#DB2777")
        case "flags": colors = hex("#8A3B0B", "#F59E0B")
        case "elimination": colors = hex("#1A1215", "#B91C1C")
        case "explorers": colors = hex("#12452A", "#22C55E")
        default: colors = hex("#8E1B1B", "#F97316")
        }
        symbol = ModeTheme.filledSymbol(mode)
    }

    static func filledSymbol(_ mode: String) -> String {
        switch mode {
        case "teams": return "person.2.fill"
        case "target": return "scope"
        case "duel": return "flag.2.crossed.fill"
        case "derby": return "sportscourt.fill"
        case "flags": return "flag.fill"
        case "elimination": return "flame.fill"
        case "explorers": return "safari.fill"
        default: return "bolt.shield.fill"
        }
    }
}

// MARK: - Chest projection

/// The chest each tier gives and the chest I'd get if the competition ended now. Mirrors
/// finishInternal / finishDuel in worker/src/season.ts.
struct ChestProjection {
    struct Tier: Identifiable {
        let rarity: String
        let label: String
        var id: String { rarity }
    }

    let tiers: [Tier]
    /// Index in `tiers` of the chest I'd get now (nil = none, e.g. not taking part)
    let current: Int?

    init(competition c: ClubCompetition, userId: String?) {
        let me = c.standings.first { $0.userId == userId }
        switch c.mode {
        case "teams":
            tiers = [Tier(rarity: "common", label: "Derrota"), Tier(rarity: "rare", label: "Empate"), Tier(rarity: "epic", label: "Victoria")]
            let mine = c.teams.first { $0.index == c.myTeam }?.score ?? 0
            let other = c.teams.first { $0.index != c.myTeam }?.score ?? 0
            current = c.myTeam == nil ? nil : (mine > other ? 2 : mine == other ? 1 : 0)
        case "duel", "derby":
            tiers = [Tier(rarity: "common", label: "Derrota"), Tier(rarity: "rare", label: "Empate"), Tier(rarity: "epic", label: "Victoria")]
            if let duel = c.duel {
                current = duel.myClubScore > duel.opponentScore ? 2 : duel.myClubScore == duel.opponentScore ? 1 : 0
            } else {
                current = nil
            }
        case "target":
            tiers = [Tier(rarity: "common", label: "Sin llegar"), Tier(rarity: "rare", label: "Objetivo"), Tier(rarity: "epic", label: "×1,5")]
            if let target = c.target {
                current = target.total >= target.target * 1.5 ? 2 : target.achieved ? 1 : 0
            } else {
                current = nil
            }
        case "elimination":
            tiers = [
                Tier(rarity: "common", label: "Cortes 1-2"), Tier(rarity: "rare", label: "Cortes 3+"),
                Tier(rarity: "epic", label: "Final"), Tier(rarity: "legendary", label: "Último"),
            ]
            if me == nil {
                current = nil
            } else if let cut = c.elimination?.myCut ?? me?.eliminatedCut {
                let total = c.elimination?.totalCuts ?? 5
                current = cut >= total ? 2 : cut >= 3 ? 1 : 0
            } else {
                current = 3
            }
        default:
            tiers = [
                Tier(rarity: "common", label: "4º+"), Tier(rarity: "rare", label: "3º"),
                Tier(rarity: "epic", label: "2º"), Tier(rarity: "legendary", label: "1º"),
            ]
            if let rank = c.myRank {
                current = rank == 1 ? 3 : rank == 2 ? 2 : rank == 3 ? 1 : 0
            } else {
                current = nil
            }
        }
    }

    var currentRarity: String? { current.map { tiers[$0].rarity } }
}

// MARK: - Hero

/// My club competition as a season pass: a banner in the mode's colours with the countdown and the
/// podium (or the scoreboard), the chest I'm playing for, and the rest of the table.
struct CompetitionHero: View {
    let competition: ClubCompetition
    let userId: String?
    var countdown: String? = nil
    var myClubCrest: Crest? = nil
    var maxRows: Int = 10
    var onSelectUser: ((String) -> Void)? = nil

    private var theme: ModeTheme { ModeTheme(mode: competition.mode) }
    private var isIndividual: Bool { ["ffa", "flags", "elimination", "explorers"].contains(competition.mode) }

    var body: some View {
        VStack(spacing: 0) {
            banner
            VStack(alignment: .leading, spacing: DS.Spacing.l) {
                ChestTrack(projection: ChestProjection(competition: competition, userId: userId), accent: theme.accent)
                modeDetails
                table
            }
            .padding(DS.Spacing.l)
            .background(Color.surface)
        }
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline))
        .shadow(color: theme.colors[0].opacity(0.25), radius: 16, x: 0, y: 8)
    }

    // MARK: Banner

    private var banner: some View {
        VStack(spacing: DS.Spacing.l) {
            HStack(alignment: .center) {
                Label(competition.isActive ? "Ronda \(competition.cycleNumber + 1)" : "Terminada", systemImage: competition.isActive ? "bolt.fill" : "checkmark.seal.fill")
                    .font(.caption.weight(.heavy))
                    .textCase(.uppercase)
                    .tracking(1)
                    .foregroundStyle(.white.opacity(0.85))
                Spacer(minLength: 8)
                if competition.isActive, let countdown {
                    Label(countdown, systemImage: "timer")
                        .font(.subheadline.weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(.black.opacity(0.25), in: Capsule())
                }
            }
            Text(competition.modeName.uppercased())
                .font(.system(size: 26, weight: .black).width(.condensed))
                .tracking(1.2)
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
            if !competition.isActive {
                Text(competition.resultLine(userId: userId))
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            stage
        }
        .padding(DS.Spacing.l)
        .padding(.bottom, 4)
        .background {
            ZStack {
                theme.gradient
                DiagonalStripes()
                    .stroke(.white.opacity(0.06), lineWidth: 10)
                Image(systemName: theme.symbol)
                    .font(.system(size: 150, weight: .black))
                    .foregroundStyle(.white.opacity(0.1))
                    .rotationEffect(.degrees(-12))
                    .offset(x: 110, y: -40)
            }
            .clipped()
        }
    }

    @ViewBuilder
    private var stage: some View {
        switch competition.mode {
        case "teams": teamsScoreboard
        case "duel", "derby": duelScoreboard
        case "target": targetRing
        default: podium
        }
    }

    // MARK: Podium

    private var podium: some View {
        let top = Array(competition.standings.prefix(3))
        let order: [Int] = [1, 0, 2].filter { $0 < top.count }
        return VStack(spacing: DS.Spacing.m) {
            if top.isEmpty {
                Text("Nadie ha puntuado todavía")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.85))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, DS.Spacing.l)
            } else {
                HStack(alignment: .bottom, spacing: DS.Spacing.s) {
                    ForEach(order, id: \.self) { index in
                        podiumColumn(top[index], place: index + 1)
                    }
                }
            }
            if let line = myPositionLine {
                Text(line)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.black.opacity(0.22), in: Capsule())
            }
        }
    }

    private func podiumColumn(_ standing: CompetitionStanding, place: Int) -> some View {
        let isMe = standing.userId == userId
        let avatar: CGFloat = place == 1 ? 58 : 46
        let medal: Color = place == 1 ? Color(hex: "#F5C542") : place == 2 ? Color(hex: "#D7DCE3") : Color(hex: "#D08A4E")
        return Button {
            onSelectUser?(standing.userId)
        } label: {
            VStack(spacing: 6) {
                if place == 1 {
                    Image(systemName: "crown.fill")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(medal)
                        .shadow(color: .black.opacity(0.3), radius: 2, y: 1)
                }
                AvatarView(name: standing.user?.name ?? "?", avatar: standing.user?.avatar, color: standing.user?.color ?? "#888888", size: avatar)
                    .overlay(alignment: .bottomTrailing) {
                        Text("\(place)")
                            .font(.system(size: 12, weight: .black))
                            .foregroundStyle(.black.opacity(0.75))
                            .frame(width: 20, height: 20)
                            .background(medal, in: Circle())
                            .overlay(Circle().strokeBorder(.white, lineWidth: 1.5))
                            .offset(x: 3, y: 3)
                    }
                Text(isMe ? "Tú" : (standing.user?.name ?? "Corredor"))
                    .font(.footnote.weight(isMe ? .heavy : .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                Text(competition.scoreText(standing.score))
                    .font(Font.stat(place == 1 ? 18 : 15, weight: .bold))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                // Pedestal
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(.white.opacity(isMe ? 0.32 : 0.16))
                    .frame(height: place == 1 ? 34 : place == 2 ? 22 : 14)
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(isMe ? .white.opacity(0.8) : .clear, lineWidth: 1.5)
                    )
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .disabled(onSelectUser == nil || isMe)
    }

    /// "Tú · 5º · a 0,12 km² del 4º" — or how far ahead the leader I am.
    private var myPositionLine: String? {
        guard competition.isActive, let rank = competition.myRank else { return nil }
        let standings = competition.standings
        guard let me = standings.first(where: { $0.userId == userId }) else { return nil }
        if competition.mode == "elimination", let cut = me.eliminatedCut {
            return "Caíste en el corte \(cut)"
        }
        if rank == 1 {
            guard let second = standings.first(where: { $0.rank == 2 }) else { return nil }
            return "Líder · +\(competition.scoreText(max(0, me.score - second.score))) sobre el 2º"
        }
        guard let ahead = standings.first(where: { $0.rank == rank - 1 }) else { return "Vas \(rank)º" }
        let gap = max(0, ahead.score - me.score)
        return rank > 3 ? "Tú · \(rank)º · a \(competition.scoreText(gap)) del \(rank - 1)º" : "A \(competition.scoreText(gap)) del \(rank - 1)º"
    }

    // MARK: Scoreboards

    private var teamsScoreboard: some View {
        let a = competition.teams.first { $0.index == 0 }
        let b = competition.teams.first { $0.index == 1 }
        return versus(
            left: (a?.name ?? "Equipo A", a?.score ?? 0, competition.myTeam == 0, nil),
            right: (b?.name ?? "Equipo B", b?.score ?? 0, competition.myTeam == 1, nil)
        )
    }

    @ViewBuilder
    private var duelScoreboard: some View {
        if let duel = competition.duel {
            versus(
                left: ("Tu club", duel.myClubScore, true, myClubCrest),
                right: (duel.opponent?.name ?? "Rival", duel.opponentScore, false, duel.opponent?.crest)
            )
        }
    }

    private func versus(left: (String, Double, Bool, Crest?), right: (String, Double, Bool, Crest?)) -> some View {
        let total = max(left.1 + right.1, 1)
        return VStack(spacing: DS.Spacing.m) {
            HStack(alignment: .center, spacing: DS.Spacing.s) {
                side(left)
                Text("VS")
                    .font(.system(size: 16, weight: .black).width(.condensed))
                    .foregroundStyle(.white.opacity(0.75))
                    .frame(width: 36, height: 36)
                    .background(.black.opacity(0.25), in: Circle())
                side(right)
            }
            GeometryReader { proxy in
                HStack(spacing: 2) {
                    Capsule().fill(.white)
                        .frame(width: max(6, proxy.size.width * left.1 / total))
                    Capsule().fill(.white.opacity(0.3))
                }
            }
            .frame(height: 8)
        }
    }

    private func side(_ item: (String, Double, Bool, Crest?)) -> some View {
        VStack(spacing: 4) {
            if let crest = item.3 {
                CrestView(crest: crest, size: 34)
            }
            Text(item.2 ? "\(item.0) · tú" : item.0)
                .font(.caption.weight(.heavy))
                .textCase(.uppercase)
                .foregroundStyle(.white.opacity(item.2 ? 1 : 0.8))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(Format.area(item.1))
                .font(Font.stat(24, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var targetRing: some View {
        if let target = competition.target {
            HStack(spacing: DS.Spacing.l) {
                ZStack {
                    Circle().stroke(.white.opacity(0.2), lineWidth: 10)
                    Circle()
                        .trim(from: 0, to: min(1, target.progress))
                        .stroke(.white, style: StrokeStyle(lineWidth: 10, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                    Text("\(Int((target.progress * 100).rounded()))%")
                        .font(Font.stat(22, weight: .bold))
                        .foregroundStyle(.white)
                }
                .frame(width: 92, height: 92)
                VStack(alignment: .leading, spacing: 4) {
                    Text(Format.area(target.total))
                        .font(Font.stat(26, weight: .bold))
                        .foregroundStyle(.white)
                    Text("de \(Format.area(target.target))")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.8))
                    if target.achieved {
                        Label("Conseguido", systemImage: "checkmark.seal.fill")
                            .font(.footnote.weight(.bold))
                            .foregroundStyle(.white)
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: Body

    @ViewBuilder
    private var modeDetails: some View {
        if competition.mode == "flags", !competition.flags.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(competition.flags) { flag in
                        let mine = flag.holderId == userId && userId != nil
                        Label(flag.name, systemImage: "flag.fill")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(mine ? Color.white : Color.primary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(
                                mine ? theme.accent : (flag.holder.map { Color(hex: $0.color).opacity(0.18) } ?? Color.surfaceRaised),
                                in: Capsule()
                            )
                    }
                }
            }
            .padding(.horizontal, -DS.Spacing.l)
            .contentMargins(.horizontal, DS.Spacing.l, for: .scrollContent)
        } else if competition.mode == "elimination", let elimination = competition.elimination {
            HStack(spacing: 0) {
                pill("\(elimination.alive)", "Siguen")
                pill("\(elimination.cuts.count)/\(elimination.totalCuts)", "Cortes")
                if let next = elimination.next, let date = APIDate.parse(next.at) {
                    pill(SeasonStore.shortRemaining(date.timeIntervalSinceNow), next.falls > 0 ? "Caen \(next.falls)" : "Próximo corte")
                }
            }
        }
    }

    private func pill(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(Font.stat(20, weight: .bold))
                .monospacedDigit()
            Text(label)
                .statLabelStyle()
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var table: some View {
        let rows = Array(competition.standings.dropFirst(isIndividual ? 3 : 0).prefix(maxRows))
        if !rows.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, standing in
                    if index > 0 { HairlineDivider() }
                    row(standing)
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ standing: CompetitionStanding) -> some View {
        let isMe = standing.userId == userId
        let content = HStack(spacing: DS.Spacing.m) {
            Text("\(standing.rank)")
                .font(.system(.subheadline, design: .rounded).weight(.heavy))
                .monospacedDigit()
                .foregroundStyle(isMe ? theme.accent : Color.secondary)
                .frame(minWidth: 22, alignment: .leading)
            AvatarView(name: standing.user?.name ?? "?", avatar: standing.user?.avatar, color: standing.user?.color ?? "#888888", size: 30)
            Text(isMe ? "Tú" : (standing.user?.name ?? "Corredor"))
                .font(.subheadline.weight(isMe ? .bold : .medium))
                .lineLimit(1)
            if standing.areaStolen > 0 {
                Image(systemName: "bolt.fill")
                    .font(.caption2)
                    .foregroundStyle(Color.steal)
                    .accessibilityLabel("Ha robado territorio")
            }
            Spacer(minLength: 4)
            if competition.mode == "elimination", let cut = standing.eliminatedCut {
                Text("Fuera · \(cut)º corte")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            } else {
                Text(competition.scoreText(standing.score))
                    .font(Font.stat(16, weight: .semibold))
                    .monospacedDigit()
            }
        }
        .padding(.vertical, 9)
        .padding(.horizontal, isMe ? 8 : 0)
        .background(isMe ? theme.accent.opacity(0.1) : Color.clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .contentShape(Rectangle())
        if let onSelectUser, !isMe {
            Button { onSelectUser(standing.userId) } label: { content }
                .buttonStyle(.plain)
        } else {
            content
        }
    }
}

// MARK: - Chest track

/// The chests of the competition in a row, linked by a progress line; the one I'd win now glows.
struct ChestTrack: View {
    let projection: ChestProjection
    let accent: Color
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            if !compact {
                HStack {
                    Text("Tu cofre")
                        .font(.caption.weight(.heavy))
                        .textCase(.uppercase)
                        .tracking(1)
                        .foregroundStyle(.secondary)
                    Spacer()
                    if let rarity = projection.currentRarity {
                        Text(Rarity.label(rarity))
                            .font(.subheadline.weight(.heavy))
                            .foregroundStyle(Rarity.color(rarity))
                    }
                }
            }
            ZStack {
                GeometryReader { proxy in
                    let count = max(projection.tiers.count, 1)
                    let step = proxy.size.width / CGFloat(count)
                    let start = step / 2
                    let end = proxy.size.width - step / 2
                    let reached = projection.current.map { start + step * CGFloat($0) } ?? start
                    Capsule().fill(Color.surfaceRaised)
                        .frame(width: end - start, height: 6)
                        .position(x: (start + end) / 2, y: 22)
                    Capsule().fill(accent)
                        .frame(width: max(0, reached - start), height: 6)
                        .position(x: start + max(0, reached - start) / 2, y: 22)
                        .opacity(projection.current == nil ? 0 : 1)
                }
                HStack(spacing: 0) {
                    ForEach(Array(projection.tiers.enumerated()), id: \.element.id) { index, tier in
                        chest(tier, index: index)
                            .frame(maxWidth: .infinity)
                    }
                }
            }
        }
    }

    private func chest(_ tier: ChestProjection.Tier, index: Int) -> some View {
        let isCurrent = projection.current == index
        let reached = (projection.current ?? -1) >= index
        let size: CGFloat = isCurrent ? 50 : 36
        return VStack(spacing: 4) {
            ZStack {
                if isCurrent {
                    Circle()
                        .fill(Rarity.color(tier.rarity).opacity(0.28))
                        .frame(width: 58, height: 58)
                        .blur(radius: 6)
                }
                Image(Rarity.chestImage(tier.rarity))
                    .resizable()
                    .scaledToFit()
                    .frame(width: size, height: size)
                    .saturation(reached ? 1 : 0.15)
                    .opacity(reached ? 1 : 0.55)
            }
            .frame(height: 44)
            .animation(.snappy, value: isCurrent)
            if !compact {
                Text(tier.label)
                    .font(.caption2.weight(isCurrent ? .heavy : .medium))
                    .foregroundStyle(isCurrent ? Color.primary : Color.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(Rarity.label(tier.rarity)): \(tier.label)\(isCurrent ? ", el que ganarías ahora" : "")")
    }
}

/// Faint diagonal lines for the banner background.
private struct DiagonalStripes: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let gap: CGFloat = 34
        var x = -rect.height
        while x < rect.width {
            path.move(to: CGPoint(x: x, y: rect.maxY))
            path.addLine(to: CGPoint(x: x + rect.height, y: rect.minY))
            x += gap
        }
        return path
    }
}
