import Foundation
import Observation
import SwiftUI
import UIKit

// MARK: - Store

/// Messages of the club chat on screen: the latest page (polled every few seconds while open),
/// older pages on demand, and the actions (send, react, delete, mute).
@MainActor
@Observable
final class ClubChatStore {
    let clubId: String

    private(set) var messages: [ClubChatMessage] = []
    private(set) var hasMore = false
    private(set) var hasLoaded = false
    private(set) var isLoadingOlder = false
    private(set) var isSending = false
    private(set) var reactions: [String] = ["👍", "❤️", "🔥", "😂", "👏", "💪"]
    private(set) var canModerate = false
    private(set) var mutedUntil: Date?
    /// Who is muted (only for the leader and officers)
    private(set) var mutes: [String: Date] = [:]
    var errorMessage: String?

    init(clubId: String) {
        self.clubId = clubId
    }

    var isMuted: Bool { (mutedUntil ?? .distantPast) > Date() }

    /// The latest page, merged with what is on screen (new messages, reactions, deletions).
    func refresh() async {
        do {
            let response: ClubChatResponse = try await APIClient.shared.request("GET", "/api/clubs/\(clubId)/messages")
            apply(response, older: false)
        } catch is CancellationError {
            return
        } catch {
            if !hasLoaded { errorMessage = error.localizedDescription }
        }
        hasLoaded = true
    }

    func loadOlder() async {
        guard hasMore, !isLoadingOlder, let first = messages.first else { return }
        isLoadingOlder = true
        defer { isLoadingOlder = false }
        if let response: ClubChatResponse = try? await APIClient.shared.request("GET", "/api/clubs/\(clubId)/messages", query: ["before": first.id]) {
            apply(response, older: true)
        }
    }

