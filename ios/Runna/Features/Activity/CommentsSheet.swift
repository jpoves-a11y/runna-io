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
                    EmptyStateView(
                        systemImage: "bubble.left.and.bubble.right.fill",
                        title: "Aquí hay mucho silencio",
                        message: "Rompe el hielo con el primer comentario. Un poco de pique sano nunca viene mal.",
                        tint: .sky
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
            isReacting: reactingIds.contains(comment.id),
            onReply: { reply(to: thread) },
            onReact: { reaction in react(comment, reaction) },
            onDelete: { commentToDelete = comment },
            onReport: { reportTarget = .comment(comment) },
            onOpenUser: { openProfile($0) }
        )
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 6, leading: isReply ? 52 : 16, bottom: 6, trailing: 16))
    }

    // MARK: - Composer

    private var mentionSuggestions: [MentionCandidate] {
        guard let query = Mentions.trailingQuery(in: draft) else { return [] }
        return Mentions.suggestions(for: query, among: friends)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
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
                TextField("Escribe algo… (@ para mencionar)", text: $draft, axis: .vertical)
                    .lineLimit(1...4)
                    .focused($inputFocused)
                    .disabled(isSending)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 11)
                    .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .strokeBorder(inputFocused ? Color.brand.opacity(0.5) : Color.hairline, lineWidth: 1)
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
                    .fill(.brandGradient)
                    .opacity(canSend || isSending ? 1 : 0.35)
                if isSending {
                    ProgressView()
                        .tint(.white)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 18, weight: .heavy))
                        .foregroundStyle(.white)
                }
            }
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
                    .font(.system(.caption, design: .rounded, weight: .bold))
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
        .background(Color(hex: person.color).opacity(0.14), in: Capsule())
    }

    private func replyBanner(_ comment: FeedComment) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "arrowshape.turn.up.left.fill")
                .font(.caption.weight(.bold))
                .foregroundStyle(Color.brand)
            Text("Respondiendo a \(comment.user.name)")
                .font(.system(.caption, design: .rounded, weight: .semibold))
                .lineLimit(1)
            Spacer()
            Button {
                replyingTo = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 24, height: 24)
                    .background(Color.surfaceRaised, in: Circle())
            }
            .accessibilityLabel("Cancelar respuesta")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.brand.opacity(0.10), in: Capsule())
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
    let isReply: Bool
    let people: [MentionCandidate]
    let isReacting: Bool
    let onReply: () -> Void
    let onReact: (String) -> Void
    let onDelete: () -> Void
    let onReport: () -> Void
    let onOpenUser: (String) -> Void

    private var userColor: Color { Color(hex: comment.user.color) }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if isMine {
                Spacer(minLength: 40)
            } else {
                Button { onOpenUser(comment.user.id) } label: {
                    AvatarView(name: comment.user.name, avatar: comment.user.avatar, color: comment.user.color, size: isReply ? 28 : 34)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Ver perfil de \(comment.user.name)")
            }
            VStack(alignment: isMine ? .trailing : .leading, spacing: 4) {
                bubble
                actions
            }
            if !isMine {
                Spacer(minLength: 24)
            }
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

    private var bubbleShape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: isMine ? 20 : 6,
            bottomLeadingRadius: 20,
            bottomTrailingRadius: 20,
            topTrailingRadius: isMine ? 6 : 20,
            style: .continuous
        )
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Button { onOpenUser(comment.user.id) } label: {
                    Text(isMine ? "Tú" : comment.user.displayName)
                        .font(.system(.caption, design: .rounded, weight: .bold))
                        .foregroundStyle(isMine ? Color.brandDeep : userColor)
                        .lineLimit(1)
                }
                .buttonStyle(.borderless)
                Text(Format.relative(APIDate.parse(comment.createdAt)))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            MentionText(text: comment.content, people: people, onOpenUser: onOpenUser)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(isMine ? Color.brand.opacity(0.16) : Color.surface, in: bubbleShape)
        .overlay(bubbleShape.stroke(isMine ? Color.brand.opacity(0.25) : Color.hairline, lineWidth: 1))
    }

    private var actions: some View {
        HStack(spacing: 14) {
            Button { onReact("like") } label: {
                Label("\(comment.likeCount)", systemImage: comment.userReaction == "like" ? "heart.fill" : "heart")
                    .foregroundStyle(comment.userReaction == "like" ? Color.steal : Color.secondary)
                    .contentTransition(.numericText(value: Double(comment.likeCount)))
            }
            .accessibilityLabel("Me gusta, \(comment.likeCount)")
            Button { onReact("dislike") } label: {
                Label("\(comment.dislikeCount)", systemImage: comment.userReaction == "dislike" ? "hand.thumbsdown.fill" : "hand.thumbsdown")
                    .foregroundStyle(comment.userReaction == "dislike" ? Color.grape : Color.secondary)
                    .contentTransition(.numericText(value: Double(comment.dislikeCount)))
            }
            .accessibilityLabel("No me gusta, \(comment.dislikeCount)")
            Button("Responder", action: onReply)
                .fontWeight(.semibold)
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
        .font(.system(.caption, design: .rounded))
        .foregroundStyle(.secondary)
        .buttonStyle(.borderless)
        .disabled(isReacting)
        .padding(.horizontal, 6)
        .animation(.snappy, value: comment.likeCount)
        .animation(.snappy, value: comment.dislikeCount)
    }
}
