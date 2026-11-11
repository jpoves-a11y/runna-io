import SwiftUI

struct RankingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router

    enum Board: Hashable { case global, competition, clubs }

    @State private var board: Board = .global
    @State private var model = RankingsModel.shared
    @State private var season = SeasonStore.shared
    @State private var selectedUserId: String?
    @State private var selectedClubId: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: DS.Spacing.l) {
                    Picker("Clasificación", selection: $board) {
                        Text("Global").tag(Board.global)
                        Text("Competición").tag(Board.competition)
                        Text("Clubes").tag(Board.clubs)
                    }
                    .pickerStyle(.segmented)
                    .sensoryFeedback(.selection, trigger: board)
                    switch board {
                    case .global: globalBoard
                    case .competition: competitionBoard
                    case .clubs: clubsBoard
                    }
                }
                .padding(.horizontal, DS.Spacing.l)
                .padding(.top, DS.Spacing.s)
                .padding(.bottom, DS.Spacing.xxl)
                .animation(.snappy, value: board)
            }
            .screenBackground()
            .navigationTitle("Ranking")
            .refreshable { await QuickRefresh.run { await load(force: true) } }
            .task(id: router.reloadSignal) {
                await load(force: model.reloadTracker.consume(router.reloadSignal))
            }
            .task(id: model.globalKey) { await model.loadGlobal(force: false) }
            .task(id: model.clubKey) {
                if board == .clubs { await model.loadClubs(force: false) }
            }
            .onChange(of: board) { _, newBoard in
                if newBoard == .clubs { Task { await model.loadClubs(force: false) } }
                if newBoard == .competition { Task { await season.load(force: false) } }
            }
            .sheet(item: Binding(
                get: { selectedUserId.map { RankedUser(id: $0) } },
                set: { selectedUserId = $0?.id }
            )) { user in
                UserProfileSheet(userId: user.id)
            }
            .sheet(item: Binding(
                get: { selectedClubId.map { RankedClub(id: $0) } },
                set: { selectedClubId = $0?.id }
            )) { club in
                ClubDetailSheet(clubId: club.id)
            }
        }
    }

    // MARK: Global

    private var globalBoard: some View {
        @Bindable var model = model
        return VStack(spacing: DS.Spacing.m) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(RankingsModel.GlobalScope.allCases) { scope in
                        ChipToggle(title: scope.title, isOn: model.globalScope == scope) {
                            model.globalScope = scope
                        }
                    }
                }
                .padding(.vertical, 2)
            }
            Picker("Periodo", selection: $model.period) {
                Text("Desde siempre").tag(RankingsModel.Period.all)
                Text("Este mes").tag(RankingsModel.Period.month)
            }
            .pickerStyle(.segmented)
            globalContent
        }
    }

    @ViewBuilder
    private var globalContent: some View {
        if let problem = model.globalProblem {
            problemCard(problem)
        } else if let ranking = model.globalRanking {
            if ranking.entries.isEmpty {
                EmptyStateView(
                    systemImage: "globe.europe.africa",
                    title: "Nadie en este ranking todavía",
                    message: "Sal a correr: cada carrera suma el área nueva que encierra a tu mapa global.",
                    actionTitle: "Ir al mapa",
                    action: { router.selectedTab = .map }
                )
                .card()
            } else {
                RankingBoardView(
                    items: globalItems(ranking),
                    showsPosition: ranking.entries.count > 1,
                    footnote: footnote(ranking),
                    onSelect: { item in open(item.id) }
                )
                if let rank = ranking.myRank, !ranking.entries.contains(where: { $0.user.id == session.userId }) {
                    Text("Tu puesto: \(rank)º con \(Format.area(ranking.myArea))")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .card()
                }
            }
        } else if let error = model.globalError {
            ErrorView(message: error) { Task { await model.loadGlobal(force: true) } }
        } else {
            RankingSkeleton()
        }
    }

    private func globalItems(_ ranking: GlobalRankingResponse) -> [RankingItem] {
        ranking.entries.map { entry in
            var item = RankingItem(user: entry.user.ref, rank: entry.rank, area: entry.area, isMe: entry.user.id == session.userId)
            let parts: [String?] = [entry.user.titleName, entry.club?.name]
            let detail = parts.compactMap { $0 }.joined(separator: " · ")
            item.detail = detail.isEmpty ? nil : detail
            return item
        }
    }

    private func footnote(_ ranking: GlobalRankingResponse) -> String {
        let place: String = ranking.label.isEmpty ? "" : " · \(ranking.label)"
        if ranking.period == "month" {
            return "Área nueva conquistada este mes\(place). Nadie te la puede quitar."
        }
        return "Área total del mapa global\(place). Solo se muestra el área, nunca los recorridos."
    }

    @ViewBuilder
    private func problemCard(_ problem: RankingsModel.Problem) -> some View {
        switch problem {
        case .needsLocation:
            EmptyStateView(
                systemImage: "mappin.and.ellipse",
                title: "Elige tu ciudad",
                message: "Para ver el ranking de tu país y de tu ciudad, indica en tu perfil dónde corres.",
                actionTitle: "Ir al perfil",
                action: { router.selectedTab = .profile }
            )
            .card()
        case .needsClub:
            EmptyStateView(
                systemImage: "shield.lefthalf.filled",
                title: "Únete a un club",
                message: "Compara tu mapa global con el de tus compañeros de club.",
                actionTitle: "Buscar clubes",
                action: { router.clubSection = .club; router.selectedTab = .club }
            )
            .card()
        }
    }

    // MARK: Competition

    @ViewBuilder
    private var competitionBoard: some View {
        if let competition = season.competition {
            CompetitionCard(competition: competition, userId: session.userId, maxRows: 50) { userId in
                open(userId)
            }
        } else if season.club == nil {
            EmptyStateView(
                systemImage: "flag.2.crossed",
                title: "La competición es por clubes",
                message: "Únete a un club o crea uno para competir cada dos semanas.",
                actionTitle: "Ir a Club",
                action: { router.clubSection = .club; router.selectedTab = .club }
            )
            .card()
        } else {
            EmptyStateView(
                systemImage: "clock",
                title: season.cycle?.isCompetition == true ? "Tu club no compite en esta ronda" : "Días de descanso",
                message: season.phaseCountdown ?? "La próxima competición empieza pronto.",
                actionTitle: nil,
                action: nil
            )
            .card()
        }
        if let last = season.current?.lastResult {
            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                SectionHeader(title: "Última competición")
                CompetitionCard(competition: last, userId: session.userId, maxRows: 10) { userId in
                    open(userId)
                }
            }
        }
    }

    // MARK: Clubs

    private var clubsBoard: some View {
        @Bindable var model = model
        return VStack(spacing: DS.Spacing.m) {
            HStack(spacing: 6) {
                ForEach(RankingsModel.ClubScope.allCases) { scope in
                    ChipToggle(title: scope.title, isOn: model.clubScope == scope) {
                        model.clubScope = scope
                    }
                }
                Spacer(minLength: 0)
            }
            Picker("Orden", selection: $model.clubSort) {
                Text("Liga").tag(RankingsModel.ClubSort.league)
                Text("Área de sus miembros").tag(RankingsModel.ClubSort.area)
            }
            .pickerStyle(.segmented)
            clubsContent
        }
    }

    @ViewBuilder
    private var clubsContent: some View {
        if let problem = model.clubProblem {
            problemCard(problem)
        } else if let ranking = model.clubRanking {
            if ranking.entries.isEmpty {
                EmptyStateView(systemImage: "shield", title: "Sin clubes todavía", message: "Crea el primero desde la pestaña Club.")
                    .card()
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(ranking.entries.enumerated()), id: \.element.id) { index, entry in
                        if index > 0 { HairlineDivider().padding(.leading, 52) }
                        Button {
                            selectedClubId = entry.club.id
                        } label: {
                            clubRow(entry, isMine: entry.club.id == ranking.myClubId)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .background(Color.surface)
                .clipShape(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
                .hairlineBorder(radius: DS.Radius.card)
                Text(model.clubSort == .league
                     ? "Puntos de liga: 3 por duelo ganado, 1 por empate, 2 por objetivo común conseguido y 1 si la mayoría del club corre."
                     : "Suma del área global de todos los miembros.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if let error = model.clubError {
            ErrorView(message: error) { Task { await model.loadClubs(force: true) } }
        } else {
            RankingSkeleton()
        }
    }

    private func clubRow(_ entry: ClubRankingResponse.Entry, isMine: Bool) -> some View {
        HStack(spacing: DS.Spacing.m) {
            Text("\(entry.rank)")
                .font(.system(.subheadline, design: .monospaced).weight(.medium))
                .foregroundStyle(isMine ? Color.brand : Color.secondary)
                .frame(minWidth: 24, alignment: .leading)
            CrestView(crest: entry.club.crest, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.club.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(clubDetail(entry.club))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: DS.Spacing.s)
            Text(model.clubSort == .league ? "\(Int(entry.score)) pts" : Format.area(entry.score))
                .font(Font.stat(17, weight: .semibold))
                .monospacedDigit()
        }
        .padding(.horizontal, DS.Spacing.l)
        .padding(.vertical, 10)
        .background(isMine ? Color.brand.opacity(0.07) : Color.clear)
        .contentShape(Rectangle())
    }

    private func clubDetail(_ club: ClubSummary) -> String {
        var parts: [String] = ["\(club.memberCount) miembros"]
        if let city = club.city { parts.append(city) }
        parts.append("nivel \(club.rating)")
        return parts.joined(separator: " · ")
    }

    // MARK: Actions

    /// Other players open their profile; the user's own row goes to the Profile tab.
    private func open(_ userId: String) {
        if userId == session.userId {
            router.selectedTab = .profile
        } else {
            selectedUserId = userId
        }
    }

    private func load(force: Bool = false) async {
        let rankings: RankingsModel = model
        let seasonStore: SeasonStore = season
        async let global: Void = rankings.loadGlobal(force: force)
        async let seasonLoad: Void = seasonStore.load(force: force)
        await global
        await seasonLoad
        if board == .clubs || force {
            await model.loadClubs(force: force)
        }
    }
}

/// Global and club leaderboards, kept across tab switches (stale-while-revalidate).
@MainActor
@Observable
final class RankingsModel {
    static let shared = RankingsModel()

    enum GlobalScope: String, CaseIterable, Identifiable {
        case world, country, city, friends, club
        var id: String { rawValue }
        var title: String {
            switch self {
            case .world: return "Mundo"
            case .country: return "País"
            case .city: return "Ciudad"
            case .friends: return "Amigos"
            case .club: return "Club"
            }
        }
    }

    enum ClubScope: String, CaseIterable, Identifiable {
        case world, country, city
        var id: String { rawValue }
        var title: String {
            switch self {
            case .world: return "Mundo"
            case .country: return "País"
            case .city: return "Ciudad"
            }
        }
    }

    enum Period: String { case all, month }
    enum ClubSort: String { case league, area }
    enum Problem { case needsLocation, needsClub }

    var globalScope: GlobalScope = .world
    var period: Period = .all
    var clubScope: ClubScope = .world
    var clubSort: ClubSort = .league

    private(set) var globalRanking: GlobalRankingResponse?
    private(set) var globalError: String?
    private(set) var globalProblem: Problem?
    private(set) var clubRanking: ClubRankingResponse?
    private(set) var clubError: String?
    private(set) var clubProblem: Problem?
    var reloadTracker = ReloadSignalTracker()

    private var globalResources: [String: CachedResource<GlobalRankingResponse>] = [:]
    private var clubResources: [String: CachedResource<ClubRankingResponse>] = [:]

    private init() {}

    var globalKey: String { "\(globalScope.rawValue)|\(period.rawValue)" }
    var clubKey: String { "\(clubScope.rawValue)|\(clubSort.rawValue)" }

    func reset() {
        globalResources = [:]
        clubResources = [:]
        globalRanking = nil
        globalError = nil
        globalProblem = nil
        clubRanking = nil
        clubError = nil
        clubProblem = nil
        reloadTracker = ReloadSignalTracker()
    }

    func loadGlobal(force: Bool) async {
        let key = globalKey
        let resource: CachedResource<GlobalRankingResponse>
        if let existing = globalResources[key] {
            resource = existing
        } else {
            resource = CachedResource("/api/rankings/global", query: ["scope": globalScope.rawValue, "period": period.rawValue])
            globalResources[key] = resource
            globalRanking = nil
        }
        globalProblem = nil
        if let cached = await resource.loadCached() ?? resource.value, key == globalKey {
            globalRanking = cached
        }
        if !force && resource.isFresh && globalRanking != nil { return }
        do {
            if let fresh = try await resource.fetch(), key == globalKey {
                withAnimation(.snappy) { globalRanking = fresh }
            }
            if key == globalKey { globalError = nil }
        } catch is CancellationError {
            return
        } catch let error as APIError where error.status == 409 {
            guard key == globalKey else { return }
            globalRanking = nil
            globalProblem = globalScope == .club ? .needsClub : .needsLocation
        } catch {
            if key == globalKey && globalRanking == nil { globalError = error.localizedDescription }
        }
    }

    func loadClubs(force: Bool) async {
        let key = clubKey
        let resource: CachedResource<ClubRankingResponse>
        if let existing = clubResources[key] {
            resource = existing
        } else {
            resource = CachedResource("/api/rankings/clubs", query: ["scope": clubScope.rawValue, "sort": clubSort.rawValue])
            clubResources[key] = resource
            clubRanking = nil
        }
        clubProblem = nil
        if let cached = await resource.loadCached() ?? resource.value, key == clubKey {
            clubRanking = cached
        }
        if !force && resource.isFresh && clubRanking != nil { return }
        do {
            if let fresh = try await resource.fetch(), key == clubKey {
                withAnimation(.snappy) { clubRanking = fresh }
            }
            if key == clubKey { clubError = nil }
        } catch is CancellationError {
            return
        } catch let error as APIError where error.status == 409 {
            guard key == clubKey else { return }
            clubRanking = nil
            clubProblem = .needsLocation
        } catch {
            if key == clubKey && clubRanking == nil { clubError = error.localizedDescription }
        }
    }
}

private struct RankedUser: Identifiable {
    let id: String
}

private struct RankedClub: Identifiable {
    let id: String
}
