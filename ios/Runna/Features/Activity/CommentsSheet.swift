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
    /// Server id of each local comment once the server accepted it (local id -> server id).
    @State private var sentIds: [String: String] = [:]
    @State private var commentToDelete: FeedComment?
    @State private var reportTarget: ReportTarget?
    @State private var profileUserId: String?
    @State private var errorMessage: String?
    /// Short message when an optimistic change had to be undone.
    @State private var toastMessage: String?
    @State private var reactionSync = ReactionSync()
    @FocusState private var inputFocused: Bool

    var body: some View {
        NavigationStack {
            List {
                if comments.isEmpty && !isLoading {
                    EmptyStateView(
                        systemImage: "bubble.left.and.bubble.right",
                        title: "Sin comentarios",
                        message: "Escribe el primero."
                    )
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
                ForEach(comments) { comment in
                    row(comment, thread: comment, isReply: false)
                    ForEach(comment.replies) { reply in
                        row(reply, thread: comment, isReply: true)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color.canvas.ignoresSafeArea())
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
            .errorToast($toastMessage)
        }
        .presentationDragIndicator(.visible)
        .task { await initialLoad() }
    }

    private func row(_ comment: FeedComment, thread: FeedComment, isReply: Bool) -> some View {
        CommentRow(
            comment: comment,
            isMine: comment.userId == session.userId,
            isReply: isReply,
            people: friends,
            isReacting: OptimisticCache.isLocal(comment.id),
            onReply: { reply(to: thread) },
            onReact: { reaction in react(comment, reaction) },
            onDelete: { commentToDelete = comment },
            onReport: { reportTarget = .comment(comment) },
            onOpenUser: { openProfile($0) }
        )
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 8, leading: isReply ? 60 : DS.Spacing.l, bottom: 8, trailing: DS.Spacing.l))
    }

    // MARK: - Composer

    private var mentionSuggestions: [MentionCandidate] {
        guard let query = Mentions.trailingQuery(in: draft) else { return [] }
        return Mentions.suggestions(for: query, among: friends)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if !mentionSuggestions.isEmpty {
                mentionBar
            }
            if let replyingTo {
                replyBanner(replyingTo)
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Añade un comentario (@ para mencionar)", text: $draft, axis: .vertical)
                    .font(.subheadline)
                    .lineLimit(1...4)
                    .focused($inputFocused)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline)
                    )
                sendButton
            }
        }
        .padding(.horizontal, DS.Spacing.l)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var sendButton: some View {
        Button {
            send()
        } label: {
            ZStack {
                Circle()
                    .fill(canSend ? Color.brand : Color(uiColor: .tertiarySystemFill))
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(canSend ? Color.onBrand : Color.secondary)
            }
            .frame(width: 40, height: 40)
            .frame(width: 44, height: 44)
        }
        .buttonStyle(.pressable)
        .disabled(!canSend)
        .animation(.snappy, value: canSend)
        .accessibilityLabel("Enviar comentario")
    }

    private var mentionBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(mentionSuggestions) { person in
                    Button {
                        draft = Mentions.insert(person, into: draft)
                    } label: {
                        mentionChip(person)
                    }
                    .buttonStyle(.pressable)
                    .accessibilityLabel("Mencionar a \(person.name)")
                }
            }
        }
    }

    private func mentionChip(_ person: MentionCandidate) -> some View {
        HStack(spacing: 6) {
            AvatarView(name: person.name, avatar: person.avatar, color: person.color, size: 26)
            VStack(alignment: .leading, spacing: 0) {
                Text(person.name)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if !person.username.isEmpty {
                    Text("@\(person.username)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.leading, 4)
        .padding(.trailing, 12)
        .padding(.vertical, 4)
        .background(Color.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline))
    }

    private func replyBanner(_ comment: FeedComment) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "arrowshape.turn.up.left")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            Text("Respondiendo a \(comment.user.name)")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer()
            Button {
                replyingTo = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 28, height: 24)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Cancelar respuesta")
        }
        .padding(.horizontal, DS.Spacing.xs)
    }

    // MARK: - Actions

    private var totalCount: Int {
        comments.reduce(0) { $0 + 1 + $1.replies.count }
    }

    private var commentsPath: String { "/api/feed/events/\(event.id)/comments" }

    /// Last known thread and friends first (instant), then both refetched.
    private func initialLoad() async {
        if let cached = APIClient.shared.cached(commentsPath, as: [FeedComment].self) {
            comments = cached
            isLoading = false
        }
        if let userId = session.userId,
           let cachedFriends = APIClient.shared.cached("/api/friends/\(userId)", as: [AppUser].self) {
            friends = cachedFriends.map { MentionCandidate($0) }
        }
        await load()
        await loadFriends()
    }

    private func loadFriends() async {
        guard let userId = session.userId else { return }
        guard let loaded = try? await APIClient.shared.request("GET", "/api/friends/\(userId)", as: [AppUser].self) else { return }
        friends = loaded.map { MentionCandidate($0) }
    }

    /// Refetches the thread in place (no spinner once something is shown). Comments still being
    /// sent are kept at the end until the server returns them.
    private func load() async {
        defer { isLoading = false }
        do {
            let loaded = try await APIClient.shared.request("GET", commentsPath, as: [FeedComment].self)
            comments = mergingLocal(into: loaded)
            onCountChange(totalCount)
        } catch is CancellationError {
            return
        } catch {
            // With comments on screen a failed refresh stays silent
            if comments.isEmpty {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// `loaded` plus the local comments whose server version isn't in it yet (still being sent).
    private func mergingLocal(into loaded: [FeedComment]) -> [FeedComment] {
        var serverIds = Set<String>()
        for comment in loaded {
            serverIds.insert(comment.id)
            for reply in comment.replies {
                serverIds.insert(reply.id)
            }
        }
        let pending: (FeedComment) -> Bool = { comment in
            guard OptimisticCache.isLocal(comment.id) else { return false }
            guard let serverId = sentIds[comment.id] else { return true }
            return !serverIds.contains(serverId)
        }
        var result = loaded
        for comment in comments where pending(comment) {
            result.append(comment)
        }
        for thread in comments where !OptimisticCache.isLocal(thread.id) {
            let localReplies = thread.replies.filter(pending)
            guard !localReplies.isEmpty, let index = result.firstIndex(where: { $0.id == thread.id }) else { continue }
            result[index].replies.append(contentsOf: localReplies)
        }
        return result
    }

    private func reply(to comment: FeedComment) {
        replyingTo = comment
        inputFocused = true
    }

    private func openProfile(_ userId: String) {
        inputFocused = false
        profileUserId = userId
    }

    /// A comment drawn before the server has it (id "local-…").
    private func localComment(content: String, parentId: String?) -> FeedComment? {
        guard let user = session.user else { return nil }
        let object: [String: Any] = [
            "id": OptimisticCache.localId(),
            "userId": user.id,
            "parentId": OptimisticCache.nullable(parentId),
            "content": content,
            "createdAt": OptimisticCache.nowString(),
            "user": [
                "id": user.id,
                "username": user.username,
                "name": user.name,
                "color": user.color,
                "avatar": OptimisticCache.nullable(user.avatar),
            ] as [String: Any],
            "replies": [Any](),
            "likeCount": 0,
            "dislikeCount": 0,
            "userReaction": NSNull(),
        ]
        return OptimisticCache.decode(FeedComment.self, from: object)
    }

    /// Optimistic: the comment appears at once and the composer is cleared; if the server refuses
    /// it, it's removed again and the text goes back to the composer.
    private func send() {
        let content = String(draft.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500))
        guard !content.isEmpty else { return }
        let thread = replyingTo
        let parentId: String? = thread.map { $0.parentId ?? $0.id }
        var body: [String: Any] = ["content": content]
        if let parentId { body["parentId"] = parentId }

        let local = localComment(content: content, parentId: parentId)
        if let local {
            if let parentId, let index = comments.firstIndex(where: { $0.id == parentId }) {
                comments[index].replies.append(local)
            } else {
                comments.append(local)
            }
            onCountChange(totalCount)
        }
        draft = ""
        replyingTo = nil
        Haptics.tap()

        Task {
            do {
                let created = try await APIClient.shared.request(
                    "POST", "/api/feed/events/\(event.id)/comments", body: body, as: CreatedComment.self
                )
                // The local comment stays until the refetched thread contains the server's one
                if let local { sentIds[local.id] = created.id }
                await load()
            } catch {
                if let local {
                    removeLocal(local.id)
                    onCountChange(totalCount)
                }
                if draft.isEmpty {
                    draft = content
                    replyingTo = thread
                }
                toastMessage = "No se ha podido publicar el comentario. Inténtalo de nuevo."
            }
        }
    }

    private func removeLocal(_ id: String) {
        comments.removeAll { $0.id == id }
        for index in comments.indices {
            comments[index].replies.removeAll { $0.id == id }
        }
    }

    private func findReaction(_ commentId: String) -> ReactionState? {
        for comment in comments {
            if comment.id == commentId {
                return ReactionState(likeCount: comment.likeCount, dislikeCount: comment.dislikeCount, userReaction: comment.userReaction)
            }
            if let reply = comment.replies.first(where: { $0.id == commentId }) {
                return ReactionState(likeCount: reply.likeCount, dislikeCount: reply.dislikeCount, userReaction: reply.userReaction)
            }
        }
        return nil
    }

    /// Optimistic like / dislike, rolled back with a short message if the server refuses it.
    private func react(_ comment: FeedComment, _ reaction: String) {
        guard !OptimisticCache.isLocal(comment.id), let before = findReaction(comment.id) else { return }
        Haptics.tap()
        let after = before.toggled(reaction)
        let commentId = comment.id
        let eventId = event.id
        show(after, commentId: commentId, eventId: eventId)
        reactionSync.send(
            targetType: "comment",
            targetId: commentId,
            before: before,
            after: after,
            onSettled: { state in
                show(state, commentId: commentId, eventId: eventId)
            },
            onFailed: { state, message in
                show(state, commentId: commentId, eventId: eventId)
                toastMessage = message
            }
        )
    }

    private func show(_ state: ReactionState, commentId: String, eventId: String) {
        apply(state, to: commentId)
        OptimisticCache.setCommentReaction(eventId: eventId, commentId: commentId, state: state)
    }

    /// Updates a comment's counters in place (top-level or reply) without reloading the thread.
    private func apply(_ state: ReactionState, to commentId: String) {
        for index in comments.indices {
            if comments[index].id == commentId {
                comments[index].likeCount = state.likeCount
                comments[index].dislikeCount = state.dislikeCount
                comments[index].userReaction = state.userReaction
                return
            }
            if let replyIndex = comments[index].replies.firstIndex(where: { $0.id == commentId }) {
                comments[index].replies[replyIndex].likeCount = state.likeCount
                comments[index].replies[replyIndex].dislikeCount = state.dislikeCount
                comments[index].replies[replyIndex].userReaction = state.userReaction
                return
            }
        }
    }

    /// Optimistic: the comment (and its replies) disappears at once; it comes back if the server refuses.
    private func delete(_ comment: FeedComment) {
        guard !OptimisticCache.isLocal(comment.id) else { return }
        let snapshot = comments
        if replyingTo?.id == comment.id { replyingTo = nil }
        withAnimation(.snappy) {
            removeLocal(comment.id)
        }
        onCountChange(totalCount)
        Task {
            do {
                try await APIClient.shared.send("DELETE", "/api/feed/comments/\(comment.id)", body: [:])
            } catch {
                withAnimation(.snappy) {
                    comments = snapshot
                }
                onCountChange(totalCount)
                toastMessage = "No se ha podido borrar el comentario."
            }
        }
    }
}

/// Body of POST /api/feed/events/:id/comments (only the new comment's id is needed).
private struct CreatedComment: Decodable {
    let id: String
}

private struct CommentProfileTarget: Identifiable {
    let id: String
}

private struct CommentRow: View {
    let comment: FeedComment
    let isMine: Bool
    let isReply: Bool
    let people: [MentionCandidate]
    let isReacting: Bool
    let onReply: () -> Void
    let onReact: (String) -> Void
    let onDelete: () -> Void
    let onReport: () -> Void
    let onOpenUser: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: DS.Spacing.m) {
            Button { onOpenUser(comment.user.id) } label: {
                AvatarView(name: comment.user.name, avatar: comment.user.avatar, color: comment.user.color, size: isReply ? 28 : 34)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Ver perfil de \(comment.user.name)")
            VStack(alignment: .leading, spacing: 6) {
                content
                actions
            }
            Spacer(minLength: 0)
        }
        .swipeActions {
            if isMine {
                Button("Borrar", role: .destructive, action: onDelete)
            } else {
                Button("Denunciar", action: onReport)
                    .tint(Color.steal)
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Button { onOpenUser(comment.user.id) } label: {
                    Text(isMine ? "Tú" : comment.user.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }
                .buttonStyle(.borderless)
                Text(Format.relative(APIDate.parse(comment.createdAt)))
                    .font(Font.meta)
                    .foregroundStyle(.secondary)
            }
            MentionText(text: comment.content, people: people, onOpenUser: onOpenUser)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var actions: some View {
        HStack(spacing: DS.Spacing.l) {
            Button { onReact("like") } label: {
                Label("\(comment.likeCount)", systemImage: comment.userReaction == "like" ? "hand.thumbsup.fill" : "hand.thumbsup")
                    .foregroundStyle(comment.userReaction == "like" ? Color.brand : Color.secondary)
                    .contentTransition(.numericText(value: Double(comment.likeCount)))
            }
            .accessibilityLabel("Me gusta, \(comment.likeCount)")
            Button { onReact("dislike") } label: {
                Label("\(comment.dislikeCount)", systemImage: comment.userReaction == "dislike" ? "hand.thumbsdown.fill" : "hand.thumbsdown")
                    .foregroundStyle(comment.userReaction == "dislike" ? Color.primary : Color.secondary)
                    .contentTransition(.numericText(value: Double(comment.dislikeCount)))
            }
            .accessibilityLabel("No me gusta, \(comment.dislikeCount)")
            Button("Responder", action: onReply)
                .fontWeight(.medium)
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
        .monospacedDigit()
        .foregroundStyle(.secondary)
        .buttonStyle(.borderless)
        .disabled(isReacting)
        .animation(.snappy, value: comment.likeCount)
        .animation(.snappy, value: comment.dislikeCount)
    }
}
