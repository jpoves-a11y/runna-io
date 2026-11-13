import SwiftUI

// MARK: - Tab

/// "Club" tab: my club (or how to join one) and, in the same tab, friends.
struct ClubTabView: View {
    @Environment(AppRouter.self) private var router
    @State private var model = ClubModel.shared

    var body: some View {
        @Bindable var router = router
        NavigationStack {
            Group {
                switch router.clubSection {
                case .club:
                    ClubHomeView()
                case .chat:
                    if let club = model.club {
                        ClubChatView(clubId: club.id, members: model.detail?.members ?? [])
                            .navigationTitle(club.name)
                            .navigationBarTitleDisplayMode(.inline)
                    } else {
                        // Not in a club (any more): the club home shows how to join one
                        ClubHomeView()
                    }
                case .friends:
                    FriendsView(embedded: true)
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                Picker("Sección", selection: $router.clubSection) {
                    Text("Mi club").tag(AppRouter.ClubSection.club)
                    // The chat only with a club
                    if model.isMember {
                        Text(model.chatUnread > 0 ? "Chat (\(model.chatUnread))" : "Chat").tag(AppRouter.ClubSection.chat)
                    }
                    Text("Amigos").tag(AppRouter.ClubSection.friends)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, DS.Spacing.l)
                .padding(.vertical, DS.Spacing.s)
                .background(Color.canvas)
            }
        }
    }
}

// MARK: - My club

struct ClubHomeView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @State private var model = ClubModel.shared
    @State private var season = SeasonStore.shared
    @State private var showCreate = false
    @State private var showEdit = false
    @State private var showInvite = false
    @State private var showInventory = false
    @State private var profileUserId: String?
    @State private var confirmLeave = false
    @State private var confirmDelete = false
    @State private var errorMessage: String?
    @State private var joinToken: ClubJoinToken?

