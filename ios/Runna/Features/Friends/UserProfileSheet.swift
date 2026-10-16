import SwiftUI

/// Another runner's profile in a sheet. Friends and activities can be opened from it (pushed in the same sheet).
struct UserProfileSheet: View {
    let userId: String

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            UserProfileContent(userId: userId, onClose: { dismiss() })
        }
        .presentationDetents([.medium, .large])
        .presentationCornerRadius(28)
    }
}

/// Profile body: stats, rivalry with you, friend button, their friends, their activities,
/// and report / block (App Store guideline 1.2).
struct UserProfileContent: View {
    let userId: String
    let onClose: () -> Void

    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @State private var stats: UserStats?
    @State private var routes: [RunRoute] = []
    @State private var theirFriends: [AppUser] = []
    @State private var friendsLoaded = false
    @State private var isFriend = false
    @State private var requestSent = false
    @State private var incomingRequest: FriendRequest?
    @State private var isBlocked = false
    @State private var isWorking = false
    @State private var loadFailed = false
    @State private var loadErrorText = "Comprueba tu conexión"
    @State private var errorMessage: String?
    @State private var infoMessage: String?
    @State private var reportTarget: ReportTarget?
    @State private var confirmBlock = false
    @State private var confirmUnblock = false
    @State private var confirmRemove = false
    @State private var showFullAvatar = false
    @State private var successCount = 0

    private var isMe: Bool { userId == session.userId }

