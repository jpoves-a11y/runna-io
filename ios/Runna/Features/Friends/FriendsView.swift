import SwiftUI

struct FriendsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @State private var model = FriendsModel.shared
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

    private var friends: [AppUser] { model.friends }
    private var incoming: [FriendRequest] { model.incoming }
    private var sent: [FriendRequest] { model.sent }
    private var isLoading: Bool { model.isLoading }
    private var hasLoaded: Bool { model.hasLoaded }
    private var errorMessage: String? { model.errorMessage }

    /// Invites last 7 days on the server; a link older than this is regenerated before sharing.
    private static let inviteMaxAge: TimeInterval = 6 * 24 * 3600

    var body: some View {
        NavigationStack {
            list
                .navigationTitle("Amigos")
                .toolbar { toolbarContent }
                .refreshable { await load(force: true) }
                .task(id: router.reloadSignal) {
                    await load(force: model.reloadTracker.consume(router.reloadSignal))
                }
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
                ErrorView(message: errorMessage) { Task { await load(force: true) } }
                    .background(Color.canvas)
            }
        }
    }

    private var heroSection: some View {
        Section {
            FriendsInviteCard(
                inviteURL: currentInviteURL,
                isCreating: isCreatingInvite,
                onCreate: { createInvite() },
                onSearch: { openSearch() }
            )
            .listRowBackground(Color.surface)
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
            SocialSectionHeader(title: "Solicitudes", count: incoming.count)
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
            SocialSectionHeader(title: "Amigos", count: friends.isEmpty ? nil : friends.count)
        } footer: {
            if !friends.isEmpty && friendQuery.isEmpty {
                Text("Ordenados por territorio. Desliza a la izquierda para eliminar.")
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
            SocialSectionHeader(title: "Solicitudes enviadas", count: sent.count)
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
            systemImage: "person.2",
            title: "Aún no tienes amigos",
            message: "Invítalos con tu enlace o búscalos por nombre para competir por el territorio.",
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
                Image(systemName: "magnifyingglass")
                    .font(.system(size: DS.Size.icon, weight: .regular))
                    .foregroundStyle(.secondary)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Ningún amigo coincide con «\(friendQuery)»")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                    Text("Buscar en Runna.io")
                        .font(.footnote)
                        .foregroundStyle(Color.brand)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
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
        HStack(spacing: 12) {
            Button {
                profileUserId = sender.id
            } label: {
                personSummary(
                    name: sender.name,
                    avatar: sender.avatar,
                    color: sender.color,
                    subtitle: requestSubtitle(username: sender.username, date: request.createdAt, fallback: "Quiere ser tu amigo")
                )
            }
            .buttonStyle(.borderless)

            if busyIds.contains(request.id) {
                ProgressView()
                    .frame(minWidth: 60)
            } else {
                Button {
                    respond(to: request, accept: false)
                } label: {
                    SocialPlainActionLabel(title: "Rechazar")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Rechazar a \(sender.name)")

                Button {
                    respond(to: request, accept: true)
                } label: {
                    SocialPillLabel(title: "Aceptar", tint: .brand, kind: .filled, compact: true)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Aceptar a \(sender.name)")
            }
        }
        .padding(.vertical, 2)
    }

    private func sentRow(_ request: FriendRequest, recipient: UserRef) -> some View {
        HStack(spacing: 12) {
            Button {
                profileUserId = recipient.id
            } label: {
                personSummary(
                    name: recipient.name,
                    avatar: recipient.avatar,
                    color: recipient.color,
                    subtitle: requestSubtitle(username: recipient.username, date: request.createdAt, fallback: "Solicitud enviada")
                )
            }
            .buttonStyle(.borderless)

            if busyIds.contains(request.id) {
                ProgressView()
            } else {
                Button {
                    cancel(request)
                } label: {
                    SocialPlainActionLabel(title: "Cancelar")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Cancelar solicitud a \(recipient.name)")
            }
        }
        .padding(.vertical, 2)
    }

    /// Avatar, name and a secondary line; fills the leading part of a request row.
    private func personSummary(name: String, avatar: String?, color: String, subtitle: String) -> some View {
        HStack(spacing: 12) {
            AvatarView(name: name, avatar: avatar, color: color, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
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

    /// Cached lists first; refetched when they aren't fresh, after a change (or `force`).
    private func load(force: Bool = false) async {
        guard let userId = session.userId else { return }
        await model.load(userId: userId, force: force)
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
                model.removeIncoming(request.id)
                await load(force: true)
            } catch {
                alertMessage = error.localizedDescription
                await load(force: true)
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
                model.removeSent(request.id)
                await load(force: true)
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
                model.removeFriend(friend.id)
                await load(force: true)
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

// MARK: - Invite card

/// Calm invite card at the top of Friends: title, one line, "Invitar" (creates the link)
/// then share / renew, plus search.
private struct FriendsInviteCard: View {
    let inviteURL: URL?
    let isCreating: Bool
    let onCreate: () -> Void
    let onSearch: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Invita a tus amigos")
                    .font(Font.cardTitle)
                Text("Enlace personal de un solo uso. Caduca en 7 días.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            actions
        }
        .padding(.vertical, DS.Spacing.xs)
    }

    private var actions: some View {
        HStack(spacing: DS.Spacing.s) {
            primaryAction
            if inviteURL != nil {
                Button(action: onCreate) {
                    iconLabel(systemImage: "arrow.clockwise", busy: isCreating)
                }
                .buttonStyle(.borderless)
                .disabled(isCreating)
                .accessibilityLabel("Generar un enlace nuevo")
            }
            Button(action: onSearch) {
                iconLabel(systemImage: "magnifyingglass", busy: false)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Buscar corredores")
        }
    }

    @ViewBuilder
    private var primaryAction: some View {
        if let inviteURL {
            ShareLink(
                item: inviteURL,
                subject: Text("Únete a Runna.io"),
                message: Text("Compite conmigo en Runna.io. Corre y conquista la ciudad:")
            ) {
                SocialPillLabel(title: "Compartir enlace", systemImage: "square.and.arrow.up", tint: .brand, kind: .filled, expand: true)
            }
            .buttonStyle(.borderless)
        } else {
            Button(action: onCreate) {
                if isCreating {
                    ProgressView()
                        .tint(Color.onBrand)
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background(Color.brand, in: RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous))
                } else {
                    SocialPillLabel(title: "Invitar", systemImage: "link", tint: .brand, kind: .filled, expand: true)
                }
            }
            .buttonStyle(.borderless)
            .disabled(isCreating)
        }
    }

    private func iconLabel(systemImage: String, busy: Bool) -> some View {
        ZStack {
            if busy {
                ProgressView()
            } else {
                Image(systemName: systemImage)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Color.primary)
            }
        }
        .frame(width: 44, height: 40)
        .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous))
    }
}

// MARK: - Friend row

/// A friend in the list: avatar with colour ring, name, @username and rank, territory right-aligned.
private struct FriendsListRow: View {
    let friend: AppUser
    let isBusy: Bool

    var body: some View {
        HStack(spacing: 12) {
            AvatarView(name: friend.name, avatar: friend.avatar, color: friend.color, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(friend.displayName)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    if !friend.username.isEmpty {
                        Text("@\(friend.username)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if let rank = friend.rank {
                        SocialRankBadge(rank: rank)
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
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var areaColumn: some View {
        let parts = Format.areaParts(friend.totalArea)
        return StatValue(value: parts.value, unit: parts.unit, font: Font.stat(19, weight: .semibold))
    }
}

/// Messages shown after becoming friends.
enum FriendshipFeedback {
    /// The server may change either user's colour when both had the same one; `myColor` is your colour
    /// after refreshing your account, so we can tell whose colour changed.
    static func message(for result: AcceptInviteResponse, myColor: String?) -> String {
        guard result.colorChanged == true else {
            return "Ya sois amigos. Ahora competís por el territorio."
        }
        guard let newColor = result.newColor?.uppercased() else {
            return "Ya sois amigos. Teníais el mismo color de territorio, así que hemos cambiado el de uno de los dos."
        }
        let colorName = AppConfig.userColorNames[newColor]
        if let myColor, myColor.uppercased() == newColor {
            return "Ya sois amigos. Teníais el mismo color de territorio, así que hemos cambiado el tuyo"
                + (colorName.map { " a \($0.lowercased())." } ?? ".")
        }
        return "Ya sois amigos. Teníais el mismo color de territorio, así que hemos cambiado el de tu amigo"
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
            AvatarView(name: preview.inviter.name, avatar: preview.inviter.avatar, color: preview.inviter.color, size: 88)
            VStack(spacing: 4) {
                Text(preview.inviter.name)
                    .font(.title2.weight(.bold))
                    .multilineTextAlignment(.center)
                if !preview.inviter.username.isEmpty {
                    Text("@\(preview.inviter.username)").foregroundStyle(.secondary)
                }
            }

            if preview.isSelf {
                message("Esta es tu propia invitación. Compártela con un amigo para que la acepte.")
                Button("Cerrar") { dismiss() }
                    .buttonStyle(PrimaryButtonStyle())
            } else if preview.alreadyFriends {
                message("Ya sois amigos.")
                Button("Cerrar") { dismiss() }
                    .buttonStyle(PrimaryButtonStyle())
            } else {
                message("\(preview.inviter.name) te invita a ser su amigo en Runna.io. Veréis vuestras carreras y competiréis por el territorio.")
                Button {
                    accept()
                } label: {
                    if isAccepting {
                        ProgressView().tint(Color.onBrand)
                    } else {
                        Text("Aceptar invitación")
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
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
                if !username.isEmpty {
                    Text("@\(username)").font(.footnote).foregroundStyle(.secondary).lineLimit(1)
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
                systemImage: "person.crop.circle.badge.questionmark",
                title: "Sin resultados para «\(query)»",
                message: "Prueba con su nombre de usuario o envíale tu enlace de invitación."
            )
        } else if results.isEmpty {
            EmptyStateView(
                systemImage: "magnifyingglass",
                title: "Busca corredores",
                message: "Escribe al menos 2 letras de su nombre o usuario."
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
            statusText("Amigo", systemImage: "checkmark")
        } else if pendingIds.contains(user.id) || requested.contains(user.id) {
            statusText("Pendiente", systemImage: "clock")
        } else if sending.contains(user.id) {
            ProgressView()
        } else {
            Button {
                add(user)
            } label: {
                SocialPillLabel(title: "Añadir", tint: .brand, kind: .filled, compact: true)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Añadir a \(user.name)")
        }
    }

    private func statusText(_ title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(.footnote.weight(.medium))
            .foregroundStyle(.secondary)
            .labelStyle(.titleAndIcon)
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

/// Your friends and pending requests, kept across tab switches (stale-while-revalidate).
@MainActor
@Observable
final class FriendsModel {
    static let shared = FriendsModel()

    private(set) var friends: [AppUser] = []
    private(set) var incoming: [FriendRequest] = []
    private(set) var sent: [FriendRequest] = []
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    private(set) var errorMessage: String?
    var reloadTracker = ReloadSignalTracker()

    private var ownerId: String?
    private var friendsResource: CachedResource<[AppUser]>?
    private var incomingResource: CachedResource<[FriendRequest]>?
    private var sentResource: CachedResource<[FriendRequest]>?

    func reset() {
        ownerId = nil
        friendsResource = nil
        incomingResource = nil
        sentResource = nil
        friends = []
        incoming = []
        sent = []
        isLoading = false
        hasLoaded = false
        errorMessage = nil
        reloadTracker = ReloadSignalTracker()
    }

    func removeIncoming(_ requestId: String) {
        incoming.removeAll { $0.id == requestId }
    }

    func removeSent(_ requestId: String) {
        sent.removeAll { $0.id == requestId }
    }

    func removeFriend(_ friendId: String) {
        friends.removeAll { $0.id == friendId }
    }

    func load(userId: String, force: Bool) async {
        if ownerId != userId {
            reset()
            ownerId = userId
            friendsResource = CachedResource("/api/friends/\(userId)")
            incomingResource = CachedResource("/api/friends/requests/\(userId)")
            sentResource = CachedResource("/api/friends/requests/sent/\(userId)")
        }
        guard let friendsResource, let incomingResource, let sentResource else { return }

        // 1. Last known lists, instantly
        if let cached = await friendsResource.loadCached() {
            friends = Self.sortedFriends(cached)
            hasLoaded = true
        }
        if let cached = await incomingResource.loadCached() {
            incoming = Self.pending(cached)
        }
        if let cached = await sentResource.loadCached() {
            sent = Self.pending(cached)
        }
        let fresh = friendsResource.isFresh && incomingResource.isFresh && sentResource.isFresh
        if !force && hasLoaded && fresh { return }

        // 2. The three lists in parallel
        isLoading = friends.isEmpty && incoming.isEmpty
        defer {
            isLoading = false
            hasLoaded = true
        }
        do {
            async let friendsRequest: [AppUser]? = friendsResource.fetch()
            async let incomingRequest: [FriendRequest]? = incomingResource.fetch()
            async let sentRequest: [FriendRequest]? = sentResource.fetch()
            let (loadedFriends, loadedIncoming, loadedSent) = try await (friendsRequest, incomingRequest, sentRequest)
            // A list identical to the one shown comes back as nil, but local removals must be undone/confirmed
            if let list = loadedFriends ?? friendsResource.value { friends = Self.sortedFriends(list) }
            if let list = loadedIncoming ?? incomingResource.value { incoming = Self.pending(list) }
            if let list = loadedSent ?? sentResource.value { sent = Self.pending(list) }
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            // With cached lists on screen the refresh fails silently (it's retried on the next visit)
            errorMessage = (friends.isEmpty && incoming.isEmpty) ? error.localizedDescription : nil
        }
    }

    private static func sortedFriends(_ list: [AppUser]) -> [AppUser] {
        list.sorted { $0.totalArea > $1.totalArea }
    }

    private static func pending(_ list: [FriendRequest]) -> [FriendRequest] {
        list.filter { $0.status == "pending" }
    }
}
