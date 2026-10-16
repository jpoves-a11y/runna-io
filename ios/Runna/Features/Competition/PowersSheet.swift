import SwiftUI
import Observation

@MainActor
@Observable
final class PowersModel {
    private(set) var powers: [UserPower] = []
    private(set) var isLoading = false
    private(set) var loaded = false
    private(set) var activatingId: String?
    var errorMessage: String?
    var resultMessage: String?
    /// Shown once the nickname sheet has closed (an alert can't appear under it).
    var pendingResultMessage: String?

    var active: [UserPower] { powers.filter { $0.isActive } }
    var available: [UserPower] { powers.filter { $0.isAvailable } }
    var spent: [UserPower] { powers.filter { !$0.isActive && !$0.isAvailable } }

    func load(userId: String) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await APIClient.shared.request("GET", "/api/users/\(userId)/powers", as: UserPowersResponse.self)
            powers = response.powers
            errorMessage = nil
            CompetitionStore.shared.setAvailablePowerCount(available.count)
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
        loaded = true
    }

    /// Activates a power. Returns the server's message on success, or the error.
    func activate(_ power: UserPower, userId: String, body: [String: Any]? = nil) async -> Result<String, APIError> {
        activatingId = power.id
        defer { activatingId = nil }
        do {
            let response = try await APIClient.shared.request("POST", "/api/powers/\(power.id)/activate", body: body ?? [:], as: PowerActivationResponse.self)
            Haptics.success()
            await load(userId: userId)
            return .success(response.message ?? "Activado")
        } catch let error as APIError {
            return .failure(error)
        } catch {
            return .failure(APIError(status: 0, message: error.localizedDescription))
        }
    }
}