    var body: some View {
        Group {
            if let stats {
                content(stats)
            } else if loadFailed {
                ErrorView(message: loadErrorText) { Task { await load() } }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .screenBackground()
        .navigationTitle(stats?.user.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .confirmationDialog(
            "¿Bloquear a \(stats?.user.name ?? "este usuario")?",
            isPresented: $confirmBlock,
            titleVisibility: .visible
        ) {
            Button("Bloquear", role: .destructive) { block() }
        } message: {
            Text("Dejaréis de ser amigos y no veréis la actividad, los comentarios ni las fotos del otro. No podrá enviarte solicitudes. No se le avisará.")
        }
        .confirmationDialog(
            "¿Desbloquear a \(stats?.user.name ?? "este usuario")?",
            isPresented: $confirmUnblock,
            titleVisibility: .visible
        ) {
            Button("Desbloquear") { unblock() }
        } message: {
            Text("Podrá volver a encontrarte y enviarte solicitudes de amistad. No volveréis a ser amigos automáticamente.")
        }
        .confirmationDialog(
            "¿Eliminar a \(stats?.user.name ?? "este usuario") de tus amigos?",
            isPresented: $confirmRemove,
            titleVisibility: .visible
        ) {
            Button("Eliminar de amigos", role: .destructive) { removeFriend() }
        } message: {
            Text("Dejaréis de ver vuestras carreras en el feed. Podéis volver a ser amigos cuando queráis.")
        }
        .reportSheet($reportTarget)
        .fullScreenCover(isPresented: $showFullAvatar) {
            if let user = stats?.user {
                AvatarFullScreenView(name: user.name, avatar: user.avatar, color: user.color)
            }
        }
        .alert("Listo", isPresented: Binding(get: { infoMessage != nil }, set: { if !$0 { infoMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(infoMessage ?? "")
        }
        .sensoryFeedback(.success, trigger: successCount)
        .errorAlert($errorMessage)
        .task { await load() }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button("Cerrar", action: onClose)
        }
        if !isMe && stats != nil {
            ToolbarItem(placement: .topBarLeading) {
                moreMenu
            }
        }
    }

    private var moreMenu: some View {
        Menu {
            if isFriend {
                Button(role: .destructive) {
                    confirmRemove = true
                } label: {
                    Label("Eliminar de amigos", systemImage: "person.badge.minus")
                }
            }
            Button {
                reportTarget = .user(userId)
            } label: {
                Label("Denunciar usuario", systemImage: "exclamationmark.bubble")
            }
            if isBlocked {
                Button {
                    confirmUnblock = true
                } label: {
                    Label("Desbloquear", systemImage: "hand.raised.slash")
                }
            } else {
                Button(role: .destructive) {
                    confirmBlock = true
                } label: {
                    Label("Bloquear usuario", systemImage: "hand.raised")
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .disabled(isWorking)
        .accessibilityLabel("Más opciones")
    }

    // MARK: - Content

    private func content(_ stats: UserStats) -> some View {
        List {
            Section {
                headerCard(stats)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            Section {
                statsGrid(stats)
                    .listRowInsets(EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12))
                    .listRowBackground(Color.surface)
                NavigationLink {
                    UserRoutesList(routes: routes, name: stats.user.name, color: stats.user.color, editable: isMe, onChange: { reloadRoutes() })
                } label: {
                    SocialSettingsLabel(
                        title: "Todas sus actividades",
                        systemImage: "figure.run",
                        tint: Color(hex: stats.user.color),
                        value: "\(max(stats.activitiesCount, routes.count))"
                    )
                }
                .listRowBackground(Color.surface)
            } header: {
                SocialSectionHeader(title: "Estadísticas", systemImage: "chart.bar.fill")
            }

            if !isMe && (stats.stolenFromViewer > 0 || stats.stolenByViewer > 0) {
                Section {
                    rivalryCard(stats)
                        .listRowBackground(Color.surface)
                } header: {
                    SocialSectionHeader(title: "Vuestro pique", systemImage: "flame.fill", tint: .steal)
                }
            }

            if !isBlocked {
                activitiesSection(stats)
                friendsSection
            }
        }
        .listStyle(.insetGrouped)
        .listBackground()
        .listSectionSpacing(DS.Spacing.l)
    }

    private func headerCard(_ stats: UserStats) -> some View {
        let tint = Color(hex: stats.user.color)
        return VStack(spacing: DS.Spacing.m) {
            Button {
                if stats.user.avatar != nil { showFullAvatar = true }
            } label: {
                AvatarView(name: stats.user.name, avatar: stats.user.avatar, color: stats.user.color, size: 112)
                    .shadow(color: tint.opacity(0.45), radius: 16, x: 0, y: 8)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Ver foto de perfil")

            VStack(spacing: 4) {
                Text(stats.user.displayName)
                    .font(.system(.title2, design: .rounded, weight: .heavy))
                    .multilineTextAlignment(.center)
                if !stats.user.username.isEmpty {
                    Text("@\(stats.user.username)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            HStack(spacing: 8) {
                SocialColorChip(color: stats.user.color)
                if let last = APIDate.parse(stats.lastActivity) {
                    StatPill(value: Format.relative(last), systemImage: "clock.fill", tint: .sky)
                }
            }

            if !isMe {
                relationshipControl
                    .padding(.top, 4)
            }
        }
        .padding(.horizontal, DS.Spacing.xl)
        .padding(.top, DS.Spacing.xxl)
        .padding(.bottom, DS.Spacing.xl)
        .frame(maxWidth: .infinity)
        .background { SocialHeroBackdrop(color: tint) }
        .clipShape(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous)
                .strokeBorder(Color.hairline, lineWidth: 1)
        }
    }

    private func statsGrid(_ stats: UserStats) -> some View {
        let area = Format.areaParts(stats.totalArea)
        let stolen = Format.areaParts(stats.totalStolen)
        let lost = Format.areaParts(stats.totalLost)
        let columns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
        return LazyVGrid(columns: columns, spacing: 10) {
            SocialStatCell(value: area.value, label: "Territorio", unit: area.unit, systemImage: "map.fill", tint: Color(hex: stats.user.color))
            SocialStatCell(value: "\(max(stats.activitiesCount, routes.count))", label: "Actividades", systemImage: "figure.run", tint: .sky)
            SocialStatCell(value: stolen.value, label: "Ha robado", unit: stolen.unit, systemImage: "bolt.fill", tint: .steal)
            SocialStatCell(value: lost.value, label: "Le han robado", unit: lost.unit, systemImage: "shield.lefthalf.filled", tint: .grape)
        }
    }

    private func rivalryCard(_ stats: UserStats) -> some View {
        let mine = stats.stolenByViewer
        let theirs = stats.stolenFromViewer
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center) {
                rivalSide(title: "Le has robado", amount: mine, tint: .brand, alignment: .leading)
                Spacer(minLength: 8)
                Text("VS")
                    .font(Font.stat(15, weight: .black))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                rivalSide(title: "Te ha robado", amount: theirs, tint: .steal, alignment: .trailing)
            }
            SocialDuelBar(left: mine, right: theirs, leftColor: .brand, rightColor: .steal)
            Text(rivalryVerdict(mine: mine, theirs: theirs, name: stats.user.name))
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 6)
    }

    private func rivalSide(title: String, amount: Double, tint: Color, alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: 2) {
            Text(Format.area(amount))
                .font(Font.stat(20))
                .monospacedDigit()
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(title)
                .statLabelStyle()
        }
        .accessibilityElement(children: .combine)
    }

    private func rivalryVerdict(mine: Double, theirs: Double, name: String) -> String {
        if mine > theirs * 1.2 {
            return "Vas ganando. \(name) querrá venganza…"
        } else if theirs > mine * 1.2 {
            return "\(name) te lleva ventaja. Toca salir a recuperar lo tuyo."
        }
        return "Empate técnico. La próxima carrera decide."
    }

    private func activitiesSection(_ stats: UserStats) -> some View {
        Section {
            if routes.isEmpty {
                HStack(spacing: 12) {
                    SocialIconTile(systemImage: "shoeprints.fill", tint: .secondary, size: 40)
                    Text(isMe ? "Aún no has salido a correr" : "Todavía no ha salido a correr")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .listRowBackground(Color.surface)
            }
            ForEach(routes.prefix(10)) { route in
                NavigationLink {
                    RouteDetailView(route: route, color: stats.user.color, editable: isMe, onChange: { reloadRoutes() })
                } label: {
                    RouteRow(route: route, color: Color(hex: stats.user.color))
                }
                .listRowBackground(Color.surface)
            }
            if routes.count > 10 {
                NavigationLink {
                    UserRoutesList(routes: routes, name: stats.user.name, color: stats.user.color, editable: isMe, onChange: { reloadRoutes() })
                } label: {
                    Text("Ver todas (\(routes.count))")
                        .font(.system(.subheadline, design: .rounded, weight: .semibold))
                        .foregroundStyle(Color.brand)
                }
                .listRowBackground(Color.surface)
            }
        } header: {
            SocialSectionHeader(title: "Actividades recientes", systemImage: "clock.arrow.circlepath", tint: .sky)
        }
    }

    private var friendsSection: some View {
        Section {
            if !friendsLoaded {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.surface)
            } else if theirFriends.isEmpty {
                Text("Sin amigos aún. ¿Serás el primero?")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.surface)
            }
            ForEach(theirFriends) { friend in
                NavigationLink {
                    UserProfileContent(userId: friend.id, onClose: onClose)
                } label: {
                    HStack {
                        PersonRow(name: friend.name, username: friend.username, avatar: friend.avatar, color: friend.color, size: 40)
                        Spacer(minLength: 8)
                        Text(Format.area(friend.totalArea))
                            .font(.system(.subheadline, design: .rounded, weight: .bold))
                            .foregroundStyle(Color(hex: friend.color))
                            .monospacedDigit()
                    }
                }
                .listRowBackground(Color.surface)
            }
        } header: {
            SocialSectionHeader(
                title: "Su crew",
                systemImage: "person.2.fill",
                count: friendsLoaded ? theirFriends.count : nil
            )
        }
    }

    @ViewBuilder
    private var relationshipControl: some View {
        if isBlocked {
            VStack(spacing: 8) {
                Label("Has bloqueado a este usuario", systemImage: "hand.raised.fill")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button {
                    confirmUnblock = true
                } label: {
                    SocialPillLabel(title: "Desbloquear", systemImage: "hand.raised.slash", tint: .secondary, kind: .soft)
                }
                .buttonStyle(.borderless)
                .disabled(isWorking)
            }
        } else if isFriend {
            Menu {
                Button(role: .destructive) {
                    confirmRemove = true
                } label: {
                    Label("Eliminar de amigos", systemImage: "person.badge.minus")
                }
            } label: {
                SocialPillLabel(title: "Sois amigos", systemImage: "person.2.fill", tint: .brand, kind: .soft)
            }
            .disabled(isWorking)
            .accessibilityHint("Abre opciones de amistad")
        } else if let incomingRequest {
            Button {
                accept(incomingRequest)
            } label: {
                pillOrProgress(SocialPillLabel(title: "Aceptar solicitud", systemImage: "person.badge.plus", tint: .brand, kind: .filled))
            }
            .buttonStyle(.borderless)
            .disabled(isWorking)
        } else if requestSent {
            SocialPillLabel(title: "Solicitud enviada", systemImage: "checkmark", tint: .secondary, kind: .soft)
        } else {
            Button {
                sendFriendRequest()
            } label: {
                pillOrProgress(SocialPillLabel(title: "Añadir amigo", systemImage: "person.badge.plus", tint: .brand, kind: .filled))
            }
            .buttonStyle(.borderless)
            .disabled(isWorking)
        }
    }

    @ViewBuilder
    private func pillOrProgress(_ pill: SocialPillLabel) -> some View {
        if isWorking {
            ProgressView()
                .frame(minWidth: 120, minHeight: 40)
        } else {
            pill
        }
    }

    // MARK: - Loading

    private func load() async {
        loadFailed = false
        do {
            stats = try await APIClient.shared.request("GET", "/api/users/\(userId)/stats", as: UserStats.self)
        } catch is CancellationError {
            return
        } catch {
            loadErrorText = error.localizedDescription
            loadFailed = true
            return
        }

        if let loaded = try? await APIClient.shared.request("GET", "/api/friends/\(userId)", as: [AppUser].self) {
            theirFriends = loaded.sorted { $0.totalArea > $1.totalArea }
        }
        friendsLoaded = true

        if let myId = session.userId, !isMe {
            isFriend = theirFriends.contains { $0.id == myId }
            if let blocked = try? await SafetyAPI.blockedUsers() {
                isBlocked = blocked.contains { $0.id == userId }
            }
            if !isFriend && !isBlocked {
                if let sent = try? await APIClient.shared.request("GET", "/api/friends/requests/sent/\(myId)", as: [FriendRequest].self) {
                    requestSent = sent.contains { $0.recipientId == userId && $0.status == "pending" }
                }
                if let incoming = try? await APIClient.shared.request("GET", "/api/friends/requests/\(myId)", as: [FriendRequest].self) {
                    incomingRequest = incoming.first { $0.senderId == userId && $0.status == "pending" }
                }
            }
        }
        await reloadRoutesNow()
    }

    private func reloadRoutes() {
        Task { await reloadRoutesNow() }
    }

    private func reloadRoutesNow() async {
        if let loaded = try? await APIClient.shared.request("GET", "/api/routes/\(userId)", as: [RunRoute].self) {
            routes = loaded
        }
    }

    // MARK: - Actions

    private func sendFriendRequest() {
        guard !isWorking, !requestSent else { return }
        isWorking = true
        Task {
            do {
                try await APIClient.shared.send("POST", "/api/friends", body: ["friendId": userId])
                requestSent = true
                successCount += 1
            } catch {
                errorMessage = error.localizedDescription
            }
            isWorking = false
        }
    }

    private func accept(_ request: FriendRequest) {
        guard !isWorking else { return }
        isWorking = true
        Task {
            do {
                let result = try await APIClient.shared.request(
                    "POST", "/api/friends/requests/\(request.id)/accept", body: [:], as: AcceptInviteResponse.self
                )
                successCount += 1
                await session.refreshUser()
                incomingRequest = nil
                isFriend = true
                infoMessage = FriendshipFeedback.message(for: result, myColor: session.user?.color)
                router.reloadSignal += 1
            } catch {
                errorMessage = error.localizedDescription
            }
            isWorking = false
        }
    }

    private func removeFriend() {
        guard !isWorking else { return }
        isWorking = true
        Task {
            do {
                try await APIClient.shared.send("DELETE", "/api/friends/\(userId)", body: [:])
                Haptics.tap()
                isFriend = false
                requestSent = false
                if let myId = session.userId {
                    theirFriends.removeAll { $0.id == myId }
                }
                router.reloadSignal += 1
            } catch {
                errorMessage = error.localizedDescription
            }
            isWorking = false
        }
    }

    private func block() {
        guard !isWorking else { return }
        isWorking = true
        Task {
            do {
                try await SafetyAPI.block(userId: userId)
                isBlocked = true
                isFriend = false
                requestSent = false
                incomingRequest = nil
                successCount += 1
                infoMessage = "Has bloqueado a \(stats?.user.name ?? "este usuario"). Puedes desbloquearlo desde Perfil > Usuarios bloqueados."
                router.reloadSignal += 1
            } catch {
                errorMessage = error.localizedDescription
            }
            isWorking = false
        }
    }

    private func unblock() {
        guard !isWorking else { return }
        isWorking = true
        Task {
            do {
                try await SafetyAPI.unblock(userId: userId)
                isBlocked = false
                successCount += 1
                router.reloadSignal += 1
                await reloadRoutesNow()
            } catch {
                errorMessage = error.localizedDescription
            }
            isWorking = false
        }
    }
}

/// All activities of a runner, each opening its detail (map, stats).
struct UserRoutesList: View {
    let routes: [RunRoute]
    let name: String
    let color: String
    let editable: Bool
    let onChange: () -> Void

    var body: some View {
        List {
            ForEach(routes) { route in
                NavigationLink {
                    RouteDetailView(route: route, color: color, editable: editable, onChange: onChange)
                } label: {
                    RouteRow(route: route, color: Color(hex: color))
                }
                .listRowBackground(Color.surface)
            }
        }
        .listStyle(.insetGrouped)
        .listBackground()
        .overlay {
            if routes.isEmpty {
                EmptyStateView(
                    systemImage: "shoeprints.fill",
                    title: "Zapatillas sin estrenar",
                    message: "Aún no hay rutas registradas. La primera carrera pinta el mapa."
                )
            }
        }
        .navigationTitle("Actividades de \(name)")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Profile photo at full size; tap anywhere to close.
private struct AvatarFullScreenView: View {
    let name: String
    let avatar: String?
    let color: String

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            Color.black.opacity(0.92).ignoresSafeArea()
            Group {
                if let image = AvatarImageCache.image(for: avatar) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                } else if let avatar, avatar.hasPrefix("http"), let url = URL(string: avatar) {
                    AsyncImage(url: url) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFit()
                        } else {
                            ProgressView().tint(.white)
                        }
                    }
                } else {
                    AvatarView(name: name, avatar: nil, color: color, size: 200)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
            .padding(24)
        }
        .overlay(alignment: .topTrailing) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(Color.white)
                    .frame(width: 40, height: 40)
                    .background(Color.white.opacity(0.18), in: Circle())
            }
            .padding()
            .accessibilityLabel("Cerrar")
        }
        .contentShape(Rectangle())
        .onTapGesture { dismiss() }
    }
}

/// One activity in a list: route shape, name, date, distance and time.
struct RouteRow: View {
    let route: RunRoute
    let color: Color

    var body: some View {
        HStack(spacing: 14) {
            thumbnail
            VStack(alignment: .leading, spacing: 5) {
                Text(route.name)
                    .font(.system(.subheadline, design: .rounded, weight: .bold))
                    .lineLimit(1)
                Text(Format.dayAndTime(route.startDate))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                metrics
            }
        }
        .padding(.vertical, 3)
    }

    private var thumbnail: some View {
        RouteShape(coordinates: route.coordinates)
            .stroke(color, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
            .frame(width: 48, height: 48)
            .padding(6)
            .background(
                LinearGradient(colors: [color.opacity(0.18), color.opacity(0.06)], startPoint: .topLeading, endPoint: .bottomTrailing),
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
            .accessibilityHidden(true)
    }

    private var metrics: some View {
        HStack(spacing: 10) {
            metric(Format.distance(route.distance), systemImage: "figure.run")
            metric(Format.duration(route.duration), systemImage: "stopwatch")
            if let area = route.territoryArea, area > 0 {
                metric(Format.area(area), systemImage: "flag.fill", tint: color)
            }
        }
    }

    private func metric(_ text: String, systemImage: String, tint: Color? = nil) -> some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(tint ?? Color.secondary)
            Text(text)
                .font(.system(.caption, design: .rounded, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(tint ?? Color.secondary)
                .lineLimit(1)
        }
    }
}
