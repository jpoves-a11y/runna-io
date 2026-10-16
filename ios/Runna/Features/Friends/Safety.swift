import SwiftUI

// MARK: - Reports and blocks (App Store guideline 1.2)

/// Something the user can report. `targetType` is one of "user", "comment", "feed_event" or "photo".
struct ReportTarget: Identifiable, Hashable {
    let targetType: String
    let targetId: String
    let reportedUserId: String?

    var id: String { "\(targetType):\(targetId)" }

    static func user(_ userId: String) -> ReportTarget {
        ReportTarget(targetType: "user", targetId: userId, reportedUserId: userId)
    }

    static func comment(_ comment: FeedComment) -> ReportTarget {
        ReportTarget(targetType: "comment", targetId: comment.id, reportedUserId: comment.userId)
    }

    static func feedEvent(_ event: FeedEvent) -> ReportTarget {
        ReportTarget(targetType: "feed_event", targetId: event.id, reportedUserId: event.userId)
    }

    static func photo(id: String, senderId: String?) -> ReportTarget {
        ReportTarget(targetType: "photo", targetId: id, reportedUserId: senderId)
    }
}

enum ReportReason: String, CaseIterable, Identifiable {
    case spam
    case harassment
    case inappropriate
    case cheating
    case other

    var id: String { rawValue }

    var title: String {
        switch self {
        case .spam: return "Spam"
        case .harassment: return "Acoso o insultos"
        case .inappropriate: return "Contenido inapropiado"
        case .cheating: return "Trampas (GPS falso)"
        case .other: return "Otro"
        }
    }

    var systemImage: String {
        switch self {
        case .spam: return "envelope.badge.fill"
        case .harassment: return "bubble.left.and.exclamationmark.bubble.right.fill"
        case .inappropriate: return "eye.slash.fill"
        case .cheating: return "location.slash.fill"
        case .other: return "ellipsis.circle.fill"
        }
    }
}

/// Calls for reports and blocks.
enum SafetyAPI {
    static func report(targetType: String, targetId: String, reportedUserId: String?, reason: String) async throws {
        var body: [String: Any] = [
            "targetType": targetType,
            "targetId": targetId,
            "reason": String(reason.prefix(500)),
        ]
        if let reportedUserId {
            body["reportedUserId"] = reportedUserId
        } else {
            body["reportedUserId"] = NSNull()
        }
        try await APIClient.shared.send("POST", "/api/reports", body: body)
    }

    static func block(userId: String) async throws {
        try await APIClient.shared.send("POST", "/api/blocks/\(userId)", body: [:])
    }

    static func unblock(userId: String) async throws {
        try await APIClient.shared.send("DELETE", "/api/blocks/\(userId)")
    }

    static func blockedUsers() async throws -> [UserRef] {
        let response = try await APIClient.shared.request("GET", "/api/blocks", as: BlockedUsersResponse.self)
        return response.blocks
    }
}

/// Sheet to report a user, comment, feed post or photo: reason picker, optional details, POST /api/reports.
struct ReportSheet: View {
    let targetType: String
    let targetId: String
    let reportedUserId: String?

    @Environment(\.dismiss) private var dismiss
    @State private var reason: ReportReason = .spam
    @State private var details = ""
    @State private var isSending = false
    @State private var sent = false
    @State private var errorMessage: String?

    init(targetType: String, targetId: String, reportedUserId: String? = nil) {
        self.targetType = targetType
        self.targetId = targetId
        self.reportedUserId = reportedUserId
    }

