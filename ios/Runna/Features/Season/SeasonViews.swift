import SwiftUI
import MapKit

// MARK: - Phase chip (map)

/// Small floating chip with the season phase and its countdown ("Competición · termina en 3 días").
struct SeasonPhaseChip: View {
    let store: SeasonStore
    let action: () -> Void

    var body: some View {
        if let cycle = store.cycle {
            Button(action: action) {
                HStack(spacing: 6) {
                    Image(systemName: cycle.isCompetition ? ModeInfo.symbol(cycle.mode) : "gift")
                        .font(.caption.weight(.semibold))
                    Text(title(cycle))
                        .font(.footnote.weight(.semibold))
                        .lineLimit(1)
                    if let countdown = store.phaseCountdown {
                        Text(countdown)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 32)
                .glassSurface(Capsule(), interactive: true)
            }
            .buttonStyle(.pressable)
            .accessibilityLabel("\(title(cycle)). \(store.phaseCountdown ?? "")")
        }
    }

    private func title(_ cycle: SeasonCycle) -> String {
        if cycle.isCompetition {
            return cycle.modeInfo?.name ?? "Competición"
        }
        return cycle.phase == "preseason" ? "Pretemporada" : "Descanso"
    }
}

// MARK: - Competition card

/// My club competition: mode, my position and the board that fits the mode.
struct CompetitionCard: View {
    let competition: ClubCompetition
    let userId: String?
    var maxRows: Int = 5
    var onSelectUser: ((String) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            header
            switch competition.mode {
            case "teams": teamsBoard
            case "target": targetBoard
            case "duel": duelBoard
            default: EmptyView()
            }
            standingsList
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private var header: some View {
        HStack(alignment: .top, spacing: DS.Spacing.m) {
            Image(systemName: ModeInfo.symbol(competition.mode))
                .font(.title3)
                .foregroundStyle(Color.brand)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(competition.modeName)
                    .font(Font.cardTitle)
                if let description = competition.modeInfo?.description, !description.isEmpty {
                    Text(description)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !competition.isActive {
                    Text(competition.resultLine(userId: userId))
                        .font(.subheadline.weight(.semibold))
                        .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
            if let rank = competition.myRank {
                VStack(spacing: 1) {
                    Text("#\(rank)")
                        .font(Font.stat(24, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(rank == 1 ? Color.gold : Color.primary)
                    Text("de \(competition.participants)")
                        .statLabelStyle()
                }
            }
        }
    }

    private var teamsBoard: some View {
        HStack(spacing: 0) {
            ForEach(competition.teams) { team in
                VStack(spacing: 4) {
                    Text(team.name)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(team.index == competition.myTeam ? Color.brand : Color.secondary)
                    StatValue(value: Format.areaParts(team.score).value, unit: Format.areaParts(team.score).unit, font: Font.stat(20, weight: .semibold))
                    Text(team.index == competition.myTeam ? "Tu equipo" : "\(team.members) corredores")
                        .statLabelStyle()
                }
                .frame(maxWidth: .infinity)
                if team.index == 0 && competition.teams.count > 1 {
                    StatDivider(height: 44)
                }
            }
        }
        .padding(.vertical, DS.Spacing.s)
    }

    @ViewBuilder
    private var targetBoard: some View {
        if let target = competition.target {
            VStack(alignment: .leading, spacing: 6) {
                ProgressView(value: target.progress)
                    .tint(Color.brand)
                HStack {
                    Text("\(Format.area(target.total)) de \(Format.area(target.target))")
                        .font(.footnote.weight(.semibold))
                        .monospacedDigit()
                    Spacer()
                    Text(target.achieved ? "Conseguido" : "\(Int((target.progress * 100).rounded())) %")
                        .font(.footnote)
                        .foregroundStyle(target.achieved ? Color.brand : Color.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private var duelBoard: some View {
        if let duel = competition.duel {
            HStack(spacing: 0) {
                duelSide(name: "Tu club", score: duel.myClubScore, highlight: duel.myClubScore >= duel.opponentScore)
                Text("vs")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32)
                duelSide(name: duel.opponent?.name ?? "Rival", score: duel.opponentScore, highlight: duel.opponentScore > duel.myClubScore)
            }
            Text("Cuentan los \(duel.runnersCounted) mejores de cada club, con un máximo de \(Format.area(duel.perRunnerCap)) por persona.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func duelSide(name: String, score: Double, highlight: Bool) -> some View {
        let parts = Format.areaParts(score)
        return VStack(spacing: 4) {
            Text(name)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .foregroundStyle(.secondary)
            StatValue(value: parts.value, unit: parts.unit, font: Font.stat(22, weight: .semibold), tint: highlight ? Color.primary : Color.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private var standingsList: some View {
        let rows = Array(competition.standings.prefix(maxRows))
        if !rows.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, standing in
                    if index > 0 { HairlineDivider() }
                    standingRow(standing)
                }
            }
        }
    }

    @ViewBuilder
    private func standingRow(_ standing: CompetitionStanding) -> some View {
        let row = HStack(spacing: DS.Spacing.m) {
            Text("\(standing.rank)")
                .font(.system(.footnote, design: .monospaced).weight(.medium))
                .foregroundStyle(standing.userId == userId ? Color.brand : Color.secondary)
                .frame(minWidth: 20, alignment: .leading)
            AvatarView(name: standing.user?.name ?? "?", avatar: standing.user?.avatar, color: standing.user?.color ?? "#888888", size: 28)
            VStack(alignment: .leading, spacing: 1) {
                Text(standing.userId == userId ? "Tú" : (standing.user?.name ?? "Corredor"))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if standing.areaStolen > 0 {
                    Text("\(Format.area(standing.areaStolen)) robados")
                        .font(.caption2)
                        .foregroundStyle(Color.steal)
                }
            }
            Spacer(minLength: 4)
            Text(Format.area(standing.score))
                .font(Font.stat(17, weight: .semibold))
                .monospacedDigit()
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        if let onSelectUser {
            Button { onSelectUser(standing.userId) } label: { row }
                .buttonStyle(.plain)
        } else {
            row
        }
    }
}

// MARK: - Challenges

struct ChallengesCard: View {
    let challenges: [SeasonChallenge]

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            ForEach(challenges) { challenge in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.s) {
                        Image(systemName: challenge.isCompleted ? "checkmark.seal.fill" : "seal")
                            .foregroundStyle(challenge.isCompleted ? Color.brand : Color.secondary)
                        Text(challenge.title)
                            .font(.subheadline.weight(.semibold))
                        Spacer(minLength: 4)
                        RarityPill(rarity: challenge.rewardRarity)
                    }
                    Text(challenge.description)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if challenge.unit != "runs" {
                        ProgressView(value: challenge.fraction)
                            .tint(Color.brand)
                    }
                    HStack {
                        Text(challenge.progressText)
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                        Spacer()
                        if let reward = challenge.rewardItem {
                            Text("Recompensa: \(reward.name)")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(Color.brand)
                        }
                    }
                }
                if challenge.id != challenges.last?.id {
                    HairlineDivider()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

// MARK: - Chests

/// A chest on the competition map (rest days): rarity-coloured box.
struct ChestMarker: View {
    let chest: Chest

    var body: some View {
        let color: Color = Rarity.color(chest.rarity)
        Image(systemName: chest.hidden ? "eye.fill" : "shippingbox.fill")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(color)
            .frame(width: 32, height: 32)
            .background(Color(uiColor: .systemBackground), in: Circle())
            .overlay(Circle().strokeBorder(color, lineWidth: 2))
            .shadow(color: Color.black.opacity(0.18), radius: 2, x: 0, y: 1)
            .contentShape(Circle())
            .accessibilityLabel("Cofre \(Rarity.label(chest.rarity))")
    }
}

struct ChestDetailView: View {
    let chest: Chest
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.l) {
            HStack(spacing: DS.Spacing.m) {
                Image(systemName: PowerSymbol.name(chest.itemId))
                    .font(.title2)
                    .foregroundStyle(Rarity.color(chest.rarity))
                    .frame(width: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text(chest.item?.name ?? chest.name)
                        .font(.title3.weight(.semibold))
                    RarityPill(rarity: chest.rarity)
                }
            }
            if let description = chest.item?.description, !description.isEmpty {
                Text(description)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let scope = chest.item?.scopeLabel {
                Label("Alcance: \(scope)", systemImage: "scope")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let expires = chest.expiresDate, expires > Date() {
                Label("Desaparece en \(SeasonStore.remaining(expires.timeIntervalSinceNow))", systemImage: "clock")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Label("Pasa corriendo a menos de 250 m para abrirlo. Solo para miembros de un club.", systemImage: "figure.run")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button("Entendido") { dismiss() }
                .buttonStyle(PrimaryButtonStyle())
        }
        .padding(DS.Spacing.xl)
        .presentationDetents([.medium])
    }
}

// MARK: - Inventory

@MainActor
@Observable
final class InventoryModel {
    private(set) var items: [InventoryItem] = []
    private(set) var cap = 3
    private(set) var equippedTitle: String?
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    func load() async {
        isLoading = items.isEmpty
        defer { isLoading = false }
        do {
            let response: InventoryResponse = try await APIClient.shared.request("GET", "/api/inventory")
            items = response.items
            cap = response.cap
            equippedTitle = response.equippedTitle
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func activate(_ item: InventoryItem, targetUserId: String? = nil, nickname: String? = nil) async throws -> ItemActivationResponse {
        var body: [String: Any] = [:]
        if let targetUserId { body["targetUserId"] = targetUserId }
        if let nickname { body["nickname"] = nickname }
        let response: ItemActivationResponse = try await APIClient.shared.request("POST", "/api/inventory/\(item.id)/activate", body: body)
        await load()
        await SeasonStore.shared.load(force: true)
        return response
    }

    func equipTitle(_ itemId: String?) async throws {
        let body: [String: Any] = ["itemId": itemId.map { $0 as Any } ?? NSNull()]
        try await APIClient.shared.send("POST", "/api/cosmetics/title", body: body)
        await load()
    }

    var active: [InventoryItem] { items.filter(\.isActive) }
    var available: [InventoryItem] { items.filter(\.isAvailable) }
    var cosmetics: [InventoryItem] { items.filter(\.isOwnedCosmetic) }
}

/// Inventory: active effects, items ready to use (competition / global) and cosmetics.
struct InventorySheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var model = InventoryModel()
    @State private var season = SeasonStore.shared
    @State private var targetItem: InventoryItem?
    @State private var busyId: String?
    @State private var message: String?
    @State private var spiedRoute: RunRoute?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                rulesSection
                if !model.active.isEmpty {
                    Section {
                        ForEach(model.active) { item in
                            itemRow(item, showsButton: false)
                        }
                    } header: {
                        Text("Activos")
                    }
                }
                Section {
                    if model.available.isEmpty && !model.isLoading {
                        Text("No tienes objetos. Consíguelos en los cofres y retos de los días de descanso y con las recompensas de cada competición.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.available) { item in
                        itemRow(item, showsButton: true)
                    }
                } header: {
                    Text("Para usar (máximo \(model.cap) de cada tipo)")
                }
                if !model.cosmetics.isEmpty {
                    Section {
                        ForEach(model.cosmetics) { item in
                            cosmeticRow(item)
                        }
                    } header: {
                        Text("Cosméticos")
                    } footer: {
                        Text("Los títulos se ven junto a tu nombre en los rankings. Las piezas de escudo las puede usar tu club.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .listBackground()
            .overlay {
                if model.isLoading { ProgressView() }
            }
            .navigationTitle("Inventario")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .task { await model.load() }
            .refreshable { await model.load() }
            .sheet(item: $targetItem) { item in
                TargetPickerSheet(item: item, rivals: rivals) { targetId, nickname in
                    Task { await activate(item, targetUserId: targetId, nickname: nickname) }
                }
            }
            .sheet(item: $spiedRoute) { route in
                SpyRouteSheet(route: route)
            }
            .alert("Inventario", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(message ?? "")
            }
            .errorAlert($errorMessage)
        }
    }

    private var rulesSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Label("Competición: solo cuentan en la competición de tu club.", systemImage: "flag.2.crossed")
                Label("Global: pequeños extras con tope para el mapa global.", systemImage: "globe.europe.africa")
                Label("Los defensivos caducan a los 3 días y el resto a los 7 si no los usas. Los que consigues en el descanso empiezan a contar cuando arranca la competición.", systemImage: "clock")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
    }

    private func itemRow(_ item: InventoryItem, showsButton: Bool) -> some View {
        HStack(alignment: .top, spacing: DS.Spacing.m) {
            Image(systemName: PowerSymbol.name(item.itemId))
                .font(.title3)
                .foregroundStyle(Rarity.color(item.rarity))
                .frame(width: 30)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(item.name)
                        .font(.subheadline.weight(.semibold))
                    Text(item.definition?.scopeLabel ?? "")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                if let description = item.definition?.description {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if item.isActive, let until = item.activeUntilDate {
                    Text("Activo \(SeasonStore.remaining(until.timeIntervalSinceNow)) más")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Color.brand)
                } else if item.isActive {
                    Text("Se aplicará en tu siguiente carrera")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Color.brand)
                } else if let expires = item.expiresDate {
                    Text("Caduca en \(SeasonStore.remaining(max(60, expires.timeIntervalSinceNow)))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 4)
            if showsButton, item.definition?.activation != "passive" {
                Button(busyId == item.id ? "…" : "Usar") {
                    use(item)
                }
                .buttonStyle(SecondaryButtonStyle(tint: .brand))
                .disabled(busyId != nil || !canUse(item))
            }
        }
        .padding(.vertical, 4)
    }

    private func cosmeticRow(_ item: InventoryItem) -> some View {
        HStack(spacing: DS.Spacing.m) {
            Image(systemName: PowerSymbol.name(item.itemId))
                .foregroundStyle(Rarity.color(item.rarity))
                .frame(width: 30)
            Text(item.name)
                .font(.subheadline)
            Spacer()
            if item.itemId.hasPrefix("title_") {
                if model.equippedTitle == item.itemId {
                    Button("Quitar") { equip(nil) }
                        .buttonStyle(SecondaryButtonStyle(tint: .secondary))
                } else {
                    Button("Llevar") { equip(item.itemId) }
                        .buttonStyle(SecondaryButtonStyle(tint: .brand))
                }
            }
        }
    }

    /// Competition items only while competing; global ones whenever.
    private func canUse(_ item: InventoryItem) -> Bool {
        guard let definition = item.definition else { return false }
        if definition.usablePhase == "competition" { return season.isCompeting }
        return true
    }

    /// Rivals of my competition for target items.
    private var rivals: [GameUser] {
        guard let competition = season.competition else { return [] }
        if competition.mode == "duel" {
            return competition.duel?.opponentStandings.compactMap(\.user) ?? []
        }
        let me = session.userId
        return competition.standings.compactMap { standing -> GameUser? in
            guard standing.userId != me, let user = standing.user else { return nil }
            if competition.mode == "teams", standing.team == competition.myTeam { return nil }
            if competition.mode == "target" { return nil }
            return user
        }
    }

    private func use(_ item: InventoryItem) {
        if item.definition?.needsTarget == true {
            targetItem = item
        } else {
            Task { await activate(item, targetUserId: nil, nickname: nil) }
        }
    }

    private func activate(_ item: InventoryItem, targetUserId: String?, nickname: String?) async {
        busyId = item.id
        defer { busyId = nil }
        do {
            let response = try await model.activate(item, targetUserId: targetUserId, nickname: nickname)
            Haptics.success()
            if let route = response.route {
                spiedRoute = route
            } else {
                message = response.message ?? "\(item.name) activado."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func equip(_ itemId: String?) {
        Task {
            do {
                try await model.equipTitle(itemId)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

/// Picks the rival for Espía / Sabotaje / Pluma del Troll (and the nickname text).
private struct TargetPickerSheet: View {
    let item: InventoryItem
    let rivals: [GameUser]
    let onConfirm: (String, String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var selectedId: String?
    @State private var nickname = ""

    private var needsNickname: Bool { item.itemId == "nickname" }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if rivals.isEmpty {
                        Text("En este modo no tienes rivales a los que apuntar.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(rivals) { rival in
                        Button {
                            selectedId = rival.id
                        } label: {
                            HStack(spacing: DS.Spacing.m) {
                                AvatarView(name: rival.name, avatar: rival.avatar, color: rival.color, size: 32)
                                Text(rival.name)
                                    .foregroundStyle(Color.primary)
                                Spacer()
                                if selectedId == rival.id {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(Color.brand)
                                }
                            }
                        }
                    }
                } header: {
                    Text("Elige a un rival")
                }
                if needsNickname {
                    Section {
                        TextField("Apodo (máximo 20 caracteres)", text: $nickname)
                            .textInputAutocapitalization(.sentences)
                    } header: {
                        Text("Apodo")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(item.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Usar") {
                        if let selectedId {
                            onConfirm(selectedId, needsNickname ? nickname.trimmingCharacters(in: .whitespacesAndNewlines) : nil)
                            dismiss()
                        }
                    }
                    .disabled(selectedId == nil || (needsNickname && nickname.trimmingCharacters(in: .whitespaces).isEmpty))
                }
            }
        }
    }
}

/// Result of "Espía": the rival's last run of the competition.
private struct SpyRouteSheet: View {
    let route: RunRoute
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.l) {
            Text(route.name)
                .font(.title3.weight(.semibold))
            RouteShape(coordinates: route.coordinates)
                .stroke(Color.brand, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                .frame(height: 220)
                .frame(maxWidth: .infinity)
                .card()
            HStack(spacing: DS.Spacing.l) {
                StatTile(value: Format.distance(route.distance), label: "Distancia")
                StatDivider()
                StatTile(value: Format.duration(route.duration), label: "Tiempo")
            }
            Text(Format.dayAndTime(route.startDate))
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Button("Cerrar") { dismiss() }
                .buttonStyle(PrimaryButtonStyle())
        }
        .padding(DS.Spacing.xl)
        .presentationDetents([.large])
    }
}
