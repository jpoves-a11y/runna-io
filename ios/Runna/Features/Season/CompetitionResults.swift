import Foundation
import Observation
import SwiftUI

// MARK: - Inbox

/// End-of-competition summaries the user hasn't seen yet (GET /api/season/results/pending).
/// Checked when the app opens, comes back to the foreground and when a push arrives; shown one
/// after another, and marked as seen when closed.
@MainActor
@Observable
final class SeasonResultsInbox {
    static let shared = SeasonResultsInbox()

    /// Oldest first.
    private(set) var queue: [CompetitionResultSummary] = []
    var current: CompetitionResultSummary? { queue.first }

    @ObservationIgnored private var isLoading = false
    @ObservationIgnored private var lastCheck: Date?
    /// Closed in this session (the server may still be marking them as seen).
    @ObservationIgnored private var closed: Set<String> = []

    private init() {}

    /// Screenshots in CI launch with a test session: there the window only shows on its own deep link.
    static var autoPopupDisabledForTests: Bool {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        return environment["RUNNA_TEST_TOKEN"] != nil && !(environment["RUNNA_TEST_DEEP_LINK"] ?? "").hasPrefix("runnaio://season/results")
        #else
        return false
        #endif
    }

    func refresh(force: Bool = false) async {
        guard !isLoading, !Self.autoPopupDisabledForTests else { return }
        if !force, let lastCheck, Date().timeIntervalSince(lastCheck) < 60 { return }
        isLoading = true
        defer { isLoading = false }
        guard let response: SeasonResultsPendingResponse = try? await APIClient.shared.request("GET", "/api/season/results/pending") else { return }
        lastCheck = Date()
        queue = response.results
            .filter { !closed.contains($0.id) }
            .sorted { $0.cycleNumber < $1.cycleNumber }
    }

    func markSeen(_ competitionId: String) {
        closed.insert(competitionId)
        queue.removeAll { $0.id == competitionId }
        Task { try? await APIClient.shared.send("POST", "/api/season/results/\(competitionId)/seen") }
    }

    /// Logout: forget everything.
    func reset() {
        queue = []
        lastCheck = nil
        closed = []
    }
}

extension View {
    /// Presents the end-of-competition summaries the user hasn't seen (never on top of a run being
    /// recorded, the onboarding or a conquest result).
    @MainActor
    func seasonResultsInbox() -> some View {
        modifier(SeasonResultsInboxModifier())
    }
}

@MainActor
private struct SeasonResultsInboxModifier: ViewModifier {
    @Environment(RunTracker.self) private var tracker
    @Environment(AppRouter.self) private var router
    @Environment(SessionStore.self) private var session
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(OnboardingView.doneKey) private var onboardingDone = false

    private var inbox: SeasonResultsInbox { SeasonResultsInbox.shared }

    private var presented: CompetitionResultSummary? {
        guard session.state == .loggedIn, !tracker.isPresented else { return nil }
        guard onboardingDone || OnboardingView.isDisabledForTests else { return nil }
        if router.selectedTab == .map && ConquestInbox.shared.current != nil { return nil }
        return inbox.current
    }

    func body(content: Content) -> some View {
        content
            .fullScreenCover(item: Binding<CompetitionResultSummary?>(
                get: { presented },
                // Closing goes through the window's own buttons, which mark it as seen
                set: { _ in }
            )) { summary in
                CompetitionResultsView(summary: summary) {
                    inbox.markSeen(summary.id)
                }
            }
            .task { await inbox.refresh(force: true) }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await inbox.refresh() } }
            }
            .onChange(of: router.reloadSignal) { _, _ in
                Task { await inbox.refresh(force: true) }
            }
    }
}

// MARK: - Window

/// Full-screen summary of a finished competition, in pages: the club's result, your numbers,
/// awards, rewards (chests to open) and the next competition.
@MainActor
struct CompetitionResultsView: View {
    let summary: CompetitionResultSummary
    let onDone: () -> Void

    @Environment(SessionStore.self) private var session
    @State private var page = 0
    @State private var opened: Set<String> = []

    private enum Page: Hashable { case club, mine, awards, rewards, next }

    private var pages: [Page] {
        var list: [Page] = [.club, .mine]
        if !summary.awards.isEmpty { list.append(.awards) }
        if !summary.rewards.isEmpty { list.append(.rewards) }
        if summary.next != nil { list.append(.next) }
        return list
    }

    private var isLast: Bool { page >= pages.count - 1 }

