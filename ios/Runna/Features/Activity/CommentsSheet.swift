import SwiftUI

/// Comments on a feed event (one level of replies), with likes and deleting your own comments.
struct CommentsSheet: View {
    let event: FeedEvent
    let onCountChange: (Int) -> Void

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var comments: [FeedComment] = []
    @State private var draft = ""
    @State private var replyingTo: FeedComment?
    @State private var isLoading = true
    @State private var isSending = false
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
                    CommentRow(comment: comment, isMine: comment.userId == session.userId,
                               onReply: { reply(to: comment) },
                               onLike: { like(comment) },
                               onDelete: { delete(comment) })
                    ForEach(comment.replies) { reply in
                        CommentRow(comment: reply, isMine: reply.userId == session.userId,
                                   onReply: { self.reply(to: comment) },
                                   onLike: { like(reply) },
                                   onDelete: { delete(reply) })
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
            .errorAlert($errorMessage)
        }
        .task { await load() }
    }

    private var composer: some View {
        VStack(spacing: 6) {
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
                TextField("Escribe un comentario…", text: $draft, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)
                    .focused($inputFocused)
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

    private var totalCount: Int {
        comments.reduce(0) { $0 + 1 + $1.replies.count }
    }

    private func load() async {
        defer { isLoading = false }
        do {
            comments = try await APIClient.shared.request("GET", "/api/feed/events/\(event.id)/comments", as: [FeedComment].self)
            onCountChange(totalCount)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func reply(to comment: FeedComment) {
        replyingTo = comment
        inputFocused = true
    }

    private func send() {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return }
        isSending = true
        Task {
            do {
                var body: [String: Any] = ["content": String(content.prefix(500))]
                if let parentId = replyingTo?.id { body["parentId"] = parentId }
                try await APIClient.shared.send("POST", "/api/feed/events/\(event.id)/comments", body: body)
                draft = ""
                replyingTo = nil
                await load()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSending = false
        }
    }

    private func like(_ comment: FeedComment) {
        Task {
            do {
                try await APIClient.shared.send(
                    "POST", "/api/feed/reactions",
                    body: ["targetType": "comment", "targetId": comment.id, "reactionType": "like"]
                )
                await load()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func delete(_ comment: FeedComment) {
        Task {
            do {
                try await APIClient.shared.send("DELETE", "/api/feed/comments/\(comment.id)", body: [:])
                await load()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct CommentRow: View {
    let comment: FeedComment
    let isMine: Bool
    let onReply: () -> Void
    let onLike: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AvatarView(name: comment.user.name, avatar: comment.user.avatar, color: comment.user.color, size: 30)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(comment.user.name).font(.subheadline.weight(.semibold))
                    Text(Format.relative(APIDate.parse(comment.createdAt)))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(comment.content).font(.subheadline)
                HStack(spacing: 16) {
                    Button(action: onLike) {
                        Label("\(comment.likeCount)", systemImage: comment.userReaction == "like" ? "heart.fill" : "heart")
                    }
                    Button("Responder", action: onReply)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .buttonStyle(.plain)
            }
            Spacer()
        }
        .swipeActions {
            if isMine {
                Button("Borrar", role: .destructive, action: onDelete)
            }
        }
    }
}
