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

/// "Poderes": powers won from treasures — active (with a timer), ready to use (grid) and spent.
struct PowersSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var model = PowersModel()
    @State private var nicknamePower: UserPower?

    private let gridColumns: [GridItem] = [
        GridItem(.flexible(), spacing: DS.Spacing.m, alignment: .top),
        GridItem(.flexible(), spacing: DS.Spacing.m, alignment: .top)
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                if !model.powers.isEmpty {
                    content
                }
            }
            .screenBackground()
            .overlay { stateOverlay }
            .navigationTitle("Poderes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .refreshable { await reload() }
            .task { await reload() }
            .alert(
                "Poder activado",
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
        .presentationDragIndicator(.visible)
    }

    // MARK: Content

    private var content: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.xxl) {
            PowersSummaryStrip(available: model.available.count, active: model.active.count, spent: model.spent.count)
            if !model.active.isEmpty {
                activeSection
            }
            if !model.available.isEmpty {
                availableSection
            }
            if !model.spent.isEmpty {
                spentSection
            }
        }
        .padding(.horizontal, DS.Spacing.l)
        .padding(.top, DS.Spacing.s)
        .padding(.bottom, DS.Spacing.xxl)
        .animation(.snappy, value: model.powers)
    }

    private var activeSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Activos")
            PowersListCard(powers: model.active) { power in
                PowerActiveRow(power: power)
            }
        }
    }

    private var availableSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Disponibles", subtitle: "Cada poder se puede usar una vez.")
            LazyVGrid(columns: gridColumns, spacing: DS.Spacing.m) {
                ForEach(model.available) { power in
                    PowerCard(
                        power: power,
                        isActivating: model.activatingId == power.id,
                        isDisabled: model.activatingId != nil,
                        onActivate: { activate(power) }
                    )
                }
            }
        }
    }

    private var spentSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Usados")
            PowersListCard(powers: model.spent) { power in
                PowerSpentRow(power: power)
            }
        }
    }

    @ViewBuilder
    private var stateOverlay: some View {
        if model.powers.isEmpty {
            if model.isLoading || !model.loaded {
                ProgressView()
            } else if let message = model.errorMessage {
                ErrorView(message: message) { Task { await reload() } }
            } else {
                EmptyStateView(
                    systemImage: "shippingbox",
                    title: "Sin poderes",
                    message: "Recoge tesoros del mapa para conseguir poderes."
                )
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button("Cerrar") { dismiss() }
        }
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
                model.resultMessage = "\(power.name): \(message)"
            case .failure(let error):
                model.errorMessage = error.message
            }
        }
    }
}

// MARK: - Summary

/// "3 disponibles | 1 activo | 4 usados", split by hairlines.
private struct PowersSummaryStrip: View {
    let available: Int
    let active: Int
    let spent: Int

    var body: some View {
        HStack(spacing: 0) {
            StatTile(value: "\(available)", label: available == 1 ? "Disponible" : "Disponibles")
            StatDivider()
            StatTile(value: "\(active)", label: active == 1 ? "Activo" : "Activos", tint: active > 0 ? Color.brand : Color.primary)
            StatDivider()
            StatTile(value: "\(spent)", label: spent == 1 ? "Usado" : "Usados")
        }
        .card(padding: 14)
    }
}

// MARK: - Cards and rows

/// Rows inside one flat card, separated by inset hairlines.
private struct PowersListCard<Row: View>: View {
    let powers: [UserPower]
    @ViewBuilder let row: (UserPower) -> Row

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(powers.enumerated()), id: \.element.id) { index, power in
                if index > 0 {
                    HairlineDivider()
                        .padding(.leading, 48)
                }
                row(power)
            }
        }
        .background(Color.surface, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
        .hairlineBorder(radius: DS.Radius.card)
    }
}

/// Power glyph: the power type's SF Symbol (the API emoji stays out of our chrome).
private struct PowerGlyph: View {
    let power: UserPower
    var tint: Color = .primary

    var body: some View {
        Image(systemName: PowerSymbol.name(power.powerType))
            .font(.system(size: 18, weight: .regular))
            .foregroundStyle(tint)
            .frame(width: 24, height: 24)
            .accessibilityHidden(true)
    }
}

/// Flat card for a power ready to use: symbol, rarity, name, description and a bordered "Activar".
private struct PowerCard: View {
    let power: UserPower
    let isActivating: Bool
    let isDisabled: Bool
    let onActivate: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            HStack(alignment: .center) {
                PowerGlyph(power: power)
                Spacer(minLength: 4)
                RarityPill(rarity: power.rarity)
            }
            Text(power.name)
                .font(Font.cardTitle)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .padding(.top, DS.Spacing.xs)
            Text(power.definition?.description ?? "")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3, reservesSpace: true)
            activateButton
                .padding(.top, DS.Spacing.xs)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 14)
    }

    private var activateButton: some View {
        Button(action: onActivate) {
            HStack(spacing: 6) {
                if isActivating {
                    ProgressView()
                        .controlSize(.small)
                }
                Text(isActivating ? "Activando…" : "Activar")
                    .font(.subheadline.weight(.semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 28)
        }
        .buttonStyle(.bordered)
        .tint(Color.brand)
        .disabled(isDisabled)
        .sensoryFeedback(.impact(weight: .medium), trigger: isActivating)
        .accessibilityLabel("Activar \(power.name)")
    }
}

/// Row for a power that is working right now, with a live countdown.
private struct PowerActiveRow: View {
    let power: UserPower

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            PowerGlyph(power: power, tint: Color.brand)
            VStack(alignment: .leading, spacing: 2) {
                Text(power.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(power.activeLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: DS.Spacing.s)
            timer
        }
        .padding(.horizontal, DS.Spacing.m)
        .padding(.vertical, DS.Spacing.m)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var timer: some View {
        if let expires = power.expiresDate, expires > Date() {
            VStack(alignment: .trailing, spacing: 2) {
                Text(timerInterval: Date.countdownRange(to: expires), countsDown: true)
                    .font(Font.stat(19, weight: .semibold))
                    .monospacedDigit()
                    .multilineTextAlignment(.trailing)
                    .frame(minWidth: 70, alignment: .trailing)
                Text("Restante")
                    .statLabelStyle()
            }
        } else {
            Text("Activo")
                .font(Font.statLabel)
                .textCase(.uppercase)
                .tracking(DS.Tracking.label)
                .foregroundStyle(Color.brand)
        }
    }
}

/// Quiet row for a used or expired power.
private struct PowerSpentRow: View {
    let power: UserPower

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            PowerGlyph(power: power, tint: Color.secondary)
            Text(power.name)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: DS.Spacing.s)
            Text(power.status == "expired" ? "Caducado" : "Usado")
                .font(Font.meta)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, DS.Spacing.m)
        .padding(.vertical, 11)
        .accessibilityElement(children: .combine)
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
                    Text("Elige a un participante y ponle un apodo público durante 48 h.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Section {
                    TextField("Apodo", text: $nickname)
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
                        Text(loadError).foregroundStyle(Color.steal)
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
                                    Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Color.brand)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                                            }
                }
            }
            .listBackground()
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Buscar por nombre o @usuario")
            .navigationTitle(power.name)
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
                            .fontWeight(.semibold)
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
                model.pendingResultMessage = "Apodo «\(trimmedNickname)» asignado a \(target) durante 48 h."
                dismiss()
            case .failure(let error):
                sendError = error.message
            }
        }
    }
}
