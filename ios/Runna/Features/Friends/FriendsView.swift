import SwiftUI

struct FriendsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @State private var friends: [AppUser] = []
    @State private var incoming: [FriendRequest] = []
    @State private var sent: [FriendRequest] = []
    @State private var isLoading = false
    @State private var hasLoaded = false
    @State private var errorMessage: String?
    @State private var alertMessage: String?
    @State private var showSearch = false
    @State private var searchSeed = ""
    @State private var friendQuery = ""
    @State private var inviteURL: URL?
    @State private var inviteCreatedAt: Date?
    @State private var isCreatingInvite = false
    @State private var profileUserId: String?
    @State private var friendToRemove: AppUser?
    @State private var busyIds: Set<String> = []
    @State private var inviteToConfirm: InviteToken?
    @State private var acceptedCount = 0

    /// Invites last 7 days on the server; a link older than this is regenerated before sharing.
    private static let inviteMaxAge: TimeInterval = 6 * 24 * 3600

    var body: some View {
        NavigationStack {
            list
                .navigationTitle("Amigos")
                .toolbar { toolbarContent }
                .refreshable { await load() }
                .task(id: router.reloadSignal) { await load() }
                .task(id: router.pendingInviteToken) { takePendingInvite() }
                .sheet(isPresented: $showSearch, onDismiss: {
                    searchSeed = ""
                    Task { await load() }
                }) {
                    UserSearchView(
                        friendIds: Set(friends.map(\.id)),
                        pendingIds: Set(sent.map(\.recipientId)),
                        initialQuery: searchSeed
                    )
                }
                .sheet(item: profileTarget, onDismiss: { Task { await load() } }) { target in
                    UserProfileSheet(userId: target.id)
                }
                .sheet(item: $inviteToConfirm) { invite in
                    InviteConfirmationSheet(token: invite.id) { message in
                        alertMessage = message
                        Task { await load() }
                    }
                }
                .confirmationDialog(
                    "¿Eliminar a \(friendToRemove?.name ?? "") de tus amigos?",
                    isPresented: Binding(get: { friendToRemove != nil }, set: { if !$0 { friendToRemove = nil } }),
                    titleVisibility: .visible
                ) {
                    Button("Eliminar", role: .destructive) {
                        if let friend = friendToRemove { remove(friend) }
                    }
                } message: {
                    Text("Dejaréis de ver vuestras carreras en el feed. Podéis volver a ser amigos cuando queráis.")
                }
                .alert("Amigos", isPresented: Binding(get: { alertMessage != nil }, set: { if !$0 { alertMessage = nil } })) {
                    Button("OK", role: .cancel) {}
                } message: {
                    Text(alertMessage ?? "")
                }
                .sensoryFeedback(.success, trigger: acceptedCount)
        }
    }

    private var profileTarget: Binding<FriendTarget?> {
        Binding(
            get: { profileUserId.map { FriendTarget(id: $0) } },
            set: { profileUserId = $0?.id }
        )
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button {
                openSearch()
            } label: {
                Image(systemName: "person.badge.plus")
            }
            .accessibilityLabel("Buscar corredores")
        }
    }

    // MARK: - List

    private var list: some View {
        List {
            heroSection
            if !incoming.isEmpty {
                incomingSection
            }
            friendsSection
            if !sent.isEmpty {
                sentSection
            }
        }
        .listStyle(.insetGrouped)
        .listBackground()
        .listSectionSpacing(DS.Spacing.l)
        .searchable(text: $friendQuery, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Buscar entre tus amigos")
        .animation(.snappy, value: friends.map(\.id))
        .animation(.snappy, value: incoming.map(\.id))
        .animation(.snappy, value: sent.map(\.id))
        .overlay {
            if let errorMessage, friends.isEmpty, incoming.isEmpty {
                ErrorView(message: errorMessage) { Task { await load() } }
                    .background(Color.canvas)
            }
        }
    }

    private var heroSection: some View {
        Section {
            FriendsInviteHero(
                friendCount: friends.count,
                pendingCount: incoming.count,
                inviteURL: currentInviteURL,
                isCreating: isCreatingInvite,
                onCreate: { createInvite() },
                onSearch: { openSearch() }
            )
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
    }

    private var incomingSection: some View {
        Section {
            ForEach(incoming) { request in
                if let sender = request.sender {
                    incomingRow(request, sender: sender)
                        .listRowBackground(Color.surface)
                }
            }
        } header: {
            SocialSectionHeader(title: "Te quieren en su crew", systemImage: "bell.badge.fill", count: incoming.count, tint: .steal)
        }
    }

    private var friendsSection: some View {
        Section {
            if friends.isEmpty {
                if hasLoaded && errorMessage == nil {
                    emptyFriends
                } else if isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                        .listRowBackground(Color.clear)
                }
            } else if filteredFriends.isEmpty {
                noMatchesRow
            } else {
                ForEach(filteredFriends) { friend in
                    friendRow(friend)
                        .listRowBackground(Color.surface)
                }
            }
        } header: {
            SocialSectionHeader(title: "Tu crew", systemImage: "person.2.fill", count: friends.count)
        } footer: {
            if !friends.isEmpty && friendQuery.isEmpty {
                Text("Ordenados por territorio. Desliza a la izquierda para eliminar a alguien.")
            }
        }
    }

    private var sentSection: some View {
        Section {
            ForEach(sent) { request in
                if let recipient = request.recipient {
                    sentRow(request, recipient: recipient)
                        .listRowBackground(Color.surface)
                }
            }
        } header: {
            SocialSectionHeader(title: "Esperando respuesta", systemImage: "paperplane.fill", count: sent.count, tint: .sky)
        }
    }

    private var filteredFriends: [AppUser] {
        let text = friendQuery.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return friends }
        return friends.filter { friend in
            friend.name.localizedCaseInsensitiveContains(text)
                || friend.username.localizedCaseInsensitiveContains(text)
                || (friend.nickname?.localizedCaseInsensitiveContains(text) ?? false)
        }
    }

    private var emptyFriends: some View {
        EmptyStateView(
            systemImage: "figure.2.arms.open",
            title: "Corres en solitario… de momento",
            message: "Invita a tu crew o búscalos por nombre y empezad a robaros territorio.",
            actionTitle: "Buscar corredores",
            action: { openSearch() }
        )
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
    }

    private var noMatchesRow: some View {
        Button {
            searchSeed = friendQuery.trimmingCharacters(in: .whitespaces)
            showSearch = true
        } label: {
            HStack(spacing: 12) {
                SocialIconTile(systemImage: "magnifyingglass", tint: .sky, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Nadie con «\(friendQuery)» en tu crew")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    Text("Búscalo en todo Runna.io")
                        .font(.caption)
                        .foregroundStyle(Color.sky)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .listRowBackground(Color.surface)
    }

    // MARK: - Rows

    private func friendRow(_ friend: AppUser) -> some View {
        Button {
            profileUserId = friend.id
        } label: {
            FriendsListRow(friend: friend, isBusy: busyIds.contains(friend.id))
        }
        .buttonStyle(.plain)
        .swipeActions {
            Button("Eliminar", systemImage: "person.badge.minus", role: .destructive) { friendToRemove = friend }
        }
        .contextMenu {
            Button("Ver perfil", systemImage: "person.crop.circle") { profileUserId = friend.id }
            Button("Eliminar de amigos", systemImage: "person.badge.minus", role: .destructive) { friendToRemove = friend }
        }
    }

    private func incomingRow(_ request: FriendRequest, sender: UserRef) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                profileUserId = sender.id
            } label: {
                HStack(spacing: 12) {
                    AvatarView(name: sender.name, avatar: sender.avatar, color: sender.color, size: 48)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(sender.name)
                            .font(.system(.body, design: .rounded, weight: .semibold))
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                        Text(requestSubtitle(username: sender.username, date: request.createdAt, fallback: "Quiere unirse a tu crew"))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)

            if busyIds.contains(request.id) {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 40)
            } else {
                HStack(spacing: 10) {
                    Button {
                        respond(to: request, accept: true)
                    } label: {
                        SocialPillLabel(title: "Aceptar", systemImage: "checkmark", tint: .brand, kind: .filled, expand: true)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Aceptar a \(sender.name)")

                    Button {
                        respond(to: request, accept: false)
                    } label: {
                        SocialPillLabel(title: "Rechazar", systemImage: "xmark", tint: .secondary, kind: .soft, expand: true)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Rechazar a \(sender.name)")
                }
            }
        }
        .padding(.vertical, 6)
    }

    private func sentRow(_ request: FriendRequest, recipient: UserRef) -> some View {
        HStack(spacing: 12) {
            Button {
                profileUserId = recipient.id
            } label: {
                HStack(spacing: 12) {
                    AvatarView(name: recipient.name, avatar: recipient.avatar, color: recipient.color, size: 42)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(recipient.name)
                            .font(.system(.subheadline, design: .rounded, weight: .semibold))
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                        Text(requestSubtitle(username: recipient.username, date: request.createdAt, fallback: "Solicitud enviada"))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)

            if busyIds.contains(request.id) {
                ProgressView()
            } else {
                Button {
                    cancel(request)
                } label: {
                    SocialPillLabel(title: "Cancelar", tint: .steal, kind: .soft, compact: true)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Cancelar solicitud a \(recipient.name)")
            }
        }
        .padding(.vertical, 2)
    }

    private func requestSubtitle(username: String, date: String?, fallback: String) -> String {
        var parts: [String] = []
        if !username.isEmpty { parts.append("@\(username)") }
        if let parsed = APIDate.parse(date) { parts.append(Format.relative(parsed)) }
        return parts.isEmpty ? fallback : parts.joined(separator: " · ")
    }

    private var currentInviteURL: URL? {
        guard let inviteURL, let inviteCreatedAt, Date().timeIntervalSince(inviteCreatedAt) < Self.inviteMaxAge else { return nil }
        return inviteURL
    }

    // MARK: - Actions

    private func openSearch() {
        searchSeed = ""
        showSearch = true
    }

    private func load() async {
        guard let userId = session.userId else { return }
        isLoading = true
        defer {
            isLoading = false
            hasLoaded = true
        }
        do {
            async let friendsRequest = APIClient.shared.request("GET", "/api/friends/\(userId)", as: [AppUser].self)
            async let incomingRequest = APIClient.shared.request("GET", "/api/friends/requests/\(userId)", as: [FriendRequest].self)
            async let sentRequest = APIClient.shared.request("GET", "/api/friends/requests/sent/\(userId)", as: [FriendRequest].self)
            let (loadedFriends, loadedIncoming, loadedSent) = try await (friendsRequest, incomingRequest, sentRequest)
            friends = loadedFriends.sorted { $0.totalArea > $1.totalArea }
            incoming = loadedIncoming.filter { $0.status == "pending" }
            sent = loadedSent.filter { $0.status == "pending" }
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func respond(to request: FriendRequest, accept: Bool) {
        guard !busyIds.contains(request.id) else { return }
        busyIds.insert(request.id)
        Task {
            do {
                let action = accept ? "accept" : "reject"
                let result = try await APIClient.shared.request("POST", "/api/friends/requests/\(request.id)/\(action)", body: [:], as: AcceptInviteResponse.self)
                if accept {
                    acceptedCount += 1
                    await session.refreshUser()
                    alertMessage = FriendshipFeedback.message(for: result, myColor: session.user?.color)
                } else {
                    Haptics.tap()
                }
                incoming.removeAll { $0.id == request.id }
                await load()
            } catch {
                alertMessage = error.localizedDescription
                await load()
            }
            busyIds.remove(request.id)
        }
    }

    private func cancel(_ request: FriendRequest) {
        guard !busyIds.contains(request.id) else { return }
        busyIds.insert(request.id)
        Task {
            do {
                try await APIClient.shared.send("DELETE", "/api/friends/requests/\(request.id)")
                Haptics.tap()
                sent.removeAll { $0.id == request.id }
                await load()
            } catch {
                alertMessage = error.localizedDescription
            }
            busyIds.remove(request.id)
        }
    }

    private func remove(_ friend: AppUser) {
        guard !busyIds.contains(friend.id) else { return }
        busyIds.insert(friend.id)
        Task {
            do {
                try await APIClient.shared.send("DELETE", "/api/friends/\(friend.id)", body: [:])
                Haptics.tap()
                friends.removeAll { $0.id == friend.id }
                await load()
            } catch {
                alertMessage = error.localizedDescription
            }
            busyIds.remove(friend.id)
        }
    }

    private func createInvite() {
        guard !isCreatingInvite else { return }
        isCreatingInvite = true
        Task {
            do {
                let invite = try await APIClient.shared.request("POST", "/api/friends/invite", body: [:], as: InviteResponse.self)
                inviteURL = URL(string: invite.url)
                inviteCreatedAt = Date()
                Haptics.success()
            } catch {
                alertMessage = error.localizedDescription
            }
            isCreatingInvite = false
        }
    }

    /// An invite link was opened (runnaio://friends/accept/<token>): ask before accepting it.
    private func takePendingInvite() {
        guard let token = router.pendingInviteToken else { return }
        router.pendingInviteToken = nil
        inviteToConfirm = InviteToken(id: token)
    }
}

private struct FriendTarget: Identifiable {
    let id: String
}

private struct InviteToken: Identifiable {
    let id: String
}

// MARK: - Invite hero

/// Gradient hero at the top of Friends: invite link (create / share / renew) and search.
private struct FriendsInviteHero: View {
    let friendCount: Int
    let pendingCount: Int
    let inviteURL: URL?
    let isCreating: Bool
    let onCreate: () -> Void
    let onSearch: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.l) {
            header
            actions
            Text("El enlace caduca en 7 días y es de un solo uso. Quien lo acepte entra directo en tu crew.")
                .font(.caption)
                .foregroundStyle(Color.white.opacity(0.85))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(DS.Spacing.xl)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { backdrop }
        .clipShape(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
        .shadow(color: Color.brand.opacity(0.30), radius: 14, x: 0, y: 8)
        .padding(.vertical, 4)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Trae a tu crew")
                    .font(.system(.title2, design: .rounded, weight: .heavy))
                    .foregroundStyle(Color.white)
                Text("Cuantos más seáis, más territorio que robaros.")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.white.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            countBubble
        }
    }

    private var countBubble: some View {
        VStack(spacing: 0) {
            Text("\(friendCount)")
                .font(Font.stat(26, weight: .heavy))
                .monospacedDigit()
                .contentTransition(.numericText())
            Text(friendCount == 1 ? "amigo" : "amigos")
                .font(.system(.caption2, design: .rounded, weight: .bold))
                .textCase(.uppercase)
        }
        .foregroundStyle(Color.white)
        .frame(width: 70, height: 70)
        .background(Color.white.opacity(0.18), in: Circle())
        .overlay(Circle().strokeBorder(Color.white.opacity(0.35), lineWidth: 1))
        .overlay(alignment: .topTrailing) {
            if pendingCount > 0 {
                CountBadge(count: pendingCount)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var actions: some View {
        HStack(spacing: 10) {
            if let inviteURL {
                ShareLink(
                    item: inviteURL,
                    subject: Text("Únete a Runna.io"),
                    message: Text("¡Compite conmigo en Runna.io! Corre y conquista la ciudad:")
                ) {
                    primaryLabel(title: "Compartir invitación", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.borderless)

                Button(action: onCreate) {
                    circleLabel(systemImage: "arrow.clockwise", busy: isCreating)
                }
                .buttonStyle(.borderless)
                .disabled(isCreating)
                .accessibilityLabel("Generar un enlace nuevo")
            } else {
                Button(action: onCreate) {
                    if isCreating {
                        primaryLabel(title: "Creando enlace…", systemImage: nil, busy: true)
                    } else {
                        primaryLabel(title: "Invitar amigos", systemImage: "link")
                    }
                }
                .buttonStyle(.borderless)
                .disabled(isCreating)
            }

            Button(action: onSearch) {
                circleLabel(systemImage: "magnifyingglass", busy: false)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Buscar corredores")
        }
    }

    private func primaryLabel(title: String, systemImage: String?, busy: Bool = false) -> some View {
        HStack(spacing: 8) {
            if busy {
                ProgressView()
                    .tint(Color.brandDeep)
            } else if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 15, weight: .bold))
            }
            Text(title)
                .font(.system(.headline, design: .rounded, weight: .bold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .foregroundStyle(Color.brandDeep)
        .padding(.horizontal, 18)
        .frame(maxWidth: .infinity, minHeight: 48)
        .background(Color.white, in: Capsule())
        .shadow(color: Color.black.opacity(0.12), radius: 6, x: 0, y: 3)
        .contentShape(Capsule())
    }

    private func circleLabel(systemImage: String, busy: Bool) -> some View {
        ZStack {
            if busy {
                ProgressView().tint(Color.white)
            } else {
                Image(systemName: systemImage)
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(Color.white)
            }
        }
        .frame(width: 48, height: 48)
        .background(Color.white.opacity(0.2), in: Circle())
        .overlay(Circle().strokeBorder(Color.white.opacity(0.35), lineWidth: 1))
        .contentShape(Circle())
    }

    private var backdrop: some View {
        ZStack {
            Rectangle().fill(.brandGradient)
            Circle()
                .fill(Color.white.opacity(0.12))
                .frame(width: 220, height: 220)
                .offset(x: 140, y: -90)
            Circle()
                .fill(Color.brandLime.opacity(0.35))
                .frame(width: 160, height: 160)
                .blur(radius: 24)
                .offset(x: -130, y: 80)
            Image(systemName: "figure.run")
                .font(.system(size: 120, weight: .black))
                .foregroundStyle(Color.white.opacity(0.10))
                .rotationEffect(.degrees(-8))
                .offset(x: 110, y: 40)
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Friend row

/// A friend in the list: avatar with colour ring, name, rank badge and territory.
private struct FriendsListRow: View {
    let friend: AppUser
    let isBusy: Bool

    var body: some View {
        HStack(spacing: 12) {
            AvatarView(name: friend.name, avatar: friend.avatar, color: friend.color, size: 50)
            VStack(alignment: .leading, spacing: 4) {
                Text(friend.displayName)
                    .font(.system(.body, design: .rounded, weight: .semibold))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    if let rank = friend.rank {
                        SocialRankBadge(rank: rank)
                    }
                    if !friend.username.isEmpty {
                        Text("@\(friend.username)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 8)
            if isBusy {
                ProgressView()
            } else {
                areaColumn
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var areaColumn: some View {
        let parts = Format.areaParts(friend.totalArea)
        return VStack(alignment: .trailing, spacing: 1) {
            Text(parts.value)
                .font(Font.stat(18))
                .monospacedDigit()
                .foregroundStyle(Color(hex: friend.color))
            Text(parts.unit)
                .statLabelStyle()
        }
    }
}

/// Messages shown after becoming friends.
enum FriendshipFeedback {
    /// The server may change either user's colour when both had the same one; `myColor` is your colour
    /// after refreshing your account, so we can tell whose colour changed.
    static func message(for result: AcceptInviteResponse, myColor: String?) -> String {
        guard result.colorChanged == true else {
            return "¡Ya sois amigos! Ahora competís por el territorio."
        }
        guard let newColor = result.newColor?.uppercased() else {
            return "¡Ya sois amigos! Teníais el mismo color de territorio, así que hemos cambiado el de uno de los dos."
        }
        let colorName = AppConfig.userColorNames[newColor]
        if let myColor, myColor.uppercased() == newColor {
            return "¡Ya sois amigos! Teníais el mismo color de territorio, así que hemos cambiado el tuyo"
                + (colorName.map { " a \($0.lowercased())." } ?? ".")
        }
        return "¡Ya sois amigos! Teníais el mismo color de territorio, así que hemos cambiado el de tu amigo"
            + (colorName.map { " a \($0.lowercased())." } ?? ".")
    }

    /// Spanish text for errors from POST /api/friends/accept/:token.
    static func inviteError(_ error: Error) -> String {
        guard let apiError = error as? APIError else { return error.localizedDescription }
        let text = apiError.message.lowercased()
        switch apiError.status {
        case 404:
            return "El enlace ha caducado o ya se ha usado. Pide a tu amigo que te envíe uno nuevo."
        case 400 where text.contains("own"):
            return "No puedes aceptar tu propia invitación."
        case 400 where text.contains("expired"):
            return "El enlace ha caducado. Pide a tu amigo que te envíe uno nuevo."
        case 403:
            return "No puedes aceptar esta invitación."
        default:
            return apiError.message
        }
    }
}

// MARK: - Invite confirmation

/// Confirmation before accepting a friend invite opened from a link: shows who sent it.
private struct InviteConfirmationSheet: View {
    let token: String
    let onAccepted: (String) -> Void

    private enum Phase {
        case loading
        case ready(InvitePreview)
        case failed(String)
    }

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var phase: Phase = .loading
    @State private var isAccepting = false
    @State private var acceptError: String?

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .loading:
                    ProgressView("Cargando invitación…")
                case .failed(let message):
                    EmptyStateView(
                        systemImage: "link.badge.plus",
                        title: "Invitación no disponible",
                        message: message,
                        actionTitle: "Cerrar",
                        action: { dismiss() },
                        tint: .steal
                    )
                case .ready(let preview):
                    ready(preview)
                }
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .screenBackground()
            .navigationTitle("Invitación de amistad")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                        .disabled(isAccepting)
                }
            }
            .errorAlert($acceptError)
        }
        .presentationDetents([.medium, .large])
        .presentationCornerRadius(28)
        .interactiveDismissDisabled(isAccepting)
        .task { await loadPreview() }
    }

    private func ready(_ preview: InvitePreview) -> some View {
        VStack(spacing: DS.Spacing.l) {
            ZStack {
                Circle()
                    .fill(Color(hex: preview.inviter.color).opacity(0.18))
                    .frame(width: 132, height: 132)
                AvatarView(name: preview.inviter.name, avatar: preview.inviter.avatar, color: preview.inviter.color, size: 100)
            }
            VStack(spacing: 4) {
                Text(preview.inviter.name)
                    .font(.system(.title2, design: .rounded, weight: .bold))
                if !preview.inviter.username.isEmpty {
                    Text("@\(preview.inviter.username)").foregroundStyle(.secondary)
                }
            }

            if preview.isSelf {
                message("Esta es tu propia invitación. Compártela con un amigo para que la acepte.")
                Button("Cerrar") { dismiss() }
                    .buttonStyle(PrimaryButtonStyle())
            } else if preview.alreadyFriends {
                message("¡Ya sois amigos! Nada que hacer aquí.")
                Button("Cerrar") { dismiss() }
                    .buttonStyle(PrimaryButtonStyle())
            } else {
                message("\(preview.inviter.name) te invita a su crew en Runna.io. Veréis vuestras carreras y competiréis por el territorio.")
                Button {
                    accept()
                } label: {
                    if isAccepting {
                        ProgressView().tint(.white)
                    } else {
                        Label("Aceptar invitación", systemImage: "hand.wave.fill")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isAccepting)
                Button("Ahora no") { dismiss() }
                    .buttonStyle(SecondaryButtonStyle(tint: .secondary))
                    .disabled(isAccepting)
            }
        }
        .frame(maxWidth: 420)
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .multilineTextAlignment(.center)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func loadPreview() async {
        do {
            let preview = try await APIClient.shared.request("GET", "/api/friends/invite/\(token)", as: InvitePreview.self)
            phase = .ready(preview)
        } catch is CancellationError {
            return
        } catch let error as APIError where error.status == 404 {
            phase = .failed("El enlace ha caducado o ya se ha usado. Pide a tu amigo que te envíe uno nuevo.")
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    private func accept() {
        guard !isAccepting else { return }
        isAccepting = true
        Task {
            do {
                let result = try await APIClient.shared.request("POST", "/api/friends/accept/\(token)", body: [:], as: AcceptInviteResponse.self)
                Haptics.success()
                await session.refreshUser()
                let message = FriendshipFeedback.message(for: result, myColor: session.user?.color)
                isAccepting = false
                dismiss()
                onAccepted(message)
            } catch {
                acceptError = FriendshipFeedback.inviteError(error)
                isAccepting = false
            }
        }
    }
}

// MARK: - Person row

struct PersonRow: View {
    let name: String
    let username: String
    let avatar: String?
    let color: String
    var size: CGFloat = 44

    var body: some View {
        HStack(spacing: 12) {
            AvatarView(name: name, avatar: avatar, color: color, size: size)
            VStack(alignment: .leading, spacing: 1) {
                Text(name)
                    .font(.system(.body, design: .rounded, weight: .semibold))
                    .lineLimit(1)
                if !username.isEmpty {
                    Text("@\(username)").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

// MARK: - Search

/// Search runners by name or username and send friend requests.
struct UserSearchView: View {
    let friendIds: Set<String>
    let pendingIds: Set<String>
    var initialQuery: String = ""

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [AppUser] = []
    @State private var requested: Set<String> = []
    @State private var sending: Set<String> = []
    @State private var isSearching = false
    @State private var errorMessage: String?
    @State private var profileUserId: String?
    @State private var seeded = false
    @State private var sentCount = 0

    var body: some View {
        NavigationStack {
            List {
                ForEach(results) { user in
                    resultRow(user)
                        .listRowBackground(Color.surface)
                }
            }
            .listStyle(.insetGrouped)
            .listBackground()
            .overlay { overlayContent }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Nombre o usuario")
            .task(id: query) { await search() }
            .onAppear {
                guard !seeded else { return }
                seeded = true
                if !initialQuery.isEmpty { query = initialQuery }
            }
            .navigationTitle("Buscar corredores")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .sheet(item: Binding(
                get: { profileUserId.map { FriendTarget(id: $0) } },
                set: { profileUserId = $0?.id }
            )) { target in
                UserProfileSheet(userId: target.id)
            }
            .sensoryFeedback(.success, trigger: sentCount)
            .errorAlert($errorMessage)
        }
    }

    @ViewBuilder
    private var overlayContent: some View {
        if isSearching && results.isEmpty {
            ProgressView()
        } else if results.isEmpty && query.trimmingCharacters(in: .whitespaces).count >= 2 {
            EmptyStateView(
                systemImage: "person.fill.questionmark",
                title: "Ni rastro de «\(query)»",
                message: "Prueba con su nombre de usuario o mándale tu enlace de invitación.",
                tint: .sky
            )
        } else if results.isEmpty {
            EmptyStateView(
                systemImage: "binoculars.fill",
                title: "Encuentra a tu crew",
                message: "Escribe al menos 2 letras de su nombre o de su usuario."
            )
        }
    }

    private func resultRow(_ user: AppUser) -> some View {
        HStack(spacing: 12) {
            Button {
                profileUserId = user.id
            } label: {
                PersonRow(name: user.name, username: user.username, avatar: user.avatar, color: user.color)
                    .foregroundStyle(Color.primary)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            Spacer(minLength: 8)
            trailing(for: user)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func trailing(for user: AppUser) -> some View {
        if friendIds.contains(user.id) {
            SocialPillLabel(title: "Amigo", systemImage: "person.2.fill", tint: .brand, kind: .soft, compact: true)
        } else if pendingIds.contains(user.id) || requested.contains(user.id) {
            SocialPillLabel(title: "Pendiente", systemImage: "clock", tint: .secondary, kind: .soft, compact: true)
        } else if sending.contains(user.id) {
            ProgressView()
        } else {
            Button {
                add(user)
            } label: {
                SocialPillLabel(title: "Añadir", systemImage: "plus", tint: .brand, kind: .filled, compact: true)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Añadir a \(user.name)")
        }
    }

    private func search() async {
        let text = query.trimmingCharacters(in: .whitespaces)
        guard text.count >= 2 else {
            results = []
            return
        }
        // Debounce typing
        try? await Task.sleep(nanoseconds: 350_000_000)
        guard !Task.isCancelled else { return }
        isSearching = true
        defer { isSearching = false }
        results = (try? await APIClient.shared.request("GET", "/api/users/search", query: ["query": text], as: [AppUser].self)) ?? []
    }

    private func add(_ user: AppUser) {
        guard !sending.contains(user.id) else { return }
        sending.insert(user.id)
        Task {
            do {
                try await APIClient.shared.send("POST", "/api/friends", body: ["friendId": user.id])
                requested.insert(user.id)
                sentCount += 1
            } catch {
                errorMessage = error.localizedDescription
            }
            sending.remove(user.id)
        }
    }
}