    var body: some View {
        NavigationStack {
            TabView(selection: $page) {
                ForEach(Array(pages.enumerated()), id: \.element) { index, item in
                    ScrollView {
                        pageContent(item)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, DS.Spacing.screen)
                            .padding(.top, DS.Spacing.l)
                            .padding(.bottom, DS.Spacing.xxl)
                    }
                    .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .animation(.snappy, value: page)
            .screenBackground()
            .safeAreaInset(edge: .bottom) { footer }
            .navigationTitle("Fin de la competición")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar", action: onDone)
                }
            }
        }
        .interactiveDismissDisabled()
        .onAppear(perform: openTestPage)
    }

    /// CI screenshots: runnaio://season/results/<awards|rewards|mine> opens on that page.
    private func openTestPage() {
        #if DEBUG
        guard let link = ProcessInfo.processInfo.environment["RUNNA_TEST_DEEP_LINK"], link.hasPrefix("runnaio://season/results/") else { return }
        var wanted: Page?
        switch String(link.split(separator: "/").last ?? "") {
        case "awards": wanted = .awards
        case "rewards": wanted = .rewards
        case "mine": wanted = .mine
        default: wanted = nil
        }
        if let wanted, let index = pages.firstIndex(of: wanted) {
            page = index
            if wanted == .rewards, let first = summary.rewards.first { opened = [first.id] }
        }
        #endif
    }

    // MARK: Footer

    private var footer: some View {
        VStack(spacing: DS.Spacing.m) {
            HStack(spacing: 6) {
                ForEach(pages.indices, id: \.self) { index in
                    Circle()
                        .fill(index == page ? Color.brand : Color(uiColor: .tertiaryLabel))
                        .frame(width: 6, height: 6)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Página \(page + 1) de \(pages.count)")
            Button(isLast ? "Hecho" : "Siguiente") {
                if isLast {
                    onDone()
                } else {
                    page += 1
                }
            }
            .buttonStyle(PrimaryButtonStyle())
        }
        .padding(.horizontal, DS.Spacing.screen)
        .padding(.top, DS.Spacing.m)
        .padding(.bottom, DS.Spacing.s)
        .background(Color.canvas.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { HairlineDivider() }
    }

    @ViewBuilder
    private func pageContent(_ item: Page) -> some View {
        switch item {
        case .club: clubPage
        case .mine: minePage
        case .awards: awardsPage
        case .rewards: rewardsPage
        case .next: nextPage
        }
    }

    // MARK: 1. The club

    private var clubPage: some View {
        let result = summary.clubResult
        return VStack(alignment: .leading, spacing: DS.Spacing.xxl) {
            HStack(spacing: DS.Spacing.m) {
                if let club = summary.club {
                    CrestView(crest: club.crest, size: 52)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(summary.club?.name ?? "Tu club")
                        .font(Font.cardTitle)
                    Text(summary.cycleNumber >= 0 ? "\(summary.modeName) · Ronda \(summary.cycleNumber + 1)" : summary.modeName)
                        .font(Font.meta)
                        .foregroundStyle(.secondary)
                }
            }
            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                Text(summary.headline(myUserId: session.userId))
                    .font(Font.screenTitle)
                    .tracking(DS.Tracking.title)
                    .fixedSize(horizontal: false, vertical: true)
                if let line = summary.scoreLine {
                    Text(line)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            if !result.podium.isEmpty {
                VStack(alignment: .leading, spacing: DS.Spacing.s) {
                    SectionLabel("Podio")
                    VStack(spacing: 0) {
                        ForEach(Array(result.podium.enumerated()), id: \.element.id) { index, runner in
                            if index > 0 { HairlineDivider() }
                            podiumRow(runner, position: runner.rank ?? index + 1)
                        }
                    }
                    .card(padding: DS.Spacing.m)
                }
            }
            HStack(spacing: 0) {
                StatTile(value: "+\(result.leaguePoints)", label: "Puntos de liga")
                if let change = result.ratingChange {
                    StatDivider()
                    StatTile(value: change >= 0 ? "+\(change)" : "\(change)", label: "Elo del club", tint: change < 0 ? .steal : .primary)
                }
                // In the individual modes the MVP is just the winner
                if let mvp = result.mvp, ["teams", "target", "duel", "derby"].contains(summary.mode) {
                    StatDivider()
                    VStack(spacing: 4) {
                        AvatarView(name: mvp.name, avatar: mvp.avatar, color: mvp.color, size: 28)
                        Text("MVP: \(mvp.name)")
                            .font(Font.statLabel)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .card(padding: DS.Spacing.l)
        }
    }

    private func podiumRow(_ runner: CompetitionResultSummary.Runner, position: Int) -> some View {
        HStack(spacing: DS.Spacing.m) {
            Text("\(position)")
                .font(Font.stat(17, weight: .semibold))
                .foregroundStyle(position == 1 ? Color.gold : Color.secondary)
                .frame(width: 20)
            AvatarView(name: runner.name, avatar: runner.avatar, color: runner.color, size: 32)
            Text(runner.id == session.userId ? "Tú" : runner.name)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            Spacer(minLength: DS.Spacing.s)
            if let score = runner.score {
                Text(summary.scoreText(score))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
        .padding(.vertical, DS.Spacing.s)
    }

    // MARK: 2. Your numbers

    @ViewBuilder
    private var minePage: some View {
        if let me = summary.me {
            VStack(alignment: .leading, spacing: DS.Spacing.xxl) {
                SectionLabel("Tu competición")
                VStack(alignment: .leading, spacing: DS.Spacing.xs) {
                    if let rank = me.rank {
                        HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.s) {
                            Text("\(rank)º")
                                .font(Font.statHero)
                                .foregroundStyle(rank == 1 ? Color.gold : Color.primary)
                                .monospacedDigit()
                            Text("de \(me.of)")
                                .font(Font.statUnit)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if let cut = me.eliminatedCut, summary.mode == "elimination" {
                        Text("Caíste en el corte \(cut)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                VStack(spacing: DS.Spacing.l) {
                    HStack(spacing: 0) {
                        StatTile(value: summary.scoreText(me.score), label: scoreLabel)
                        StatDivider()
                        StatTile(value: Format.distance(me.distance), label: "Distancia")
                    }
                    HairlineDivider().padding(.horizontal, DS.Spacing.s)
                    HStack(spacing: 0) {
                        StatTile(value: "\(me.runs)", label: me.runs == 1 ? "Carrera" : "Carreras")
                        StatDivider()
                        StatTile(value: "\(me.days)", label: me.days == 1 ? "Día con carrera" : "Días con carrera")
                    }
                    if stealingMode {
                        HairlineDivider().padding(.horizontal, DS.Spacing.s)
                        HStack(spacing: 0) {
                            StatTile(value: Format.area(me.areaStolen), label: "Robado")
                            StatDivider()
                            StatTile(value: Format.area(me.areaLost), label: "Perdido", tint: .steal)
                        }
                    }
                }
                .card(padding: DS.Spacing.l)
            }
        } else {
            VStack(alignment: .leading, spacing: DS.Spacing.m) {
                SectionLabel("Tu competición")
                VStack(alignment: .leading, spacing: DS.Spacing.s) {
                    Image(systemName: "figure.run")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text("No participaste")
                        .font(Font.cardTitle)
                    Text("No corriste en los 14 días anteriores al inicio. Corre para entrar en la próxima competición.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .card()
            }
        }
    }

    private var stealingMode: Bool { ["ffa", "teams", "duel", "derby", "elimination"].contains(summary.mode) }

    private var scoreLabel: String {
        switch summary.mode {
        case "flags": return "Con bandera"
        case "explorers": return "Mapa nuevo"
        default: return "Puntuación"
        }
    }

    // MARK: 3. Awards

    private var awardsPage: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.l) {
            SectionLabel(summary.awards.count == 1 ? "Un logro" : "\(summary.awards.count) logros")
            VStack(spacing: 0) {
                ForEach(Array(summary.awards.enumerated()), id: \.element.id) { index, award in
                    if index > 0 { HairlineDivider() }
                    HStack(alignment: .top, spacing: DS.Spacing.m) {
                        Image(systemName: award.symbol)
                            .font(.title3)
                            .foregroundStyle(Color.brand)
                            .frame(width: 32)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(award.name)
                                .font(Font.cardTitle)
                            Text(award.description)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, DS.Spacing.m)
                }
            }
            .card(padding: DS.Spacing.m)
            Text("Se guardan en tu perfil.")
                .font(Font.meta)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: 4. Rewards

    private var rewardsPage: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.l) {
            VStack(alignment: .leading, spacing: DS.Spacing.xs) {
                SectionLabel("Recompensas")
                Text(opened.count < summary.rewards.count ? "Toca un cofre para abrirlo." : "Ya están en tu inventario.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: DS.Spacing.m), GridItem(.flexible(), spacing: DS.Spacing.m)], spacing: DS.Spacing.m) {
                ForEach(summary.rewards) { item in
                    RewardChestCell(item: item, isOpen: opened.contains(item.id)) {
                        withAnimation(.snappy) { _ = opened.insert(item.id) }
                        Haptics.success()
                    }
                }
            }
            if opened.count < summary.rewards.count && summary.rewards.count > 1 {
                Button("Abrir todos") {
                    withAnimation(.snappy) { opened = Set(summary.rewards.map(\.id)) }
                    Haptics.success()
                }
                .buttonStyle(SecondaryButtonStyle())
            }
        }
    }

    // MARK: 5. Next competition

    @ViewBuilder
    private var nextPage: some View {
        if let next = summary.next {
            VStack(alignment: .leading, spacing: DS.Spacing.l) {
                SectionLabel(next.running ? "Ya en marcha" : "Próxima competición")
                Image(systemName: ModeInfo.symbol(next.mode))
                    .font(.system(size: 40, weight: .regular))
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: DS.Spacing.s) {
                    Text(next.modeName)
                        .font(Font.screenTitle)
                        .tracking(DS.Tracking.title)
                    if !next.modeDescription.isEmpty {
                        Text(next.modeDescription)
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if let date = next.startDate {
                    let when = date.formatted(.dateTime.weekday(.wide).day().month(.wide).hour().minute().locale(Locale(identifier: "es_ES")))
                    Label {
                        Text(next.running ? "Empezó el \(when)" : "Empieza el \(when)")
                    } icon: {
                        Image(systemName: "calendar")
                    }
                    .font(.subheadline)
                    .card()
                }
                if !next.running {
                    Text("Si tu club no tiene gente suficiente para este modo, jugará otro. Entre medias, cuatro días de descanso con cofres y retos.")
                        .font(Font.meta)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// A reward: the rarity's chest until it's tapped, then the item inside.
private struct RewardChestCell: View {
    let item: InventoryItem
    let isOpen: Bool
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            VStack(spacing: DS.Spacing.s) {
                if isOpen {
                    Image(systemName: PowerSymbol.name(item.itemId))
                        .font(.system(size: 34, weight: .regular))
                        .foregroundStyle(Rarity.color(item.rarity))
                        .frame(height: 72)
                        .transition(.scale(scale: 0.85).combined(with: .opacity))
                    Text(item.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                    RarityPill(rarity: item.rarity)
                    if let scope = item.definition?.scopeLabel {
                        Text(scope)
                            .font(Font.meta)
                            .foregroundStyle(.secondary)
                    }
                    if let expires = item.expiresDate {
                        Text("Úsalo antes del \(expires.formatted(.dateTime.day().month(.abbreviated).locale(Locale(identifier: "es_ES"))))")
                            .font(Font.meta)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                } else {
                    Image(Rarity.chestImage(item.rarity))
                        .resizable()
                        .scaledToFit()
                        .frame(height: 72)
                        .transition(.scale(scale: 1.1).combined(with: .opacity))
                    RarityPill(rarity: item.rarity)
                    Text("Cofre")
                        .font(Font.meta)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 170)
            .card(padding: DS.Spacing.m)
        }
        .buttonStyle(.pressable)
        .disabled(isOpen)
        .accessibilityLabel(isOpen ? "\(item.name), \(Rarity.label(item.rarity))" : "Cofre \(Rarity.label(item.rarity)). Toca para abrirlo")
    }
}

// MARK: - From the club history

/// Opens the summary of any finished competition of the club (GET /api/season/results/:id).
@MainActor
struct CompetitionResultLoader: View {
    let competitionId: String
    @Environment(\.dismiss) private var dismiss
    @State private var summary: CompetitionResultSummary?
    @State private var failed = false

    var body: some View {
        Group {
            if let summary {
                CompetitionResultsView(summary: summary) { dismiss() }
            } else if failed {
                NavigationStack {
                    ErrorView(message: "No se ha podido cargar el resumen.") {
                        Task { await load() }
                    }
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Cerrar") { dismiss() } }
                    }
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .screenBackground()
            }
        }
        .task { await load() }
    }

    private func load() async {
        failed = false
        do {
            let response: SeasonResultResponse = try await APIClient.shared.request("GET", "/api/season/results/\(competitionId)")
            summary = response.result
        } catch {
            failed = true
        }
    }
}

// MARK: - Profile showcase

/// Awards won at the close of competitions, with how many times.
struct AwardShowcase: View {
    let awards: [AwardInfo]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: DS.Spacing.s)], spacing: DS.Spacing.m) {
            ForEach(awards) { award in
                VStack(spacing: DS.Spacing.xs) {
                    Image(systemName: award.symbol)
                        .font(.title3)
                        .foregroundStyle(Color.brand)
                        .frame(height: 28)
                    Text(award.name)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Text(award.count == 1 ? "1 vez" : "\(award.count) veces")
                        .font(Font.statLabel)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, DS.Spacing.s)
                .accessibilityElement(children: .combine)
                .accessibilityHint(award.description)
            }
        }
    }
}

/// The own profile's showcase (hidden until there's an award).
struct ProfileAwardsSection: View {
    let awards: [AwardInfo]

    var body: some View {
        if !awards.isEmpty {
            Section {
                AwardShowcase(awards: awards)
                    .listRowBackground(Color.surface)
            } header: {
                SocialSectionHeader(title: "Logros")
            }
        }
    }
}
