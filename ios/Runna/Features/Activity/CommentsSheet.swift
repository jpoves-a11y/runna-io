import SwiftUI

/// Comments on a feed event (one level of replies): likes/dislikes, @mentions of friends,
/// deleting your own comments and reporting other people's.
struct CommentsSheet: View {
    let event: FeedEvent
    let onCountChange: (Int) -> Void

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var comments: [FeedComment] = []
    @State private var friends: [MentionCandidate] = []
    @State private var draft = ""
    @State private var replyingTo: FeedComment?
    @State private var isLoading = true
    @State private var isSending = false
    @State private var reactingIds: Set<String> = []
    @State private var commentToDelete: FeedComment?
    @State private var reportTarget: ReportTarget?
    @State private var profileUserId: String?
    @State private var errorMessage: String?
    @FocusState private var inputFocused: Bool

    var body: some View {
        NavigationStack {
            List {
                if comments.isEmpty && !isLoading {
                    Text("Sé el primero en comentar.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
                ForEach(comments) { comment in
                    row(comment, thread: comment)
                    ForEach(comment.replies) { reply in
                        row(reply, thread: comment)
                            .padding(.leading, 36)
                    }
                }
            }
            .listStyle(.plain)
            .overlay { if isLoading { ProgressView() } }
            .safeAreaInset(edge: .bottom) { composer }
            .navigationTitle("Comentarios")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .confirmationDialog(
                "¿Borrar este comentario?",
                isPresented: Binding(get: { commentToDelete != nil }, set: { if !$0 { commentToDelete = nil } }),
                titleVisibility: .visible
            ) {
                Button("Borrar", role: .destructive) {
                    if let comment = commentToDelete { delete(comment) }
                }
            } message: {
                Text("También se borrarán sus respuestas.")
            }
            .reportSheet($reportTarget)
            .sheet(item: Binding(
                get: { profileUserId.map { CommentProfileTarget(id: $0) } },
                set: { profileUserId = $0?.id }
            )) { target in
                UserProfileSheet(userId: target.id)
            }
            .errorAlert($errorMessage)
        }
        .task { await initialLoad() }
    }

    private func row(_ comment: FeedComment, thread: FeedComment) -> some View {
        CommentRow(
            comment: comment,
            isMine: comment.userId == session.userId,
            people: friends,
            isReacting: reactingIds.contains(comment.id),
            onReply: { reply(to: thread) },
            onReact: { reaction in react(comment, reaction) },
            onDelete: { commentToDelete = comment },
            onReport: { reportTarget = .comment(comment) },
            onOpenUser: { openProfile($0) }
        )
    }

    // MARK: - Composer

    private var mentionSuggestions: [MentionCandidate] {
        guard let query = Mentions.trailingQuery(in: draft) else { return [] }
        return Mentions.suggestions(for: query, among: friends)
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if !mentionSuggestions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(mentionSuggestions) { person in
                            Button {
                                draft = Mentions.insert(person, into: draft)
                            } label: {
                                HStack(spacing: 6) {
                                    AvatarView(name: person.name, avatar: person.avatar, color: person.color, size: 24)
                                    VStack(alignment: .leading, spacing: 0) {
                                        Text(person.name).font(.caption.weight(.semibold)).lineLimit(1)
                                        if !person.username.isEmpty {
                                            Text("@\(person.username)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                        }
                                    }
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Color(.secondarySystemBackground), in: Capsule())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Mencionar a \(person.name)")
                        }
                    }
                }
            }
            if let replyingTo {
                HStack {
                    Text("Respondiendo a \(replyingTo.user.name)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Cancelar") { self.replyingTo = nil }
                        .font(.caption)
                }
            }
            HStack(spacing: 8) {
                TextField("Escribe un comentario… (@ para mencionar)", text: $draft, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)
                    .focused($inputFocused)
                    .disabled(isSending)
                Button {
                    send()
                } label: {
                    if isSending {
                        ProgressView()
                    } else {
                        Image(systemName: "paperplane.fill")
                    }
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)
                .accessibilityLabel("Enviar comentario")
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
    }

    // MARK: - Actions

    private var totalCount: Int {
        comments.reduce(0) { $0 + 1 + $1.replies.count }
    }

    private func initialLoad() async {
        await load()
        await loadFriends()
    }

    private func loadFriends() async {
        guard let userId = session.userId else { return }
        let loaded = (try? await APIClient.shared.request("GET", "/api/friends/\(userId)", as: [AppUser].self)) ?? []
        friends = loaded.map { MentionCandidate($0) }
    }

    private func load() async {
        defer { isLoading = false }
        do {
            comments = try await APIClient.shared.request("GET", "/api/feed/events/\(event.id)/comments", as: [FeedComment].self)
            onCountChange(totalCount)
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func reply(to comment: FeedComment) {
        replyingTo = comment
        inputFocused = true
    }

    private func openProfile(_ userId: String) {
        inputFocused = false
        profileUserId = userId
    }

    private func send() {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, !isSending else { return }
        isSending = true
        Task {
            do {
                var body: [String: Any] = ["content": String(content.prefix(500))]
                if let parentId = replyingTo?.id { body["parentId"] = parentId }
                try await APIClient.shared.send("POST", "/api/feed/events/\(event.id)/comments", body: body)
                draft = ""
                replyingTo = nil
                Haptics.tap()
                await load()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSending = false
        }
    }

    private func react(_ comment: FeedComment, _ reaction: String) {
        guard !reactingIds.contains(comment.id) else { return }
        reactingIds.insert(comment.id)
        Haptics.tap()
        Task {
            do {
                let result = try await APIClient.shared.request(
                    "POST", "/api/feed/reactions",
                    body: ["targetType": "comment", "targetId": comment.id, "reactionType": reaction],
                    as: ReactionResult.self
                )
                apply(result, to: comment.id)
            } catch {
                errorMessage = error.localizedDescription
            }
            reactingIds.remove(comment.id)
        }
    }

    /// Updates a comment's counters in place (top-level or reply) without reloading the thread.
    private func apply(_ result: ReactionResult, to commentId: String) {
        for index in comments.indices {
            if comments[index].id == commentId {
                comments[index].likeCount = result.likeCount
                comments[index].dislikeCount = result.dislikeCount
                comments[index].userReaction = result.userReaction
                return
            }
            if let replyIndex = comments[index].replies.firstIndex(where: { $0.id == commentId }) {
                comments[index].replies[replyIndex].likeCount = result.likeCount
                comments[index].replies[replyIndex].dislikeCount = result.dislikeCount
                comments[index].replies[replyIndex].userReaction = result.userReaction
                return
            }
        }
    }

    private func delete(_ comment: FeedComment) {
        Task {
            do {
                try await APIClient.shared.send("DELETE", "/api/feed/comments/\(comment.id)", body: [:])
                if replyingTo?.id == comment.id { replyingTo = nil }
                await load()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct CommentProfileTarget: Identifiable {
    let id: String
}

private struct CommentRow: View {
    let comment: FeedComment
    let isMine: Bool
    let people: [MentionCandidate]
    let isReacting: Bool
    let onReply: () -> Void
    let onReact: (String) -> Void
    let onDelete: () -> Void
    let onReport: () -> Void
    let onOpenUser: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Button { onOpenUser(comment.user.id) } label: {
                AvatarView(name: comment.user.name, avatar: comment.user.avatar, color: comment.user.color, size: 30)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Ver perfil de \(comment.user.name)")
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Button { onOpenUser(comment.user.id) } label: {
                        Text(comment.user.displayName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                    }
                    .buttonStyle(.borderless)
                    Text(Format.relative(APIDate.parse(comment.createdAt)))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                MentionText(text: comment.content, people: people, onOpenUser: onOpenUser)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 16) {
                    Button { onReact("like") } label: {
                        Label("\(comment.likeCount)", systemImage: comment.userReaction == "like" ? "heart.fill" : "heart")
                            .foregroundStyle(comment.userReaction == "like" ? Color.red : Color.secondary)
                    }
                    .accessibilityLabel("Me gusta, \(comment.likeCount)")
                    Button { onReact("dislike") } label: {
                        Label("\(comment.dislikeCount)", systemImage: comment.userReaction == "dislike" ? "hand.thumbsdown.fill" : "hand.thumbsdown")
                            .foregroundStyle(comment.userReaction == "dislike" ? Color.brand : Color.secondary)
                    }
                    .accessibilityLabel("No me gusta, \(comment.dislikeCount)")
                    Button("Responder", action: onReply)
                    Spacer()
                    Menu {
                        if isMine {
                            Button(role: .destructive, action: onDelete) {
                                Label("Borrar", systemImage: "trash")
                            }
                        } else {
                            Button(action: onReport) {
                                Label("Denunciar comentario", systemImage: "exclamationmark.bubble")
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .frame(width: 28, height: 20)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Más opciones")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .buttonStyle(.borderless)
                .disabled(isReacting)
            }
        }
        .swipeActions {
            if isMine {
                Button("Borrar", role: .destructive, action: onDelete)
            } else {
                Button("Denunciar", action: onReport)
                    .tint(.orange)
            }
        }
    }
}