    private func apply(_ response: ClubChatResponse, older: Bool) {
        var byId = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { _, newer in newer })
        for message in response.messages { byId[message.id] = message }
        messages = byId.values.sorted {
            let a = $0.createdAt ?? "", b = $1.createdAt ?? ""
            return a == b ? $0.id < $1.id : a < b
        }
        // Older pages say whether there is more before them; the latest page only on the first load
        if older || !hasLoaded { hasMore = response.hasMore }
        reactions = response.reactions
        if let me = response.me {
            canModerate = me.canModerate
            mutedUntil = APIDate.parse(me.mutedUntil)
        }
        mutes = Dictionary(response.mutes.compactMap { mute in APIDate.parse(mute.until).map { (mute.userId, $0) } }, uniquingKeysWith: { a, _ in a })
    }

    func send(_ text: String, replyTo: String?) async -> Bool {
        guard !isSending else { return false }
        isSending = true
        defer { isSending = false }
        var body: [String: Any] = ["body": text]
        if let replyTo { body["replyTo"] = replyTo }
        do {
            let response: ClubChatPostResponse = try await APIClient.shared.request("POST", "/api/clubs/\(clubId)/messages", body: body)
            messages.append(response.message)
            errorMessage = nil
            return true
        } catch let error as APIError {
            errorMessage = error.message
            // Muted meanwhile: the banner replaces the composer
            if error.status == 403 { await refresh() }
            return false
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func toggle(_ emoji: String, on message: ClubChatMessage) async {
        do {
            let response: ClubChatReactionResponse = try await APIClient.shared.request(
                "POST", "/api/clubs/\(clubId)/messages/\(message.id)/reactions", body: ["emoji": emoji]
            )
            if let index = messages.firstIndex(where: { $0.id == message.id }) {
                messages[index].reactions = response.reactions
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func delete(_ message: ClubChatMessage) async {
        do {
            try await APIClient.shared.send("DELETE", "/api/clubs/\(clubId)/messages/\(message.id)")
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func mute(userId: String, hours: Int) async {
        do {
            try await APIClient.shared.send("POST", "/api/clubs/\(clubId)/members/\(userId)/mute", body: ["hours": hours])
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func markRead() async {
        guard let last = messages.last else { return }
        try? await APIClient.shared.send("POST", "/api/clubs/\(clubId)/messages/read", body: ["messageId": last.id])
    }
}

// MARK: - Chat

/// The club chat: bubbles (mine on the right), replies, reactions, @mentions, system messages in
/// the middle; long press to react, reply, copy, report, delete or (officers) mute.
struct ClubChatView: View {
    let clubId: String
    let members: [ClubMember]

    @Environment(SessionStore.self) private var session
    @Environment(\.scenePhase) private var scenePhase
    @State private var store: ClubChatStore
    @State private var draft = ""
    @State private var replyTo: ClubChatMessage?
    @State private var reportTarget: ClubChatMessage?
    @State private var confirmDelete: ClubChatMessage?
    @FocusState private var composerFocused: Bool

    /// Seconds between refreshes while the chat is open
    private static let pollSeconds: UInt64 = 8

    init(clubId: String, members: [ClubMember]) {
        self.clubId = clubId
        self.members = members
        _store = State(initialValue: ClubChatStore(clubId: clubId))
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: DS.Spacing.s) {
                    if store.hasMore {
                        Button {
                            Task { await store.loadOlder() }
                        } label: {
                            if store.isLoadingOlder {
                                ProgressView()
                            } else {
                                Text("Mensajes anteriores")
                                    .font(.footnote.weight(.semibold))
                            }
                        }
                        .buttonStyle(.pressable)
                        .padding(.vertical, DS.Spacing.s)
                    }
                    if store.hasLoaded && store.messages.isEmpty {
                        EmptyStateView(
                            systemImage: "bubble.left.and.bubble.right",
                            title: "Aún no hay mensajes",
                            message: "Escribe al club para quedar, animar o comentar la competición."
                        )
                        .padding(.top, DS.Spacing.xxxl)
                    }
                    ForEach(Array(store.messages.enumerated()), id: \.element.id) { index, message in
                        row(message, previous: index > 0 ? store.messages[index - 1] : nil)
                            .id(message.id)
                    }
                    Color.clear.frame(height: 1).id(Self.bottomId)
                }
                .padding(.horizontal, DS.Spacing.l)
                .padding(.vertical, DS.Spacing.m)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: store.messages.last?.id) { _, _ in
                withAnimation(.snappy) { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
            }
        }
        .screenBackground()
        .overlay {
            if !store.hasLoaded { ProgressView() }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .task(id: clubId) { await poll() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await refreshAndRead() } }
        }
        .sheet(item: $reportTarget) { message in
            ReportSheet(targetType: "club_message", targetId: message.id, reportedUserId: message.user?.id)
        }
        .confirmationDialog("¿Eliminar el mensaje?", isPresented: Binding(
            get: { confirmDelete != nil },
            set: { if !$0 { confirmDelete = nil } }
        ), titleVisibility: .visible) {
            Button("Eliminar", role: .destructive) {
                if let message = confirmDelete { Task { await store.delete(message) } }
                confirmDelete = nil
            }
        } message: {
            Text("Seguirá viéndose que había un mensaje, sin su texto.")
        }
    }

    private static let bottomId = "chat-bottom"

    private func poll() async {
        while !Task.isCancelled {
            await refreshAndRead()
            try? await Task.sleep(nanoseconds: Self.pollSeconds * 1_000_000_000)
        }
    }

    private func refreshAndRead() async {
        await store.refresh()
        await store.markRead()
        ClubModel.shared.markChatRead()
    }

    // MARK: Rows

    @ViewBuilder
    private func row(_ message: ClubChatMessage, previous: ClubChatMessage?) -> some View {
        if message.isSystem {
            systemRow(message)
        } else {
            let mine = message.user?.id == session.userId
            // Consecutive messages of the same person within 5 minutes are grouped (one name, one avatar)
            let grouped = previous.map { prev in
                !prev.isSystem && prev.user?.id == message.user?.id
                    && abs((message.date ?? .distantPast).timeIntervalSince(prev.date ?? .distantPast)) < 300
            } ?? false
            ChatBubbleRow(
                message: message,
                mine: mine,
                grouped: grouped,
                usernames: usernames,
                isAuthorMuted: message.user.map { store.mutes[$0.id] != nil } ?? false,
                onToggleReaction: { emoji in Task { await store.toggle(emoji, on: message) } }
            )
            .contextMenu { menu(for: message, mine: mine) }
        }
    }

    private func systemRow(_ message: ClubChatMessage) -> some View {
        VStack(spacing: 2) {
            Text(message.body ?? "")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if let date = message.date {
                Text(date, format: .dateTime.day().month(.abbreviated).hour().minute().locale(Locale(identifier: "es_ES")))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, DS.Spacing.xl)
        .padding(.vertical, DS.Spacing.s)
    }

    @ViewBuilder
    private func menu(for message: ClubChatMessage, mine: Bool) -> some View {
        if !message.deleted {
            Menu {
                ForEach(store.reactions, id: \.self) { emoji in
                    Button(emoji) { Task { await store.toggle(emoji, on: message) } }
                }
            } label: {
                Label("Reaccionar", systemImage: "face.smiling")
            }
            if !store.isMuted {
                Button {
                    replyTo = message
                    composerFocused = true
                } label: {
                    Label("Responder", systemImage: "arrowshape.turn.up.left")
                }
            }
            Button {
                UIPasteboard.general.string = message.body
            } label: {
                Label("Copiar", systemImage: "doc.on.doc")
            }
            if !mine, message.user != nil {
                Button {
                    reportTarget = message
                } label: {
                    Label("Denunciar", systemImage: "exclamationmark.bubble")
                }
            }
            if mine || store.canModerate {
                Button(role: .destructive) {
                    confirmDelete = message
                } label: {
                    Label("Eliminar", systemImage: "trash")
                }
            }
        }
        if store.canModerate, !mine, let author = message.user, role(of: author.id) != "owner" {
            if store.mutes[author.id] != nil {
                Button {
                    Task { await store.mute(userId: author.id, hours: 0) }
                } label: {
                    Label("Quitar silencio", systemImage: "speaker.wave.2")
                }
            } else {
                Menu {
                    Button("1 hora") { Task { await store.mute(userId: author.id, hours: 1) } }
                    Button("24 horas") { Task { await store.mute(userId: author.id, hours: 24) } }
                    Button("7 días") { Task { await store.mute(userId: author.id, hours: 168) } }
                } label: {
                    Label("Silenciar a \(author.name)", systemImage: "speaker.slash")
                }
            }
        }
    }

    private func role(of userId: String) -> String? {
        members.first { $0.user.id == userId }?.role
    }

    /// Usernames of the club, to highlight @mentions.
    private var usernames: Set<String> {
        Set(members.map { $0.user.username.lowercased() })
    }

    // MARK: Composer

    private var composer: some View {
        VStack(spacing: DS.Spacing.s) {
            if let error = store.errorMessage {
                ErrorBanner(message: error, onDismiss: { store.errorMessage = nil })
            }
            if store.isMuted, let until = store.mutedUntil {
                HStack(spacing: DS.Spacing.s) {
                    Image(systemName: "speaker.slash")
                        .foregroundStyle(.secondary)
                    Text("Un oficial te ha silenciado hasta el \(until.formatted(.dateTime.day().month(.abbreviated).hour().minute().locale(Locale(identifier: "es_ES")))). Puedes seguir leyendo el chat.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, DS.Spacing.s)
            } else {
                if let replyTo {
                    replyBanner(replyTo)
                }
                if !mentionSuggestions.isEmpty {
                    mentionBar
                }
                HStack(alignment: .bottom, spacing: DS.Spacing.s) {
                    TextField("Mensaje", text: $draft, axis: .vertical)
                        .lineLimit(1...5)
                        .focused($composerFocused)
                        .padding(.horizontal, DS.Spacing.m)
                        .padding(.vertical, 9)
                        .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 32))
                            .foregroundStyle(canSend ? Color.brand : Color(uiColor: .tertiaryLabel))
                    }
                    .disabled(!canSend)
                    .accessibilityLabel("Enviar")
                }
            }
        }
        .padding(.horizontal, DS.Spacing.l)
        .padding(.top, DS.Spacing.s)
        .padding(.bottom, DS.Spacing.s)
        .background(Color.canvas)
        .overlay(alignment: .top) { HairlineDivider() }
    }

    private var trimmedDraft: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool { !trimmedDraft.isEmpty && trimmedDraft.count <= 1000 && !store.isSending }

    private func send() {
        let text = trimmedDraft
        guard !text.isEmpty else { return }
        let reply = replyTo?.id
        Task {
            if await store.send(text, replyTo: reply) {
                draft = ""
                replyTo = nil
                Haptics.tap()
                await store.markRead()
            }
        }
    }

    private func replyBanner(_ message: ClubChatMessage) -> some View {
        HStack(spacing: DS.Spacing.s) {
            Rectangle()
                .fill(Color.brand)
                .frame(width: 2)
            VStack(alignment: .leading, spacing: 1) {
                Text("Respondiendo a \(message.user?.name ?? "Runna")")
                    .font(.caption.weight(.semibold))
                Text(message.body ?? "Mensaje eliminado")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button {
                replyTo = nil
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.tertiary)
            }
            .accessibilityLabel("No responder")
        }
        .frame(height: 34)
    }

    /// The word being typed after an "@": members whose username or name starts with it.
    private var mentionQuery: String? {
        guard let last = draft.split(separator: " ", omittingEmptySubsequences: false).last,
              last.hasPrefix("@"), !last.contains("\n") else { return nil }
        return String(last.dropFirst()).lowercased()
    }

    private var mentionSuggestions: [ClubMember] {
        guard let query = mentionQuery else { return [] }
        return members
            .filter { $0.user.id != session.userId }
            .filter { query.isEmpty || $0.user.username.lowercased().hasPrefix(query) || $0.user.name.lowercased().hasPrefix(query) }
            .prefix(6)
            .map { $0 }
    }

    private var mentionBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: DS.Spacing.s) {
                ForEach(mentionSuggestions) { member in
                    Button {
                        insertMention(member.user.username)
                    } label: {
                        HStack(spacing: 6) {
                            AvatarView(name: member.user.name, avatar: member.user.avatar, color: member.user.color, size: 22, ring: false)
                            Text(member.user.name)
                                .font(.footnote.weight(.medium))
                                .lineLimit(1)
                        }
                        .padding(.horizontal, DS.Spacing.s)
                        .padding(.vertical, 5)
                        .overlay(Capsule().strokeBorder(Color.hairline, lineWidth: 1))
                    }
                    .buttonStyle(.pressable)
                    .foregroundStyle(.primary)
                }
            }
        }
    }

    private func insertMention(_ username: String) {
        var words = draft.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        if words.isEmpty { words = [""] }
        words[words.count - 1] = "@\(username)"
        draft = words.joined(separator: " ") + " "
    }
}

// MARK: - Bubble

private struct ChatBubbleRow: View {
    let message: ClubChatMessage
    let mine: Bool
    let grouped: Bool
    let usernames: Set<String>
    let isAuthorMuted: Bool
    let onToggleReaction: (String) -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: DS.Spacing.s) {
            if mine {
                Spacer(minLength: 48)
            } else {
                Group {
                    if grouped {
                        Color.clear
                    } else if let user = message.user {
                        AvatarView(name: user.name, avatar: user.avatar, color: user.color, size: 28)
                    }
                }
                .frame(width: 28, height: 28)
            }
            VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
                if !mine && !grouped, let user = message.user {
                    HStack(spacing: 4) {
                        Text(user.name)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        if isAuthorMuted {
                            Image(systemName: "speaker.slash")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .accessibilityLabel("Silenciado")
                        }
                    }
                }
                bubble
                if !message.reactions.isEmpty {
                    reactionsRow
                }
            }
            if !mine { Spacer(minLength: 48) }
        }
        .padding(.top, grouped ? 0 : DS.Spacing.xs)
    }

    @ViewBuilder
    private var bubble: some View {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        if message.deleted {
            Text(message.deletedByModerator ? "Mensaje eliminado por un oficial" : "Mensaje eliminado")
                .font(.subheadline)
                .italic()
                .foregroundStyle(.secondary)
                .padding(.horizontal, DS.Spacing.m)
                .padding(.vertical, DS.Spacing.s)
                .overlay(shape.strokeBorder(Color.hairline, lineWidth: 1))
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if let reply = message.replyTo {
                    HStack(spacing: 6) {
                        Rectangle()
                            .fill(mine ? Color.onBrand.opacity(0.7) : Color.brand)
                            .frame(width: 2)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(reply.userName)
                                .font(.caption.weight(.semibold))
                            Text(reply.body ?? "Mensaje eliminado")
                                .font(.caption)
                                .lineLimit(2)
                                .opacity(0.8)
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
                Text(attributedBody)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                if let date = message.date {
                    Text(date, format: .dateTime.hour().minute())
                        .font(.caption2)
                        .opacity(0.6)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
            .foregroundStyle(mine ? Color.onBrand : Color.primary)
            .padding(.horizontal, DS.Spacing.m)
            .padding(.vertical, DS.Spacing.s)
            .background(mine ? Color.brand : Color.surface, in: shape)
            .overlay {
                if !mine { shape.strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline) }
            }
            .textSelection(.enabled)
        }
    }

    /// The text with @mentions of club members in bold (and in the brand colour on others' bubbles).
    private var attributedBody: Text {
        let text = message.body ?? ""
        guard text.contains("@"), let regex = try? NSRegularExpression(pattern: "@([\\p{L}\\p{N}_.-]{2,30})") else { return Text(text) }
        let ns = text as NSString
        var result = Text("")
        var cursor = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let name = ns.substring(with: match.range(at: 1)).trimmingCharacters(in: CharacterSet(charactersIn: ".-")).lowercased()
            guard usernames.contains(name), match.range.location >= cursor else { continue }
            if match.range.location > cursor {
                result = result + Text(ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor)))
            }
            let mention = Text(ns.substring(with: match.range)).fontWeight(.semibold)
            result = result + (mine ? mention : mention.foregroundStyle(Color.brand))
            cursor = match.range.location + match.range.length
        }
        if cursor < ns.length { result = result + Text(ns.substring(from: cursor)) }
        return result
    }

    private var reactionsRow: some View {
        HStack(spacing: 4) {
            ForEach(message.reactions) { reaction in
                Button {
                    onToggleReaction(reaction.emoji)
                } label: {
                    Text("\(reaction.emoji) \(reaction.count)")
                        .font(.caption)
                        .monospacedDigit()
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .overlay(Capsule().strokeBorder(reaction.mine ? Color.brand : Color.hairline, lineWidth: 1))
                }
                .buttonStyle(.pressable)
                .foregroundStyle(.primary)
                .accessibilityLabel("\(reaction.emoji), \(reaction.count)\(reaction.mine ? ", incluida la tuya" : "")")
            }
        }
    }
}