    var body: some View {
        NavigationStack {
            Group {
                if sent {
                    EmptyStateView(
                        systemImage: "checkmark.shield.fill",
                        title: "Gracias, lo revisaremos",
                        message: "Nuestro equipo revisará la denuncia y tomará medidas si incumple las normas de Runna.io. Si no quieres ver más a esta persona, también puedes bloquearla desde su perfil.",
                        actionTitle: "Cerrar",
                        action: { dismiss() }
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .screenBackground()
                } else {
                    form
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if !sent {
                        Button("Cancelar") { dismiss() }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if sent {
                        EmptyView()
                    } else if isSending {
                        ProgressView()
                    } else {
                        Button("Enviar") { send() }
                    }
                }
            }
            .errorAlert($errorMessage)
        }
        .presentationDetents([.medium, .large])
        .presentationCornerRadius(28)
        .interactiveDismissDisabled(isSending)
    }

    private var form: some View {
        Form {
            Section {
                Picker("Motivo", selection: $reason) {
                    ForEach(ReportReason.allCases) { option in
                        Label(option.title, systemImage: option.systemImage).tag(option)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .listRowBackground(Color.surface)
            } header: {
                SocialSectionHeader(title: "¿Qué ocurre?", systemImage: "exclamationmark.bubble.fill", tint: .steal)
            }

            Section {
                TextField("Cuéntanos más (opcional)", text: $details, axis: .vertical)
                    .lineLimit(3...6)
                    .listRowBackground(Color.surface)
            } footer: {
                Text("La denuncia es anónima: la otra persona no sabrá quién la ha enviado.")
            }
        }
        .listBackground()
        .tint(Color.steal)
        .disabled(isSending)
    }

    private var title: String {
        switch targetType {
        case "user": return "Denunciar usuario"
        case "comment": return "Denunciar comentario"
        case "photo": return "Denunciar foto"
        default: return "Denunciar publicación"
        }
    }

    private func send() {
        guard !isSending else { return }
        let extra = details.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = extra.isEmpty ? reason.title : "\(reason.title): \(extra)"
        isSending = true
        Task {
            do {
                try await SafetyAPI.report(targetType: targetType, targetId: targetId, reportedUserId: reportedUserId, reason: text)
                Haptics.success()
                sent = true
            } catch {
                errorMessage = error.localizedDescription
            }
            isSending = false
        }
    }
}

extension View {
    /// Presents a ReportSheet while `target` is set.
    func reportSheet(_ target: Binding<ReportTarget?>) -> some View {
        sheet(item: target) { item in
            ReportSheet(targetType: item.targetType, targetId: item.targetId, reportedUserId: item.reportedUserId)
        }
    }
}

/// "Usuarios bloqueados": the people you have blocked, with unblock. Meant to be pushed from Profile.
struct BlockedUsersView: View {
    @Environment(AppRouter.self) private var router
    @State private var users: [UserRef] = []
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var errorMessage: String?
    @State private var busyIds: Set<String> = []
    @State private var userToUnblock: UserRef?

    var body: some View {
        List {
            if !users.isEmpty {
                Section {
                    ForEach(users) { user in
                        HStack {
                            PersonRow(name: user.name, username: user.username, avatar: user.avatar, color: user.color)
                                .grayscale(0.6)
                            Spacer()
                            if busyIds.contains(user.id) {
                                ProgressView()
                            } else {
                                Button {
                                    userToUnblock = user
                                } label: {
                                    SocialPillLabel(title: "Desbloquear", systemImage: "hand.raised.slash", tint: .secondary, kind: .soft, compact: true)
                                }
                                .buttonStyle(.borderless)
                            }
                        }
                        .listRowBackground(Color.surface)
                    }
                } footer: {
                    Text("No veis la actividad, los comentarios ni las fotos del otro, y no podéis enviaros solicitudes de amistad.")
                }
            }
        }
        .overlay {
            if users.isEmpty {
                if isLoading {
                    ProgressView()
                } else if let loadError {
                    ErrorView(message: loadError) { Task { await load() } }
                } else {
                    EmptyStateView(
                        systemImage: "hand.thumbsup.fill",
                        title: "Todo en paz por aquí",
                        message: "No has bloqueado a nadie. Si alguien se pasa de la raya, puedes bloquearlo desde su perfil."
                    )
                }
            }
        }
        .listStyle(.insetGrouped)
        .listBackground()
        .navigationTitle("Usuarios bloqueados")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog(
            "¿Desbloquear a \(userToUnblock?.name ?? "")?",
            isPresented: Binding(get: { userToUnblock != nil }, set: { if !$0 { userToUnblock = nil } }),
            titleVisibility: .visible
        ) {
            Button("Desbloquear") {
                if let user = userToUnblock { unblock(user) }
            }
        } message: {
            Text("Podrá volver a encontrarte y enviarte solicitudes de amistad. No volveréis a ser amigos automáticamente.")
        }
        .errorAlert($errorMessage)
    }

    private func load() async {
        do {
            users = try await SafetyAPI.blockedUsers()
            loadError = nil
        } catch is CancellationError {
            return
        } catch {
            loadError = error.localizedDescription
        }
        isLoading = false
    }

    private func unblock(_ user: UserRef) {
        guard !busyIds.contains(user.id) else { return }
        busyIds.insert(user.id)
        Task {
            do {
                try await SafetyAPI.unblock(userId: user.id)
                users.removeAll { $0.id == user.id }
                Haptics.success()
                router.reloadSignal += 1
            } catch {
                errorMessage = error.localizedDescription
            }
            busyIds.remove(user.id)
        }
    }
}