    var body: some View {
        content
            .navigationTitle(model.club?.name ?? "Club")
            .toolbar { toolbarContent }
            .refreshable {
                await model.load(force: true)
                await season.load(force: true)
            }
            .task(id: router.reloadSignal) {
                let force = model.reloadTracker.consume(router.reloadSignal)
                await model.load(force: force)
                await season.load(force: force)
            }
            .task(id: router.pendingClubInviteToken) {
                if let token = router.pendingClubInviteToken {
                    router.pendingClubInviteToken = nil
                    joinToken = ClubJoinToken(id: token)
                }
            }
            .sheet(isPresented: $showCreate) {
                ClubFormView(mode: .create)
            }
            .sheet(isPresented: $showEdit) {
                if let club = model.club {
                    ClubFormView(mode: .edit(club, unlocked: Set(model.detail?.unlockedCrestPieces ?? [])))
                }
            }
            .sheet(isPresented: $showInvite) {
                ClubInviteSheet()
            }
            .sheet(isPresented: $showInventory) {
                InventorySheet()
            }
            .sheet(item: $joinToken) { token in
                ClubJoinConfirmationSheet(token: token.id)
            }
            .sheet(item: Binding(
                get: { profileUserId.map { ClubSelectedUser(id: $0) } },
                set: { profileUserId = $0?.id }
            )) { user in
                UserProfileSheet(userId: user.id)
            }
            .confirmationDialog("¿Salir del club?", isPresented: $confirmLeave, titleVisibility: .visible) {
                Button("Salir", role: .destructive) { run { try await model.leave() } }
            } message: {
                Text("Dejarás de competir con ellos. Durante una competición no se puede salir.")
            }
            .confirmationDialog("¿Borrar el club?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Borrar club", role: .destructive) { run { try await model.deleteClub() } }
            } message: {
                Text("Se borrará el club para todos sus miembros. Su historial se pierde.")
            }
            .errorAlert($errorMessage)
    }

    @ViewBuilder
    private var content: some View {
        if model.detail == nil && (model.isLoading || !model.hasLoaded) {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .screenBackground()
        } else if let error = model.errorMessage, model.detail == nil {
            ErrorView(message: error) { Task { await model.load(force: true) } }
                .screenBackground()
        } else if let detail = model.detail, let club = detail.club {
            memberContent(detail: detail, club: club)
        } else {
            ClubDiscoverView(showCreate: $showCreate)
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            if model.isMember {
                Menu {
                    if model.canInvite {
                        Button {
                            showInvite = true
                        } label: {
                            Label("Invitar", systemImage: "person.badge.plus")
                        }
                    }
                    Button {
                        showInventory = true
                    } label: {
                        Label("Inventario", systemImage: "bag")
                    }
                    if model.isAdmin {
                        Button {
                            showEdit = true
                        } label: {
                            Label("Editar club", systemImage: "pencil")
                        }
                    }
                    Divider()
                    if model.isOwner && (model.detail?.members.count ?? 0) <= 1 {
                        Button(role: .destructive) {
                            confirmDelete = true
                        } label: {
                            Label("Borrar club", systemImage: "trash")
                        }
                    } else {
                        Button(role: .destructive) {
                            confirmLeave = true
                        } label: {
                            Label("Salir del club", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Opciones del club")
            }
        }
    }

    private func memberContent(detail: ClubDetailResponse, club: ClubSummary) -> some View {
        ScrollView {
            VStack(spacing: DS.Spacing.l) {
                ClubHeaderCard(club: club, trophies: detail.trophies, showsCode: true)
                seasonSection
                if detail.isAdmin && !detail.pendingRequests.isEmpty {
                    requestsSection(detail.pendingRequests)
                }
                membersSection(detail)
                if !detail.history.isEmpty {
                    historySection(detail.history)
                }
            }
            .padding(.horizontal, DS.Spacing.l)
            .padding(.vertical, DS.Spacing.s)
            .padding(.bottom, DS.Spacing.xxl)
        }
        .screenBackground()
    }

    @ViewBuilder
    private var seasonSection: some View {
        if let cycle = season.cycle {
            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                SectionHeader(
                    title: cycle.phaseTitle,
                    subtitle: season.phaseCountdown,
                    actionTitle: season.availableItemCount > 0 ? "Inventario (\(season.availableItemCount))" : "Inventario",
                    action: { showInventory = true }
                )
                if let competition = season.competition {
                    CompetitionCard(competition: competition, userId: session.userId, maxRows: 10) { userId in
                        if userId != session.userId { profileUserId = userId }
                    }
                } else if cycle.isCompetition {
                    entryNotice(cycle)
                    if let clubCompetition = season.clubCompetition {
                        CompetitionCard(competition: clubCompetition, userId: session.userId, maxRows: 10) { userId in
                            if userId != session.userId { profileUserId = userId }
                        }
                    }
                }
                if cycle.isRest {
                    restInfo(cycle)
                    if !season.challenges.isEmpty {
                        ChallengesCard(challenges: season.challenges)
                    }
                    if let last = season.current?.lastResult {
                        CompetitionCard(competition: last, userId: session.userId, maxRows: 3)
                    }
                }
            }
        }
    }

    /// Why I don't take part in my club's competition, and whether I can still enter.
    private func entryNotice(_ cycle: SeasonCycle) -> some View {
        let next = Format.relative(APIDate.parse(cycle.restEndsAt))
        let (symbol, title, text): (String, String, String) = {
            switch season.competitionEntry {
            case "on_first_run":
                return ("figure.run", "No participas todavía", "No corriste en los 14 días antes de empezar. Sal a correr: con tu primera carrera entras en la competición.")
            case "closed_entry":
                return ("lock", "Esta competición ya está cerrada", "Los equipos se cierran al empezar y no corriste en los 14 días anteriores. Vuelve a correr y entrarás en la próxima competición (\(next)).")
            case "next_cycle":
                return ("calendar", "Compites desde la próxima", "Entraste en el club después de las primeras 48 horas. La próxima competición empieza \(next).")
            default:
                return ("calendar", "Tu club no compite en esta ronda", "La próxima competición empieza \(next).")
            }
        }()
        return HStack(alignment: .top, spacing: DS.Spacing.m) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(Font.cardTitle)
                Text(text)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .card()
    }

    private func restInfo(_ cycle: SeasonCycle) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Días de descanso")
                .font(Font.cardTitle)
            Text("Aparecen cofres alrededor de tu ciudad: pasa corriendo cerca para abrirlos. Completa tus retos para ganar objetos para la próxima competición.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let next = cycle.nextMode {
                Text("Próximo modo: \(next.name)")
                    .font(.footnote.weight(.semibold))
                    .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private func requestsSection(_ requests: [ClubJoinRequest]) -> some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Solicitudes (\(requests.count))")
            VStack(spacing: 0) {
                ForEach(Array(requests.enumerated()), id: \.element.id) { index, request in
                    if index > 0 { HairlineDivider() }
                    HStack(spacing: DS.Spacing.m) {
                        AvatarView(name: request.user.name, avatar: request.user.avatar, color: request.user.color, size: 36)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(request.user.name)
                                .font(.subheadline.weight(.semibold))
                            Text("\(Format.area(request.globalArea)) en el mapa global")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 4)
                        Button {
                            run { try await model.respond(toRequest: request, accept: false) }
                        } label: {
                            Image(systemName: "xmark")
                        }
                        .buttonStyle(SecondaryButtonStyle(tint: .secondary))
                        .accessibilityLabel("Rechazar")
                        Button("Aceptar") {
                            run { try await model.respond(toRequest: request, accept: true) }
                        }
                        .buttonStyle(SecondaryButtonStyle(tint: .brand))
                    }
                    .padding(.vertical, DS.Spacing.s)
                }
            }
            .card(padding: DS.Spacing.m)
        }
    }

    private func membersSection(_ detail: ClubDetailResponse) -> some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Miembros (\(detail.members.count))", actionTitle: detail.canInvite ? "Invitar" : nil, action: { showInvite = true })
            VStack(spacing: 0) {
                ForEach(Array(detail.members.enumerated()), id: \.element.id) { index, member in
                    if index > 0 { HairlineDivider() }
                    memberRow(member, detail: detail)
                }
            }
            .card(padding: DS.Spacing.m)
        }
    }

    private func memberRow(_ member: ClubMember, detail: ClubDetailResponse) -> some View {
        HStack(spacing: DS.Spacing.m) {
            AvatarView(name: member.user.name, avatar: member.user.avatar, color: member.user.color, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(member.user.id == session.userId ? "Tú" : member.user.name)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    if let role = member.roleLabel {
                        Text(role)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Color.brand)
                    }
                }
                Text(Format.area(member.globalArea))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Spacer(minLength: 4)
            if member.user.id != session.userId && (detail.isOwner || (detail.isAdmin && member.role == "member")) {
                Menu {
                    if detail.isOwner {
                        if member.role == "admin" {
                            Button("Quitar de oficial") { run { try await model.setRole("member", for: member) } }
                        } else {
                            Button("Nombrar oficial") { run { try await model.setRole("admin", for: member) } }
                        }
                        Button("Pasarle el liderazgo") { run { try await model.transferOwnership(to: member) } }
                    }
                    Button("Expulsar", role: .destructive) { run { try await model.remove(member) } }
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 32, height: 32)
                }
                .accessibilityLabel("Opciones de \(member.user.name)")
            }
        }
        .padding(.vertical, DS.Spacing.s)
        .contentShape(Rectangle())
        .onTapGesture {
            if member.user.id != session.userId { profileUserId = member.user.id }
        }
    }

    private func historySection(_ history: [ClubHistoryEntry]) -> some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Historial")
            VStack(spacing: 0) {
                ForEach(Array(history.enumerated()), id: \.element.id) { index, entry in
                    if index > 0 { HairlineDivider() }
                    ClubHistoryRow(entry: entry)
                }
            }
            .card(padding: DS.Spacing.m)
        }
    }

    /// Runs a club action and shows its error, if any.
    private func run(_ action: @escaping () async throws -> Void) {
        Task {
            do {
                try await action()
                Haptics.success()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct ClubSelectedUser: Identifiable { let id: String }
struct ClubJoinToken: Identifiable { let id: String }

/// Crest, name, slogan, city and the club's standing.
struct ClubHeaderCard: View {
    let club: ClubSummary
    var trophies: ClubTrophies? = nil
    var showsCode: Bool = false

    var body: some View {
        VStack(spacing: DS.Spacing.m) {
            HStack(spacing: DS.Spacing.l) {
                CrestView(crest: club.crest, size: 68)
                VStack(alignment: .leading, spacing: 4) {
                    Text(club.name)
                        .font(.title3.weight(.semibold))
                        .lineLimit(2)
                    if let slogan = club.slogan, !slogan.isEmpty {
                        Text(slogan)
                            .font(.subheadline)
                            .italic()
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    HStack(spacing: 6) {
                        Image(systemName: club.entrySymbol)
                        Text([club.entryLabel, club.city].compactMap { $0 }.joined(separator: " · "))
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            if let description = club.description, !description.isEmpty {
                Text(description)
                    .font(.subheadline)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HairlineDivider()
            HStack(spacing: 0) {
                StatTile(value: "\(club.memberCount)", label: "Miembros")
                StatDivider()
                StatTile(value: "\(club.leaguePoints)", label: "Puntos liga")
                StatDivider()
                StatTile(value: "\(club.rating)", label: "Nivel")
                if let trophies, trophies.duelsWon + trophies.targetsAchieved > 0 {
                    StatDivider()
                    StatTile(value: "\(trophies.duelsWon + trophies.targetsAchieved)", label: "Trofeos")
                }
            }
            if showsCode, let code = club.joinCode {
                HStack {
                    Text("Código para unirse")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(code)
                        .font(.system(.body, design: .monospaced).weight(.semibold))
                        .textSelection(.enabled)
                }
            }
        }
        .card()
    }
}

struct ClubHistoryRow: View {
    let entry: ClubHistoryEntry
    @State private var showSummary = false

    var body: some View {
        Button {
            showSummary = true
        } label: {
            row
        }
        .buttonStyle(.pressable)
        .accessibilityHint("Ver resumen")
        .fullScreenCover(isPresented: $showSummary) {
            CompetitionResultLoader(competitionId: entry.competitionId)
        }
    }

    private var row: some View {
        HStack(spacing: DS.Spacing.m) {
            Image(systemName: icon)
                .foregroundStyle(entry.outcome == "won" || entry.achieved == true ? Color.gold : Color.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.summary)
                    .font(.subheadline.weight(.semibold))
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if entry.leaguePoints > 0 {
                Text("+\(entry.leaguePoints) pts")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.brand)
            }
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, DS.Spacing.s)
        .contentShape(Rectangle())
    }

    private var subtitle: String {
        var parts: [String] = [entry.modeName, "Ronda \(entry.cycleNumber + 1)"]
        if let mvp = entry.mvp { parts.append("MVP: \(mvp.name)") }
        return parts.joined(separator: " · ")
    }

    private var icon: String {
        if entry.outcome == "won" || entry.achieved == true { return "trophy" }
        return ModeInfo.symbol(entry.mode)
    }
}

// MARK: - Without a club

struct ClubDiscoverView: View {
    @Binding var showCreate: Bool
    @State private var model = ClubModel.shared
    @State private var query = ""
    @State private var results: [ClubSummary] = []
    @State private var needsCity = false
    @State private var myCity: String?
    @State private var isSearching = false
    @State private var code = ""
    @State private var selectedClub: ClubSummary?
    @State private var message: String?
    @State private var errorMessage: String?

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Compite con un club")
                        .font(Font.cardTitle)
                    Text("Sin club solo tienes el modo global. En un club compites cada dos semanas y consigues cofres, retos y recompensas que también ayudan en el ranking global.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Crear un club") { showCreate = true }
                        .buttonStyle(PrimaryButtonStyle())
                        .padding(.top, DS.Spacing.s)
                }
                .padding(.vertical, 4)
            }
            if !model.invites.isEmpty {
                Section {
                    ForEach(model.invites) { invite in
                        HStack(spacing: DS.Spacing.m) {
                            CrestView(crest: invite.club.crest, size: 36)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(invite.club.name)
                                    .font(.subheadline.weight(.semibold))
                                if let inviter = invite.invitedBy {
                                    Text("Te invita \(inviter.name)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer(minLength: 4)
                            Button {
                                respond(invite, accept: false)
                            } label: {
                                Image(systemName: "xmark")
                            }
                            .buttonStyle(SecondaryButtonStyle(tint: .secondary))
                            Button("Unirme") { respond(invite, accept: true) }
                                .buttonStyle(SecondaryButtonStyle(tint: .brand))
                        }
                    }
                } header: {
                    Text("Invitaciones")
                }
            }
            if !model.myRequests.isEmpty {
                Section {
                    ForEach(model.myRequests) { request in
                        HStack(spacing: DS.Spacing.m) {
                            CrestView(crest: request.club.crest, size: 32)
                            Text(request.club.name)
                                .font(.subheadline)
                            Spacer()
                            Text("Pendiente")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("Solicitudes enviadas")
                }
            }
            Section {
                HStack {
                    TextField("Código del club", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    Button("Unirme") { joinWithCode() }
                        .disabled(code.trimmingCharacters(in: .whitespaces).count < 4)
                }
            } header: {
                Text("Unirse con un código")
            } footer: {
                Text("Pide el código a alguien del club, o abre su enlace de invitación. En los clubes con aprobación, el código envía una solicitud.")
            }
            Section {
                if isSearching && results.isEmpty {
                    ProgressView()
                }
                if !isSearching && results.isEmpty {
                    if needsCity {
                        Label("Elige tu ciudad base en Perfil: cada club pertenece a una ciudad y solo admite corredores de ella.", systemImage: "mappin.slash")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else {
                        Text(query.isEmpty ? "Aún no hay clubes en \(myCity ?? "tu ciudad"). ¡Crea el primero!" : "Ningún club de \(myCity ?? "tu ciudad") coincide con la búsqueda.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                ForEach(results) { club in
                    Button {
                        selectedClub = club
                    } label: {
                        ClubRow(club: club)
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                Text(query.isEmpty ? (myCity.map { "Clubes de \($0)" } ?? "Clubes de tu ciudad") : "Resultados")
            } footer: {
                if !needsCity {
                    Text("Solo puedes unirte a clubes de tu ciudad base.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .listBackground()
        .searchable(text: $query, prompt: "Buscar clubes por nombre")
        .task(id: query) {
            // Debounce typing
            if !query.isEmpty { try? await Task.sleep(nanoseconds: 350_000_000) }
            if Task.isCancelled { return }
            await search()
        }
        .sheet(item: $selectedClub, onDismiss: { Task { await search() } }) { club in
            ClubDetailSheet(clubId: club.id)
        }
        .alert("Club", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(message ?? "")
        }
        .errorAlert($errorMessage)
    }

    private func search() async {
        isSearching = true
        defer { isSearching = false }
        do {
            let response = try await model.search(query.trimmingCharacters(in: .whitespaces))
            results = response.clubs
            needsCity = response.needsCity
            myCity = response.city
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func joinWithCode() {
        let value = code.trimmingCharacters(in: .whitespaces).uppercased()
        Task {
            do {
                let response = try await model.join(code: value)
                code = ""
                message = joinMessage(response)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func respond(_ invite: ClubInvite, accept: Bool) {
        Task {
            do {
                if let response = try await model.respond(toInvite: invite, accept: accept) {
                    message = joinMessage(response)
                }
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

func joinMessage(_ response: ClubJoinResponse) -> String {
    if response.requested { return "Solicitud enviada. Te avisaremos cuando la acepten." }
    return "¡Ya estás en el club! " + competitionEntryMessage(response.competitionEntry, joined: response.joinedCompetition)
}

/// What joining a club means for its running competition.
func competitionEntryMessage(_ entry: String?, joined: Bool) -> String {
    switch entry {
    case "joined", "participant": return "Entras en la competición que está en marcha."
    case "on_first_run": return "Con tu primera carrera entras en la competición que está en marcha."
    case "closed_entry": return "Esta competición es por equipos y ya ha empezado: competirás desde la próxima."
    case "next_cycle", "none": return "Competirás con ellos desde la próxima competición."
    default: return joined ? "Entras en la competición que está en marcha." : "Competirás con ellos desde la próxima competición."
    }
}

struct ClubRow: View {
    let club: ClubSummary

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            CrestView(crest: club.crest, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(club.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                Text(details)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let description = club.description, !description.isEmpty {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 4)
            if club.requestPending {
                Text("Pendiente")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if club.full {
                Text("Completo")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .contentShape(Rectangle())
    }

    private var details: String {
        var parts: [String] = ["\(club.memberCount) miembros"]
        if club.requiresApproval { parts.append(club.entryLabel) }
        if let city = club.city { parts.append(city) }
        if let km = club.distanceKm, km >= 1 { parts.append("a \(Int(km.rounded())) km") }
        if club.leaguePoints > 0 { parts.append("\(club.leaguePoints) pts") }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Club detail (search, rankings)

struct ClubDetailSheet: View {
    let clubId: String
    @Environment(\.dismiss) private var dismiss
    @State private var model = ClubModel.shared
    @State private var detail: ClubDetailResponse?
    @State private var errorMessage: String?
    @State private var message: String?
    @State private var isJoining = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: DS.Spacing.l) {
                    if let detail, let club = detail.club {
                        ClubHeaderCard(club: club, trophies: detail.trophies)
                        joinButton(detail: detail, club: club)
                        if !detail.members.isEmpty {
                            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                                SectionHeader(title: "Miembros")
                                VStack(spacing: 0) {
                                    ForEach(Array(detail.members.enumerated()), id: \.element.id) { index, member in
                                        if index > 0 { HairlineDivider() }
                                        HStack(spacing: DS.Spacing.m) {
                                            AvatarView(name: member.user.name, avatar: member.user.avatar, color: member.user.color, size: 32)
                                            Text(member.user.name)
                                                .font(.subheadline)
                                            Spacer()
                                            Text(Format.area(member.globalArea))
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                                .monospacedDigit()
                                        }
                                        .padding(.vertical, 6)
                                    }
                                }
                                .card(padding: DS.Spacing.m)
                            }
                        }
                        if !detail.history.isEmpty {
                            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                                SectionHeader(title: "Historial")
                                VStack(spacing: 0) {
                                    ForEach(detail.history) { entry in
                                        ClubHistoryRow(entry: entry)
                                    }
                                }
                                .card(padding: DS.Spacing.m)
                            }
                        }
                    } else if let errorMessage {
                        ErrorView(message: errorMessage) { Task { await load() } }
                    } else {
                        ProgressView().padding(.top, 60)
                    }
                }
                .padding(DS.Spacing.l)
            }
            .screenBackground()
            .navigationTitle("Club")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .task { await load() }
            .alert("Club", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
                Button("OK", role: .cancel) { dismiss() }
            } message: {
                Text(message ?? "")
            }
        }
    }

    @ViewBuilder
    private func joinButton(detail: ClubDetailResponse, club: ClubSummary) -> some View {
        if detail.isMember {
            Text("Ya eres miembro de este club.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else if model.isMember {
            Text("Ya estás en otro club. Sal de él para unirte a este.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else if detail.requestPending {
            Text("Solicitud enviada. Esperando a que la acepte el líder o un oficial.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else if club.memberCount >= club.maxMembers {
            Text("El club está completo.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else if club.isPrivate {
            Text("Este club es solo por invitación: pide un enlace o el código a alguien del club.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        } else {
            VStack(spacing: DS.Spacing.s) {
                Button(club.requiresApproval ? "Pedir unirme" : "Unirme al club") {
                    join()
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isJoining)
                if club.requiresApproval {
                    Text("El líder o un oficial aprobará tu solicitud.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func load() async {
        do {
            let response: ClubDetailResponse = try await APIClient.shared.request("GET", "/api/clubs/\(clubId)")
            detail = response
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func join() {
        isJoining = true
        Task {
            defer { isJoining = false }
            do {
                let response = try await model.join(clubId)
                Haptics.success()
                message = joinMessage(response)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

// MARK: - Create / edit

struct ClubFormView: View {
    enum Mode {
        case create
        case edit(ClubSummary, unlocked: Set<String>)
    }

    let mode: Mode
    @Environment(\.dismiss) private var dismiss
    @State private var model = ClubModel.shared
    @State private var name = ""
    @State private var slogan = ""
    @State private var descriptionText = ""
    @State private var entryMode = "open"
    @State private var invitePermission = "all"
    @State private var crest = Crest()
    @State private var unlocked: Set<String> = []
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var resultMessage: String?
    @State private var didSetUp = false
    @State private var initialsEdited = false
    @FocusState private var focused: Field?

    private enum Field { case name, slogan, description }

    private var isEditing: Bool {
        if case .edit = mode { return true }
        return false
    }

    /// The club's base city: the club's own when editing, mine when creating.
    private var city: String? {
        if case .edit(let club, _) = mode { return club.city }
        return SeasonStore.shared.globalMe?.city
    }

    private var needsCity: Bool { !isEditing && city == nil }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: DS.Spacing.l) {
                    hero
                    if needsCity { cityMissingCard }
                    detailsCard
                    entryCard
                    VStack(alignment: .leading, spacing: DS.Spacing.s) {
                        SectionHeader(title: "Escudo", subtitle: "Forma, fondo, colores e icono: todo a vuestro gusto.")
                        CrestEditor(crest: $crest, unlocked: unlocked, onInitialsEdited: { initialsEdited = true })
                            .card()
                    }
                }
                .padding(.horizontal, DS.Spacing.screen)
                .padding(.vertical, DS.Spacing.l)
            }
            .scrollDismissesKeyboard(.interactively)
            .dismissesKeyboardOnTapOutside()
            .screenBackground()
            .navigationTitle(isEditing ? "Editar club" : "Nuevo club")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isEditing ? "Guardar" : "Crear") { save() }
                        .fontWeight(.semibold)
                        .disabled(isSaving || needsCity || name.trimmingCharacters(in: .whitespaces).count < 3)
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Listo") { focused = nil }
                        .fontWeight(.semibold)
                }
            }
            .onAppear(perform: setUp)
            .onChange(of: name) { _, value in
                guard !isEditing, !initialsEdited else { return }
                crest.initials = Self.initials(of: value)
            }
            .task {
                if !isEditing && SeasonStore.shared.globalMe == nil { await SeasonStore.shared.load() }
                // Pieces I own myself (creating) — when editing the server also counts the club's
                if !isEditing, let inventory: InventoryResponse = try? await APIClient.shared.request("GET", "/api/inventory") {
                    unlocked = Set(inventory.items.filter(\.isOwnedCosmetic).map(\.itemId))
                }
            }
            .errorAlert($errorMessage)
            .alert("Club", isPresented: Binding(get: { resultMessage != nil }, set: { if !$0 { resultMessage = nil; dismiss() } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(resultMessage ?? "")
            }
        }
    }

    // MARK: Sections

    private var hero: some View {
        VStack(spacing: DS.Spacing.m) {
            CrestView(crest: crest, size: 84)
                .shadow(color: Color.black.opacity(0.18), radius: 8, x: 0, y: 4)
                .animation(.snappy, value: crest)
            VStack(spacing: 4) {
                Text(name.trimmingCharacters(in: .whitespaces).isEmpty ? "Tu club" : name)
                    .font(.title2.weight(.bold))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                if !slogan.trimmingCharacters(in: .whitespaces).isEmpty {
                    Text(slogan)
                        .font(.subheadline.italic())
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                }
            }
            if let city {
                Label(city, systemImage: "mappin.and.ellipse")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.brand)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color.brand.opacity(0.12), in: Capsule())
                Text(isEditing ? "Solo pueden unirse corredores de esta ciudad." : "La ciudad del club es tu ciudad base: solo podrán unirse corredores de aquí.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, DS.Spacing.l)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, DS.Spacing.l)
        .background(
            LinearGradient(colors: [Color(hex: crest.primary).opacity(0.22), Color.surface], startPoint: .top, endPoint: .bottom),
            in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous)
        )
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous).strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline))
    }

    private var cityMissingCard: some View {
        HStack(alignment: .top, spacing: DS.Spacing.m) {
            Image(systemName: "mappin.slash")
                .font(.title3)
                .foregroundStyle(Color.steal)
            VStack(alignment: .leading, spacing: 4) {
                Text("Elige tu ciudad base")
                    .font(.headline)
                Text("Un club pertenece a una ciudad y solo admite corredores de ella. Elige tu ciudad base en Perfil y vuelve aquí.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }

    private var detailsCard: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Datos del club")
            VStack(alignment: .leading, spacing: DS.Spacing.m) {
                field("Nombre", required: true) {
                    TextField("Ej. Corredores del Retiro", text: $name)
                        .focused($focused, equals: .name)
                        .submitLabel(.next)
                        .onSubmit { focused = .slogan }
                }
                field("Eslogan") {
                    TextField("Una frase que os defina (opcional)", text: $slogan, axis: .vertical)
                        .lineLimit(1...3)
                        .focused($focused, equals: .slogan)
                }
                field("Descripción", counter: "\(descriptionText.count)/500") {
                    TextField("Quiénes sois, cuándo quedáis, qué buscáis…", text: $descriptionText, axis: .vertical)
                        .lineLimit(3...8)
                        .focused($focused, equals: .description)
                        .onChange(of: descriptionText) { _, value in
                            if value.count > 500 { descriptionText = String(value.prefix(500)) }
                        }
                }
                Text("Se ve en el buscador y en la ficha del club.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .card()
        }
    }

    private func field<Content: View>(_ title: String, required: Bool = false, counter: String? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title + (required ? " *" : ""))
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if let counter {
                    Text(counter)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            content()
                .padding(.horizontal, DS.Spacing.m)
                .padding(.vertical, 12)
                .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous))
        }
    }

    private var entryCard: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Quién entra")
            VStack(alignment: .leading, spacing: DS.Spacing.m) {
                ForEach(ClubEntry.modes, id: \.self) { option in
                    entryOption(option)
                }
                if canChooseInvites {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Quién puede invitar")
                            .font(.subheadline.weight(.semibold))
                        Picker("Quién puede invitar", selection: $invitePermission) {
                            Text("Todos").tag("all")
                            Text("Líder y oficiales").tag("officers")
                        }
                        .pickerStyle(.segmented)
                    }
                    .padding(.top, 4)
                }
                Text(entryFooter)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .card()
        }
    }

    private func entryOption(_ option: String) -> some View {
        let selected = entryMode == option
        return Button {
            withAnimation(.snappy) { entryMode = option }
        } label: {
            HStack(spacing: DS.Spacing.m) {
                Image(systemName: ClubEntry.symbol(option))
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(selected ? Color.onBrand : Color.brand)
                    .frame(width: 36, height: 36)
                    .background(selected ? Color.brand : Color.brand.opacity(0.12), in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(ClubEntry.label(option))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(ClubEntry.explanation(option))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(selected ? Color.brand : Color.secondary.opacity(0.5))
            }
            .padding(DS.Spacing.m)
            .background(selected ? Color.brand.opacity(0.08) : Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous)
                    .strokeBorder(selected ? Color.brand : Color.clear, lineWidth: 1.5)
            )
        }
        .buttonStyle(.pressable)
        .sensoryFeedback(.selection, trigger: selected)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// "Corredores del Retiro" → "CR"
    static func initials(of name: String) -> String {
        let words = name.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        let letters = words.count > 1 ? words.prefix(3).compactMap(\.first) : Array(name.filter { $0.isLetter || $0.isNumber }.prefix(2))
        return String(letters).uppercased()
    }

    /// Only the leader decides who can invite (when creating, I am the leader).
    private var canChooseInvites: Bool { !isEditing || model.isOwner }

    private var entryFooter: String {
        guard canChooseInvites else { return ClubEntry.explanation(entryMode) }
        return invitePermission == "officers"
            ? "Solo el líder y los oficiales pueden invitar y ver el código."
            : (entryMode == "approval" ? "Las invitaciones de los miembros también necesitan aprobación." : "Cualquier miembro puede invitar.")
    }

    private func setUp() {
        guard !didSetUp else { return }
        didSetUp = true
        if case .edit(let club, let pieces) = mode {
            name = club.name
            slogan = club.slogan ?? ""
            descriptionText = club.description ?? ""
            entryMode = club.entryMode
            invitePermission = club.invitePermission
            crest = club.crest
            unlocked = pieces
        } else {
            crest = Crest(initials: Self.initials(of: name))
        }
    }

    private func save() {
        isSaving = true
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedSlogan = slogan.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedDescription = descriptionText.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            defer { isSaving = false }
            do {
                if isEditing {
                    try await model.update(
                        name: trimmedName, slogan: trimmedSlogan, description: trimmedDescription, crest: crest,
                        entryMode: entryMode, invitePermission: canChooseInvites ? invitePermission : nil
                    )
                    Haptics.success()
                    dismiss()
                } else {
                    let response = try await model.create(
                        name: trimmedName, slogan: trimmedSlogan, description: trimmedDescription, crest: crest,
                        entryMode: entryMode, invitePermission: invitePermission
                    )
                    Haptics.success()
                    resultMessage = "Club creado. " + competitionEntryMessage(response.competitionEntry, joined: response.joinedCompetition) + " Invita a tus amigos."
                }
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

// MARK: - Invites

/// Invite friends directly, or share the club link / code.
struct ClubInviteSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(SessionStore.self) private var session
    @State private var model = ClubModel.shared
    @State private var friends = FriendsModel.shared
    @State private var invitedIds: Set<String> = []
    @State private var link: ClubInviteLinkResponse?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let link, let url = URL(string: link.url) {
                        ShareLink(item: url, subject: Text("Únete a \(model.club?.name ?? "mi club")"), message: Text("Únete a mi club en Runna")) {
                            Label("Compartir enlace de invitación", systemImage: "square.and.arrow.up")
                        }
                    } else {
                        ProgressView()
                    }
                    if let code = model.club?.joinCode {
                        HStack {
                            Text("Código")
                            Spacer()
                            Text(code)
                                .font(.system(.body, design: .monospaced).weight(.semibold))
                                .textSelection(.enabled)
                        }
                        if model.isAdmin {
                            Button("Generar un código nuevo") {
                                Task {
                                    do { try await model.regenerateCode() } catch { errorMessage = error.localizedDescription }
                                }
                            }
                        }
                    }
                } footer: {
                    Text(inviteFooter)
                }
                Section {
                    if friends.friends.isEmpty {
                        Text("Añade amigos en la sección Amigos para invitarlos desde aquí.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(friends.friends) { friend in
                        HStack(spacing: DS.Spacing.m) {
                            AvatarView(name: friend.name, avatar: friend.avatar, color: friend.color, size: 32)
                            Text(friend.name)
                            Spacer()
                            if invitedIds.contains(friend.id) {
                                Text("Invitado")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            } else {
                                Button("Invitar") { invite(friend.id) }
                                    .buttonStyle(SecondaryButtonStyle(tint: .brand))
                            }
                        }
                    }
                } header: {
                    Text("Invitar a amigos")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Invitar al club")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .task {
                if let userId = session.userId {
                    await friends.load(userId: userId, force: false)
                }
                do {
                    link = try await model.inviteLink()
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
            .errorAlert($errorMessage)
        }
    }

    private var inviteFooter: String {
        var text = "El enlace caduca en 14 días. El código vale hasta que el líder o un oficial lo cambie."
        if model.club?.requiresApproval == true && !model.isAdmin {
            text += " En este club, quien entre con tu invitación necesita la aprobación del líder o de un oficial."
        }
        return text
    }

    private func invite(_ userId: String) {
        Task {
            do {
                try await model.invite(userId: userId)
                invitedIds.insert(userId)
                Haptics.success()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

/// A club invite link opened in the app (runnaio://clubs/join/<token>): shows the club and joins it.
struct ClubJoinConfirmationSheet: View {
    let token: String
    @Environment(\.dismiss) private var dismiss
    @State private var model = ClubModel.shared
    @State private var club: ClubSummary?
    @State private var requiresApproval = false
    @State private var errorMessage: String?
    @State private var message: String?
    @State private var isJoining = false

    var body: some View {
        VStack(spacing: DS.Spacing.l) {
            if let club {
                CrestView(crest: club.crest, size: 88)
                Text(club.name)
                    .font(.title2.weight(.semibold))
                    .multilineTextAlignment(.center)
                if let slogan = club.slogan {
                    Text(slogan)
                        .italic()
                        .foregroundStyle(.secondary)
                }
                Text(memberLine(club))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if model.isMember {
                    Text("Ya estás en un club. Sal de él para unirte a este.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                Button(requiresApproval ? "Pedir unirme" : "Unirme al club") { join() }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(isJoining || model.isMember)
                if requiresApproval {
                    Text("El líder o un oficial aprobará tu solicitud.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } else if let errorMessage {
                EmptyStateView(systemImage: "link", title: "Invitación no válida", message: errorMessage)
            } else {
                ProgressView()
            }
            Button("Cerrar") { dismiss() }
                .padding(.top, DS.Spacing.s)
        }
        .padding(DS.Spacing.xl)
        .presentationDetents([.medium, .large])
        .task {
            do {
                let preview = try await model.preview(inviteToken: token)
                if preview.valid {
                    club = preview.club
                    requiresApproval = preview.requiresApproval
                } else {
                    errorMessage = "Esta invitación ya no es válida: pide otra a un oficial del club."
                }
            } catch {
                errorMessage = error.localizedDescription
            }
        }
        .alert("Club", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil; dismiss() } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(message ?? "")
        }
    }

    private func memberLine(_ club: ClubSummary) -> String {
        var parts: [String] = ["\(club.memberCount) miembros"]
        if let city = club.city { parts.append(city) }
        return parts.joined(separator: " · ")
    }

    private func join() {
        isJoining = true
        Task {
            defer { isJoining = false }
            do {
                let response = try await model.accept(inviteToken: token)
                Haptics.success()
                message = joinMessage(response)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
