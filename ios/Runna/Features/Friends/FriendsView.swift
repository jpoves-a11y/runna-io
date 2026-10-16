import SwiftUI

struct FriendsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @State private var friends: [AppUser] = []
    @State private var incoming: [FriendRequest] = []
    @State private var sent: [FriendRequest] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var alertMessage: String?
    @State private var showSearch = false
    @State private var inviteURL: URL?
    @State private var inviteCreatedAt: Date?
    @State private var isCreatingInvite = false
    @State private var profileUserId: String?
    @State private var friendToRemove: AppUser?
    @State private var busyIds: Set<String> = []
    @State private var inviteToConfirm: InviteToken?

    /// Invites last 7 days on the server; a link older than this is regenerated before sharing.
    private static let inviteMaxAge: TimeInterval = 6 * 24 * 3600

    var body: some View {
        NavigationStack {
            List {
                inviteSection

                if !incoming.isEmpty {
                    Section("Solicitudes recibidas") {
                        ForEach(incoming) { request in
                            if let sender = request.sender {
                                incomingRow(request, sender: sender)
                            }
                        }
                    }
                }

                Section("Mis amigos (\(friends.count))") {
                    if friends.isEmpty && !isLoading {
                        Text("Aún no tienes amigos. Búscalos o envíales tu enlace de invitación.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(friends) { friend in
                        Button {
                            profileUserId = friend.id
                        } label: {
                            HStack {
                                PersonRow(name: friend.displayName, username: friend.username, avatar: friend.avatar, color: friend.color)
                                Spacer()
                                if busyIds.contains(friend.id) {
                                    ProgressView()
                                } else {
                                    if let rank = friend.rank {
                                        RankBadge(rank: rank)
                                    }
                                    Text(Format.area(friend.totalArea))
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                        .monospacedDigit()
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .swipeActions {
                            Button("Eliminar", role: .destructive) { friendToRemove = friend }
                        }
                    }
                }

                if !sent.isEmpty {
                    Section("Solicitudes enviadas") {
                        ForEach(sent) { request in
                            if let recipient = request.recipient {
                                sentRow(request, recipient: recipient)
                            }
                        }
                    }
                }
            }
            .overlay {
                if let errorMessage, friends.isEmpty, incoming.isEmpty {
                    ErrorView(message: errorMessage) { Task { await load() } }
                }
            }
            .navigationTitle("Amigos")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showSearch = true
                    } label: {
                        Image(systemName: "person.badge.plus")
                    }
                    .accessibilityLabel("Buscar corredores")
                }
            }
            .refreshable { await load() }
            .task(id: router.reloadSignal) { await load() }
            .task(id: router.pendingInviteToken) { takePendingInvite() }
            .sheet(isPresented: $showSearch, onDismiss: { Task { await load() } }) {
                UserSearchView(friendIds: Set(friends.map(\.id)), pendingIds: Set(sent.map(\.recipientId)))
            }
            .sheet(item: Binding(
                get: { profileUserId.map { FriendTarget(id: $0) } },
                set: { profileUserId = $0?.id }
            ), onDismiss: { Task { await load() } }) { target in
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
            }
            .alert("Amigos", isPresented: Binding(get: { alertMessage != nil }, set: { if !$0 { alertMessage = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(alertMessage ?? "")
            }
        }
    }

    // MARK: - Rows

    private func incomingRow(_ request: FriendRequest, sender: UserRef) -> some View {
        HStack {
            Button {
                profileUserId = sender.id
            } label: {
                PersonRow(name: sender.name, username: sender.username, avatar: sender.avatar, color: sender.color)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.primary)
            Spacer()
            if busyIds.contains(request.id) {
                ProgressView()
            } else {
                Button {
                    respond(to: request, accept: true)
                } label: {
                    Image(systemName: "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .accessibilityLabel("Aceptar a \(sender.name)")
                Button {
                    respond(to: request, accept: false)
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Rechazar a \(sender.name)")
            }
        }
    }

    private func sentRow(_ request: FriendRequest, recipient: UserRef) -> some View {
        HStack {
            Button {
                profileUserId = recipient.id
            } label: {
                PersonRow(name: recipient.name, username: recipient.username, avatar: recipient.avatar, color: recipient.color)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.primary)
            Spacer()
            if busyIds.contains(request.id) {
                ProgressView()
            } else {
                Button("Cancelar") { cancel(request) }
                    .buttonStyle(.bordered)
                    .font(.caption)
            }
        }
    }

    private var currentInviteURL: URL? {
        guard let inviteURL, let inviteCreatedAt, Date().timeIntervalSince(inviteCreatedAt) < Self.inviteMaxAge else { return nil }
        return inviteURL
    }

    private var inviteSection: some View {
        Section {
            if let url = currentInviteURL {
                ShareLink(
                    item: url,
                    subject: Text("Únete a Runna.io"),
                    message: Text("¡Compite conmigo en Runna.io! Corre y conquista la ciudad:")
                ) {
                    Label("Compartir mi enlace de invitación", systemImage: "square.and.arrow.up")
                }
                Button {
                    createInvite()
                } label: {
                    if isCreatingInvite {
                        ProgressView()
                    } else {
                        Label("Generar un enlace nuevo", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(isCreatingInvite)
            } else {
                Button {
                    createInvite()
                } label: {
                    if isCreatingInvite {
                        HStack {
                            ProgressView()
                            Text("Creando enlace…")
                        }
                    } else {
                        Label("Invitar a un amigo", systemImage: "link")
                    }
                }
                .disabled(isCreatingInvite)
            }
        } footer: {
            Text("El enlace caduca en 7 días y solo se puede usar una vez. Quien lo abra y acepte la invitación se convierte en tu amigo.")
        }
    }

    // MARK: - Actions

    private func load() async {
        guard let userId = session.userId else { return }
        isLoading = true
        defer { isLoading = false }
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
                    Haptics.success()
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

/// "#3" position within your friend group.
private struct RankBadge: View {
    let rank: Int

    var body: some View {
        Text("#\(rank)")
            .font(.caption.weight(.bold))
            .monospacedDigit()
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(rank == 1 ? Color.yellow.opacity(0.25) : Color.secondary.opacity(0.15), in: Capsule())
            .foregroundStyle(rank == 1 ? Color.orange : Color.secondary)
            .accessibilityLabel("Puesto \(rank)")
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
                    ContentUnavailableView {
                        Label("Invitación no disponible", systemImage: "link.badge.plus")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Cerrar") { dismiss() }
                            .buttonStyle(.borderedProminent)
                    }
                case .ready(let preview):
                    ready(preview)
                }
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        .interactiveDismissDisabled(isAccepting)
        .task { await loadPreview() }
    }

    private func ready(_ preview: InvitePreview) -> some View {
        VStack(spacing: 14) {
            AvatarView(name: preview.inviter.name, avatar: preview.inviter.avatar, color: preview.inviter.color, size: 88)
            VStack(spacing: 2) {
                Text(preview.inviter.name).font(.title2.bold())
                if !preview.inviter.username.isEmpty {
                    Text("@\(preview.inviter.username)").foregroundStyle(.secondary)
                }
            }

            if preview.isSelf {
                Text("Esta es tu propia invitación. Compártela con un amigo para que la acepte.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                Button("Cerrar") { dismiss() }
                    .buttonStyle(.borderedProminent)
            } else if preview.alreadyFriends {
                Text("Ya sois amigos.")
                    .foregroundStyle(.secondary)
                Button("Cerrar") { dismiss() }
                    .buttonStyle(.borderedProminent)
            } else {
                Text("\(preview.inviter.name) te ha invitado a ser su amigo en Runna.io. Veréis vuestras carreras y competiréis por el territorio.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    accept()
                } label: {
                    if isAccepting {
                        ProgressView().tint(.white)
                    } else {
                        Text("Aceptar invitación")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isAccepting)
                Button("Cancelar") { dismiss() }
                    .disabled(isAccepting)
            }
        }
        .frame(maxWidth: 420)
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

struct PersonRow: View {
    let name: String
    let username: String
    let avatar: String?
    let color: String

    var body: some View {
        HStack(spacing: 12) {
            AvatarView(name: name, avatar: avatar, color: color, size: 40)
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(.body.weight(.medium)).lineLimit(1)
                if !username.isEmpty {
                    Text("@\(username)").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// Search runners by name or username and send friend requests.
struct UserSearchView: View {
    let friendIds: Set<String>
    let pendingIds: Set<String>

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [AppUser] = []
    @State private var requested: Set<String> = []
    @State private var sending: Set<String> = []
    @State private var isSearching = false
    @State private var errorMessage: String?
    @State private var profileUserId: String?

    var body: some View {
        NavigationStack {
            List {
                ForEach(results) { user in
                    HStack {
                        Button {
                            profileUserId = user.id
                        } label: {
                            PersonRow(name: user.name, username: user.username, avatar: user.avatar, color: user.color)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.primary)
                        Spacer()
                        if friendIds.contains(user.id) {
                            Text("Amigo").font(.caption).foregroundStyle(.secondary)
                        } else if pendingIds.contains(user.id) || requested.contains(user.id) {
                            Label("Pendiente", systemImage: "checkmark")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else if sending.contains(user.id) {
                            ProgressView()
                        } else {
                            Button("Añadir") { add(user) }
                                .buttonStyle(.borderedProminent)
                                .font(.caption)
                        }
                    }
                }
            }
            .overlay {
                if isSearching {
                    ProgressView()
                } else if results.isEmpty && query.count >= 2 {
                    ContentUnavailableView.search(text: query)
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Nombre o usuario")
            .task(id: query) { await search() }
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
            .errorAlert($errorMessage)
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
                Haptics.success()
            } catch {
                errorMessage = error.localizedDescription
            }
            sending.remove(user.id)
        }
    }
}
