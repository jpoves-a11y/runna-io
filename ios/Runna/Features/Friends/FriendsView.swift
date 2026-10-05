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
    @State private var profileUserId: String?
    @State private var friendToRemove: AppUser?

    var body: some View {
        NavigationStack {
            List {
                inviteSection

                if !incoming.isEmpty {
                    Section("Solicitudes recibidas") {
                        ForEach(incoming) { request in
                            if let sender = request.sender {
                                HStack {
                                    PersonRow(name: sender.name, username: sender.username, avatar: sender.avatar, color: sender.color)
                                    Spacer()
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
                                Text(Format.area(friend.totalArea))
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                            }
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
                                HStack {
                                    PersonRow(name: recipient.name, username: recipient.username, avatar: recipient.avatar, color: recipient.color)
                                    Spacer()
                                    Button("Cancelar") { cancel(request) }
                                        .buttonStyle(.bordered)
                                        .font(.caption)
                                }
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
            .task(id: router.pendingInviteToken) { await acceptPendingInvite() }
            .sheet(isPresented: $showSearch, onDismiss: { Task { await load() } }) {
                UserSearchView(friendIds: Set(friends.map(\.id)), pendingIds: Set(sent.map(\.recipientId)))
            }
            .sheet(item: Binding(
                get: { profileUserId.map { FriendTarget(id: $0) } },
                set: { profileUserId = $0?.id }
            )) { target in
                UserProfileSheet(userId: target.id)
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

    private var inviteSection: some View {
        Section {
            if let inviteURL {
                ShareLink(
                    item: inviteURL,
                    subject: Text("Únete a Runna.io"),
                    message: Text("¡Compite conmigo en Runna.io! Corre y conquista la ciudad:")
                ) {
                    Label("Compartir mi enlace de invitación", systemImage: "square.and.arrow.up")
                }
            } else {
                Button {
                    createInvite()
                } label: {
                    Label("Invitar a un amigo", systemImage: "link")
                }
            }
        } footer: {
            Text("Quien abra el enlace y acepte se convierte en tu amigo al instante.")
        }
    }

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
        Task {
            do {
                let action = accept ? "accept" : "reject"
                let result = try await APIClient.shared.request("POST", "/api/friends/requests/\(request.id)/\(action)", body: [:], as: AcceptInviteResponse.self)
                if accept {
                    Haptics.success()
                    if result.colorChanged == true {
                        alertMessage = "Teníais el mismo color de territorio, así que hemos cambiado el tuyo."
                        await session.refreshUser()
                    }
                }
                await load()
            } catch {
                alertMessage = error.localizedDescription
            }
        }
    }

    private func cancel(_ request: FriendRequest) {
        Task {
            do {
                try await APIClient.shared.send("DELETE", "/api/friends/requests/\(request.id)")
                await load()
            } catch {
                alertMessage = error.localizedDescription
            }
        }
    }

    private func remove(_ friend: AppUser) {
        Task {
            do {
                try await APIClient.shared.send("DELETE", "/api/friends/\(friend.id)", body: [:])
                await load()
            } catch {
                alertMessage = error.localizedDescription
            }
        }
    }

    private func createInvite() {
        Task {
            do {
                let invite = try await APIClient.shared.request("POST", "/api/friends/invite", body: [:], as: InviteResponse.self)
                inviteURL = URL(string: invite.url)
            } catch {
                alertMessage = error.localizedDescription
            }
        }
    }

    private func acceptPendingInvite() async {
        guard let token = router.pendingInviteToken else { return }
        router.pendingInviteToken = nil
        do {
            let result = try await APIClient.shared.request("POST", "/api/friends/accept/\(token)", body: [:], as: AcceptInviteResponse.self)
            Haptics.success()
            alertMessage = result.colorChanged == true
                ? "¡Ya sois amigos! Teníais el mismo color, así que hemos cambiado el tuyo."
                : "¡Ya sois amigos! Ahora competís por el territorio."
            await session.refreshUser()
            await load()
        } catch {
            alertMessage = "No se ha podido aceptar la invitación: \(error.localizedDescription)"
        }
    }
}

private struct FriendTarget: Identifiable {
    let id: String
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
    @State private var isSearching = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                ForEach(results) { user in
                    HStack {
                        PersonRow(name: user.name, username: user.username, avatar: user.avatar, color: user.color)
                        Spacer()
                        if friendIds.contains(user.id) {
                            Text("Amigo").font(.caption).foregroundStyle(.secondary)
                        } else if pendingIds.contains(user.id) || requested.contains(user.id) {
                            Text("Pendiente").font(.caption).foregroundStyle(.secondary)
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
        Task {
            do {
                try await APIClient.shared.send("POST", "/api/friends", body: ["friendId": user.id])
                requested.insert(user.id)
                Haptics.success()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