/// "Poderes": powers won from treasures, grouped into active, available and used.
struct PowersSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var model = PowersModel()
    @State private var nicknamePower: UserPower?

    var body: some View {
        NavigationStack {
            List {
                if !model.active.isEmpty {
                    Section("Activos (\(model.active.count))") {
                        ForEach(model.active) { power in
                            PowerRow(power: power, mode: .active)
                        }
                    }
                }
                if !model.available.isEmpty {
                    Section("Disponibles (\(model.available.count))") {
                        ForEach(model.available) { power in
                            PowerRow(power: power, mode: .available(isActivating: model.activatingId == power.id)) {
                                activate(power)
                            }
                            .disabled(model.activatingId != nil)
                        }
                    }
                }
                if !model.spent.isEmpty {
                    Section("Usados (\(model.spent.count))") {
                        ForEach(model.spent) { power in
                            PowerRow(power: power, mode: .spent)
                        }
                    }
                }
            }
            .overlay {
                if model.powers.isEmpty {
                    if model.isLoading || !model.loaded {
                        ProgressView()
                    } else if let message = model.errorMessage {
                        ErrorView(message: message) { Task { await reload() } }
                    } else {
                        EmptyStateView(
                            systemImage: "map",
                            title: "Aún no tienes poderes",
                            message: "🗺️ ¡Recoge tesoros corriendo para obtenerlos!"
                        )
                    }
                }
            }
            .navigationTitle("Poderes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if !model.available.isEmpty {
                        Text("\(model.available.count) disponible\(model.available.count == 1 ? "" : "s")")
                            .font(.caption.weight(.bold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.orange, in: Capsule())
                            .foregroundStyle(.white)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .refreshable { await reload() }
            .task { await reload() }
            .alert(
                "¡Poder activado!",
                isPresented: Binding(get: { model.resultMessage != nil }, set: { if !$0 { model.resultMessage = nil } }),
                actions: { Button("OK", role: .cancel) {} },
                message: { Text(model.resultMessage ?? "") }
            )
            .errorAlert(Binding(
                get: { model.powers.isEmpty ? nil : model.errorMessage },
                set: { model.errorMessage = $0 }
            ))
            .sheet(item: $nicknamePower, onDismiss: {
                if let message = model.pendingResultMessage {
                    model.pendingResultMessage = nil
                    model.resultMessage = message
                }
            }) { power in
                NicknamePowerSheet(power: power, model: model)
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func reload() async {
        guard let userId = session.userId else { return }
        await model.load(userId: userId)
    }

    private func activate(_ power: UserPower) {
        if power.powerType == "nickname" {
            nicknamePower = power
            return
        }
        guard let userId = session.userId else { return }
        Task {
            switch await model.activate(power, userId: userId) {
            case .success(let message):
                model.resultMessage = "\(power.emoji) \(power.name): \(message)"
            case .failure(let error):
                model.errorMessage = error.message
            }
        }
    }
}

private struct PowerRow: View {
    enum Mode {
        case active
        case available(isActivating: Bool)
        case spent
    }

    let power: UserPower
    let mode: Mode
    var onActivate: () -> Void = {}

    var body: some View {
        HStack(spacing: 12) {
            Text(power.emoji)
                .font(.title)
                .frame(width: 46, height: 46)
                .background(Rarity.color(power.rarity).opacity(0.15), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(power.name)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    RarityPill(rarity: power.rarity)
                }
                switch mode {
                case .active:
                    HStack(spacing: 4) {
                        Circle().fill(Color.green).frame(width: 7, height: 7)
                        Text(power.activeLabel)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.green)
                        if let expires = power.expiresDate, expires > Date() {
                            Text("· quedan \(Text(timerInterval: Date.countdownRange(to: expires), countsDown: true))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                    }
                case .available, .spent:
                    Text(power.definition?.description ?? "")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 4)
            if case .available(let isActivating) = mode {
                if isActivating {
                    ProgressView()
                } else {
                    Button("Activar", action: onActivate)
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
            }
        }
        .padding(.vertical, 4)
        .opacity(isSpent ? 0.5 : 1)
    }

    private var isSpent: Bool {
        if case .spent = mode { return true }
        return false
    }
}

/// "Pluma del Troll": pick another participant and give them a public nickname for 48 h.
private struct NicknamePowerSheet: View {
    let power: UserPower
    let model: PowersModel

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var participants: [UserRef] = []
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var search = ""
    @State private var selectedId: String?
    @State private var nickname = ""
    @State private var isSending = false
    @State private var sendError: String?

    private static let maxLength = 20

    private var filtered: [UserRef] {
        let others = participants.filter { $0.id != session.userId }
        let query = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return others }
        return others.filter { $0.username.lowercased().contains(query) || $0.name.lowercased().contains(query) }
    }

    private var trimmedNickname: String { nickname.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Elige a quién ponerle un apodo público durante 48h.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Section {
                    TextField("Ej: El Tortuga, Piernas Locas...", text: $nickname)
                        .textInputAutocapitalization(.words)
                        .onChange(of: nickname) { _, value in
                            if value.count > Self.maxLength {
                                nickname = String(value.prefix(Self.maxLength))
                            }
                        }
                } header: {
                    Text("Apodo")
                } footer: {
                    Text("\(nickname.count)/\(Self.maxLength)")
                }
                Section("Jugador") {
                    if isLoading {
                        ProgressView()
                    } else if let loadError {
                        Text(loadError).foregroundStyle(.red)
                    } else if filtered.isEmpty {
                        Text("No hay jugadores que coincidan").foregroundStyle(.secondary)
                    }
                    ForEach(filtered) { user in
                        Button {
                            selectedId = user.id
                        } label: {
                            HStack(spacing: 12) {
                                AvatarView(name: user.name, avatar: user.avatar, color: user.color, size: 34)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(user.name).font(.subheadline.weight(.semibold))
                                    Text("@\(user.username)").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if selectedId == user.id {
                                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.pink)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .listRowBackground(selectedId == user.id ? Color.pink.opacity(0.12) : nil)
                    }
                }
            }
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Buscar por nombre o @usuario")
            .navigationTitle("✏️ Pluma del Troll")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSending {
                        ProgressView()
                    } else {
                        Button("Asignar") { assign() }
                            .disabled(selectedId == nil || trimmedNickname.isEmpty)
                    }
                }
            }
            .task { await loadParticipants() }
            .errorAlert($sendError)
        }
    }

    private func loadParticipants() async {
        do {
            let response = try await APIClient.shared.request("GET", "/api/competition/participants", as: ParticipantsResponse.self)
            participants = response.participants.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            loadError = nil
        } catch is CancellationError {
            return
        } catch {
            loadError = error.localizedDescription
        }
        isLoading = false
    }

    private func assign() {
        guard let userId = session.userId, let targetId = selectedId, !trimmedNickname.isEmpty else { return }
        let body: [String: Any] = ["targetUserId": targetId, "nickname": String(trimmedNickname.prefix(Self.maxLength))]
        isSending = true
        Task {
            let result = await model.activate(power, userId: userId, body: body)
            isSending = false
            switch result {
            case .success:
                let target = participants.first { $0.id == targetId }?.name ?? "el jugador"
                model.pendingResultMessage = "🎭 ¡Apodo asignado! \"\(trimmedNickname)\" asignado a \(target) durante 48h"
                dismiss()
            case .failure(let error):
                sendError = error.message
            }
        }
    }
}
