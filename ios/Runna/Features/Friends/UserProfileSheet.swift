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
    @State private var showFullAvatar = false

    private var isMe: Bool { userId == session.userId }

    var body: some View {
        Group {
            if let stats {
                content(stats)
            } else if loadFailed {
                ErrorView(message: loadErrorText) { Task { await load() } }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(stats?.user.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Cerrar", action: onClose)
            }
            if !isMe && stats != nil {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
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
            }
        }
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
        .errorAlert($errorMessage)
        .task { await load() }
    }

    // MARK: - Content

    private func content(_ stats: UserStats) -> some View {
        List {
            Section {
                VStack(spacing: 10) {
                    Button {
                        showFullAvatar = true
                    } label: {
                        AvatarView(name: stats.user.name, avatar: stats.user.avatar, color: stats.user.color, size: 84)
                    }
                    .buttonStyle(.plain)
                    .disabled(stats.user.avatar == nil)
                    .accessibilityLabel("Ver foto de perfil")
                    Text(stats.user.displayName).font(.title2.bold()).multilineTextAlignment(.center)
                    if !stats.user.username.isEmpty {
                        Text("@\(stats.user.username)").foregroundStyle(.secondary)
                    }
                    if !isMe {
                        relationshipControl
                    }
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
            }

            Section("Estadísticas") {
                LabeledContent("Territorio", value: Format.area(stats.totalArea))
                NavigationLink {
                    UserRoutesList(routes: routes, name: stats.user.name, color: stats.user.color, editable: isMe, onChange: { reloadRoutes() })
                } label: {
                    LabeledContent("Actividades", value: "\(max(stats.activitiesCount, routes.count))")
                }
                if let last = APIDate.parse(stats.lastActivity) {
                    LabeledContent("Última actividad", value: Format.relative(last))
                }
                LabeledContent("Ha robado en total", value: Format.area(stats.totalStolen))
                LabeledContent("Le han robado", value: Format.area(stats.totalLost))
                LabeledContent("Color de territorio") {
                    HStack(spacing: 8) {
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(Color(hex: stats.user.color))
                            .frame(width: 22, height: 22)
                        Text(AppConfig.userColorNames[stats.user.color.uppercased()] ?? "Personalizado")
                    }
                }
            }

            if !isMe && (stats.stolenFromViewer > 0 || stats.stolenByViewer > 0) {
                Section("Vuestra rivalidad") {
                    LabeledContent("Te ha robado", value: Format.area(stats.stolenFromViewer))
                    LabeledContent("Le has robado", value: Format.area(stats.stolenByViewer))
                }
            }

            if !isBlocked {
                Section("Actividades recientes") {
                    if routes.isEmpty {
                        Text("Sin actividades todavía")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(routes.prefix(10)) { route in
                        NavigationLink {
                            RouteDetailView(route: route, color: stats.user.color, editable: isMe, onChange: { reloadRoutes() })
                        } label: {
                            RouteRow(route: route, color: Color(hex: stats.user.color))
                        }
                    }
                    if routes.count > 10 {
                        NavigationLink("Ver todas (\(routes.count))") {
                            UserRoutesList(routes: routes, name: stats.user.name, color: stats.user.color, editable: isMe, onChange: { reloadRoutes() })
                        }
                    }
                }

                Section(friendsLoaded ? "Amigos (\(theirFriends.count))" : "Amigos") {
                    if !friendsLoaded {
                        ProgressView().frame(maxWidth: .infinity)
                    } else if theirFriends.isEmpty {
                        Text("Sin amigos aún")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(theirFriends) { friend in
                        NavigationLink {
                            UserProfileContent(userId: friend.id, onClose: onClose)
                        } label: {
                            HStack {
                                PersonRow(name: friend.name, username: friend.username, avatar: friend.avatar, color: friend.color)
                                Spacer()
                                Text(Format.area(friend.totalArea))
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var relationshipControl: some View {
        if isBlocked {
            VStack(spacing: 8) {
                Label("Has bloqueado a este usuario", systemImage: "hand.raised.fill")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Button("Desbloquear") { confirmUnblock = true }
                    .buttonStyle(.bordered)
                    .disabled(isWorking)
            }
        } else if isFriend {
            Label("Sois amigos", systemImage: "person.2.fill")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.brand)
        } else if let incomingRequest {
            Button {
                accept(incomingRequest)
            } label: {
                if isWorking {
                    ProgressView()
                } else {
                    Label("Aceptar solicitud de amistad", systemImage: "person.badge.plus")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(isWorking)
        } else {
            Button {
                sendFriendRequest()
            } label: {
                if isWorking {
                    ProgressView()
                } else {
                    Label(requestSent ? "Solicitud enviada" : "Añadir amigo", systemImage: requestSent ? "checkmark" : "person.badge.plus")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(requestSent || isWorking)
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
                Haptics.success()
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
                Haptics.success()
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
                Haptics.success()
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
                Haptics.success()
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
            }
        }
        .overlay {
            if routes.isEmpty {
                EmptyStateView(
                    systemImage: "figure.run",
                    title: "Sin actividades",
                    message: "Este usuario aún no tiene rutas registradas."
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
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .padding(24)
        }
        .overlay(alignment: .topTrailing) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.white)
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
            RouteShape(coordinates: route.coordinates)
                .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                .frame(width: 52, height: 52)
                .padding(4)
                .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                Text(route.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(Format.dayAndTime(route.startDate))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(spacing: 10) {
                    Label(Format.distance(route.distance), systemImage: "figure.run")
                    Label(Format.duration(route.duration), systemImage: "stopwatch")
                    if let area = route.territoryArea, area > 0 {
                        Label(Format.area(area), systemImage: "flag")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .labelStyle(.titleAndIcon)
            }
        }
        .padding(.vertical, 2)
    }
}
