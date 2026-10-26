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
            Image(systemName: "ellipsis")
        }
        .disabled(isWorking)
        .accessibilityLabel("Más opciones")
    }

    // MARK: - Content

    private func content(_ stats: UserStats) -> some View {
        List {
            Section {
                headerView(stats)
                    .listRowInsets(EdgeInsets(top: DS.Spacing.s, leading: DS.Spacing.l, bottom: DS.Spacing.s, trailing: DS.Spacing.l))
                    .listRowBackground(Color.clear)
            }

            Section {
                statsGrid(stats)
                    .listRowInsets(EdgeInsets(top: DS.Spacing.l, leading: DS.Spacing.s, bottom: DS.Spacing.l, trailing: DS.Spacing.s))
                    .listRowBackground(Color.surface)
                NavigationLink {
                    UserRoutesList(routes: routes, name: stats.user.name, color: stats.user.color, editable: isMe, onChange: { reloadRoutes() })
                } label: {
                    SocialSettingsLabel(
                        title: "Todas sus actividades",
                        systemImage: "figure.run",
                        value: "\(max(stats.activitiesCount, routes.count))"
                    )
                }
                .listRowBackground(Color.surface)
            } header: {
                SocialSectionHeader(title: "Estadísticas")
            }

            if !isMe && (stats.stolenFromViewer > 0 || stats.stolenByViewer > 0) {
                Section {
                    rivalryCard(stats)
                        .listRowBackground(Color.surface)
                } header: {
                    SocialSectionHeader(title: "Entre vosotros")
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

    /// Avatar, name, @username, territory colour and last activity; then the relationship action.
    private func headerView(_ stats: UserStats) -> some View {
        VStack(spacing: DS.Spacing.m) {
            Button {
                if stats.user.avatar != nil { showFullAvatar = true }
            } label: {
                AvatarView(name: stats.user.name, avatar: stats.user.avatar, color: stats.user.color, size: 88)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Ver foto de perfil")

            VStack(spacing: 4) {
                Text(stats.user.displayName)
                    .font(.title2.weight(.bold))
                    .multilineTextAlignment(.center)
                if !stats.user.username.isEmpty {
                    Text("@\(stats.user.username)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            HStack(spacing: 10) {
                SocialColorChip(color: stats.user.color)
                if let last = APIDate.parse(stats.lastActivity) {
                    Text("·")
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                    Text("Activo \(Format.relative(last))")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            if !isMe {
                relationshipControl
                    .frame(maxWidth: 280)
                    .padding(.top, DS.Spacing.xs)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func statsGrid(_ stats: UserStats) -> some View {
        let area = Format.areaParts(stats.totalArea)
        let stolen = Format.areaParts(stats.totalStolen)
        let lost = Format.areaParts(stats.totalLost)
        let activities = "\(max(stats.activitiesCount, routes.count))"
        return VStack(spacing: DS.Spacing.l) {
            HStack(spacing: 0) {
                StatTile(value: area.value, label: "Territorio", unit: area.unit)
                StatDivider()
                StatTile(value: activities, label: "Actividades")
            }
            HairlineDivider()
                .padding(.horizontal, DS.Spacing.s)
            HStack(spacing: 0) {
                StatTile(value: stolen.value, label: "Ha robado", unit: stolen.unit)
                StatDivider()
                StatTile(value: lost.value, label: "Le han robado", unit: lost.unit, tint: .steal)
            }
        }
    }

    private func rivalryCard(_ stats: UserStats) -> some View {
        let mine = stats.stolenByViewer
        let theirs = stats.stolenFromViewer
        return VStack(alignment: .leading, spacing: DS.Spacing.m) {
            HStack(spacing: 0) {
                rivalSide(title: "Le has robado", amount: mine, tint: .brand, alignment: .leading)
                StatDivider()
                rivalSide(title: "Te ha robado", amount: theirs, tint: .steal, alignment: .trailing)
            }
            SocialDuelBar(left: mine, right: theirs, leftColor: .brand)
            Text(rivalryVerdict(mine: mine, theirs: theirs, name: stats.user.name))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, DS.Spacing.xs)
    }

    private func rivalSide(title: String, amount: Double, tint: Color, alignment: HorizontalAlignment) -> some View {
        let parts = Format.areaParts(amount)
        return VStack(alignment: alignment, spacing: 4) {
            StatValue(value: parts.value, unit: parts.unit, font: Font.statNumber, tint: tint)
            Text(title)
                .statLabelStyle()
        }
        .frame(maxWidth: .infinity, alignment: alignment == .leading ? .leading : .trailing)
        .accessibilityElement(children: .combine)
    }

    private func rivalryVerdict(mine: Double, theirs: Double, name: String) -> String {
        if mine > theirs * 1.2 {
            return "Vas por delante en esta rivalidad."
        } else if theirs > mine * 1.2 {
            return "\(name) va por delante en esta rivalidad."
        }
        return "Estáis igualados."
    }

    private func activitiesSection(_ stats: UserStats) -> some View {
        Section {
            if routes.isEmpty {
                Text(isMe ? "Aún no has registrado ninguna carrera." : "Todavía no ha registrado ninguna carrera.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
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
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.brand)
                }
                .listRowBackground(Color.surface)
            }
        } header: {
            SocialSectionHeader(title: "Actividades recientes")
        }
    }

    private var friendsSection: some View {
        Section {
            if !friendsLoaded {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.surface)
            } else if theirFriends.isEmpty {
                Text("Todavía no tiene amigos.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.surface)
            }
            ForEach(theirFriends) { friend in
                NavigationLink {
                    UserProfileContent(userId: friend.id, onClose: onClose)
                } label: {
                    friendLabel(friend)
                }
                .listRowBackground(Color.surface)
            }
        } header: {
            SocialSectionHeader(
                title: "Amigos",
                count: friendsLoaded ? theirFriends.count : nil
            )
        }
    }

    private func friendLabel(_ friend: AppUser) -> some View {
        let parts = Format.areaParts(friend.totalArea)
        return HStack {
            PersonRow(name: friend.name, username: friend.username, avatar: friend.avatar, color: friend.color, size: 40)
            Spacer(minLength: 8)
            StatValue(value: parts.value, unit: parts.unit, font: Font.stat(17, weight: .semibold))
        }
    }

    @ViewBuilder
    private var relationshipControl: some View {
        if isBlocked {
            VStack(spacing: 8) {
                Label("Has bloqueado a este usuario", systemImage: "hand.raised")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button {
                    confirmUnblock = true
                } label: {
                    SocialPillLabel(title: "Desbloquear", tint: .primary, kind: .soft, expand: true)
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
                SocialPillLabel(title: "Amigos", systemImage: "checkmark", tint: .primary, kind: .soft, expand: true)
            }
            .disabled(isWorking)
            .accessibilityHint("Abre opciones de amistad")
        } else if let incomingRequest {
            Button {
                accept(incomingRequest)
            } label: {
                pillOrProgress(SocialPillLabel(title: "Aceptar solicitud", tint: .brand, kind: .filled, expand: true))
            }
            .buttonStyle(.borderless)
            .disabled(isWorking)
        } else if requestSent {
            SocialPillLabel(title: "Solicitud enviada", systemImage: "clock", tint: .secondary, kind: .soft, expand: true)
        } else {
            Button {
                sendFriendRequest()
            } label: {
                pillOrProgress(SocialPillLabel(title: "Añadir amigo", systemImage: "person.badge.plus", tint: .brand, kind: .filled, expand: true))
            }
            .buttonStyle(.borderless)
            .disabled(isWorking)
        }
    }

    @ViewBuilder
    private func pillOrProgress(_ pill: SocialPillLabel) -> some View {
        if isWorking {
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: 40)
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
                    systemImage: "figure.run",
                    title: "Sin actividades",
                    message: "Todavía no hay carreras registradas."
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
            VStack(alignment: .leading, spacing: 3) {
                Text(route.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(Format.dayAndTime(route.startDate))
                    .font(Font.meta)
                    .foregroundStyle(.secondary)
                metrics
                    .padding(.top, 2)
            }
        }
        .padding(.vertical, 2)
    }

    private var thumbnail: some View {
        RouteShape(coordinates: route.coordinates)
            .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            .frame(width: 44, height: 44)
            .padding(6)
            .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
            .hairlineBorder(radius: DS.Radius.tile)
            .accessibilityHidden(true)
    }

    private var metrics: some View {
        HStack(spacing: 6) {
            metric(Format.distance(route.distance))
            separator
            metric(Format.duration(route.duration))
            if let area = route.territoryArea, area > 0 {
                separator
                metric(Format.area(area))
            }
        }
    }

    private var separator: some View {
        Text("·")
            .font(.footnote)
            .foregroundStyle(.tertiary)
    }

    private func metric(_ text: String) -> some View {
        Text(text)
            .font(.footnote.weight(.medium))
            .monospacedDigit()
            .foregroundStyle(Color.primary.opacity(0.8))
            .lineLimit(1)
    }
}
