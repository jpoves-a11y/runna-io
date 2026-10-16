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

/// "Poderes": powers won from treasures as a collectible card grid — active, ready to use and spent.
struct PowersSheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var model = PowersModel()
    @State private var nicknamePower: UserPower?

    private let gridColumns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]
    private let spentColumns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]

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
                "¡Poder activado!",
                isPresented: Binding(get: { model.resultMessage != nil }, set: { if !$0 { model.resultMessage = nil } }),
                actions: { Button("¡Vamos!", role: .cancel) {} },
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
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            SectionHeader(title: "En marcha", subtitle: "Tus poderes están trabajando ahora mismo", systemImage: "bolt.circle.fill")
            ForEach(model.active) { power in
                PowerActiveCard(power: power)
            }
        }
    }

    private var availableSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            SectionHeader(title: "Listos para usar", subtitle: "Elige bien el momento", systemImage: "sparkles")
            LazyVGrid(columns: gridColumns, spacing: 12) {
                ForEach(model.available) { power in
                    PowerCollectibleCard(
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
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            SectionHeader(title: "Ya usados", systemImage: "clock.arrow.circlepath")
            LazyVGrid(columns: spentColumns, spacing: 10) {
                ForEach(model.spent) { power in
                    PowerSpentTile(power: power)
                }
            }
        }
    }

    @ViewBuilder
    private var stateOverlay: some View {
        if model.powers.isEmpty {
            if model.isLoading || !model.loaded {
                ProgressView()
                    .controlSize(.large)
            } else if let message = model.errorMessage {
                ErrorView(message: message) { Task { await reload() } }
            } else {
                EmptyStateView(
                    systemImage: "shippingbox.fill",
                    title: "Tu cofre está vacío",
                    message: "Pasa corriendo junto a los tesoros del mapa y llénalo de poderes.",
                    tint: Color.gold
                )
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            if !model.available.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "bolt.fill")
                    Text("\(model.available.count) disponible\(model.available.count == 1 ? "" : "s")")
                        .contentTransition(.numericText())
                }
                .font(.system(.caption, design: .rounded, weight: .heavy))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(LinearGradient.goldGradient, in: Capsule())
                .foregroundStyle(.white)
            }
        }
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
                model.resultMessage = "\(power.emoji) \(power.name): \(message)"
            case .failure(let error):
                model.errorMessage = error.message
            }
        }
    }
}

// MARK: - Summary

/// "3 listos · 1 activo · 4 usados"
private struct PowersSummaryStrip: View {
    let available: Int
    let active: Int
    let spent: Int

    var body: some View {
        HStack(spacing: 0) {
            stat(value: available, label: available == 1 ? "listo" : "listos", tint: Color.gold, systemImage: "bolt.fill")
            divider
            stat(value: active, label: active == 1 ? "activo" : "activos", tint: Color.brand, systemImage: "flame.fill")
            divider
            stat(value: spent, label: spent == 1 ? "usado" : "usados", tint: Color.secondary, systemImage: "checkmark.seal.fill")
        }
        .card(padding: 14)
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.hairline)
            .frame(width: 1, height: 36)
    }

    private func stat(value: Int, label: String, tint: Color, systemImage: String) -> some View {
        VStack(spacing: 3) {
            HStack(spacing: 4) {
                Image(systemName: systemImage)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(tint)
                Text("\(value)")
                    .font(Font.statNumber)
                    .monospacedDigit()
                    .contentTransition(.numericText())
            }
            Text(label)
                .statLabelStyle()
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Cards

/// Collectible card for a power ready to use: rarity art, name, description and "Activar".
private struct PowerCollectibleCard: View {
    let power: UserPower
    let isActivating: Bool
    let isDisabled: Bool
    let onActivate: () -> Void

    @State private var glowing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var tint: Color { Rarity.color(power.rarity) }
    private var isLegendary: Bool { power.rarity == "legendary" }
    private var isShiny: Bool { power.rarity == "legendary" || power.rarity == "epic" }
    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: 20, style: .continuous) }

    var body: some View {
        VStack(spacing: 0) {
            PowerCardArt(power: power, height: 112, sparkles: isShiny)
            info
        }
        .background(Color.surface)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Rarity.gradient(power.rarity), lineWidth: isLegendary ? 2.5 : 1.5))
        .shadow(color: tint.opacity(glowShadowOpacity), radius: isLegendary ? 18 : 10, x: 0, y: 5)
        .onAppear {
            guard isLegendary, !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) {
                glowing = true
            }
        }
    }

    private var glowShadowOpacity: Double {
        if isLegendary { return glowing ? 0.7 : 0.3 }
        return 0.18
    }

    private var info: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(power.name)
                .font(Font.cardTitle)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            Text(power.definition?.description ?? "")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3, reservesSpace: true)
            activateButton
                .padding(.top, 4)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var activateButton: some View {
        Button(action: onActivate) {
            HStack(spacing: 6) {
                if isActivating {
                    ProgressView()
                        .tint(Color.white)
                        .controlSize(.small)
                } else {
                    Image(systemName: "bolt.fill")
                }
                Text(isActivating ? "Activando…" : "Activar")
            }
            .font(.system(.subheadline, design: .rounded, weight: .heavy))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 38)
            .background(Rarity.gradient(power.rarity), in: Capsule())
            .shadow(color: tint.opacity(0.35), radius: 6, x: 0, y: 3)
        }
        .buttonStyle(.pressable)
        .disabled(isDisabled)
        .opacity(isDisabled && !isActivating ? 0.5 : 1)
        .sensoryFeedback(.impact(weight: .medium), trigger: isActivating)
        .accessibilityLabel("Activar \(power.name)")
    }
}

/// Top half of a power card: rarity gradient, glow and the big emoji.
private struct PowerCardArt: View {
    let power: UserPower
    let height: CGFloat
    let sparkles: Bool

    var body: some View {
        ZStack {
            Rectangle().fill(Rarity.gradient(power.rarity))
            RadialGradient(colors: [Color.white.opacity(0.5), Color.white.opacity(0)], center: .center, startRadius: 2, endRadius: 64)
            if sparkles {
                Image(systemName: "sparkles")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(Color.white.opacity(0.75))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(10)
                Image(systemName: "sparkle")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Color.white.opacity(0.6))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(12)
            }
            Text(power.emoji)
                .font(.system(size: 52))
                .shadow(color: Color.black.opacity(0.25), radius: 6, x: 0, y: 4)
        }
        .frame(height: height)
        .overlay(alignment: .topTrailing) {
            Text(Rarity.label(power.rarity))
                .font(.system(size: 10, weight: .heavy, design: .rounded))
                .textCase(.uppercase)
                .tracking(0.6)
                .foregroundStyle(Rarity.color(power.rarity))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Color.white, in: Capsule())
                .padding(8)
        }
        .accessibilityHidden(true)
    }
}

/// Wide card for a power that is working right now, with a live countdown.
private struct PowerActiveCard: View {
    let power: UserPower

    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var tint: Color { Rarity.color(power.rarity) }

    var body: some View {
        HStack(spacing: 14) {
            Text(power.emoji)
                .font(.system(size: 32))
                .frame(width: 60, height: 60)
                .background(Rarity.gradient(power.rarity), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .shadow(color: tint.opacity(0.4), radius: 8, x: 0, y: 4)
            VStack(alignment: .leading, spacing: 4) {
                liveBadge
                Text(power.name)
                    .font(Font.cardTitle)
                    .lineLimit(1)
                Text(power.activeLabel)
                    .font(.system(.footnote, design: .rounded, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 4)
            timer
        }
        .padding(14)
        .background {
            RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous)
                .fill(tint.opacity(0.10))
                .background(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous).fill(Color.surface))
        }
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous).strokeBorder(tint.opacity(0.45), lineWidth: 1.5))
        .accessibilityElement(children: .combine)
    }

    private var liveBadge: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(Color.brand)
                .frame(width: 7, height: 7)
                .scaleEffect(pulse ? 1.3 : 0.8)
                .opacity(pulse ? 1 : 0.6)
            Text("Activo")
                .font(.system(size: 10, weight: .heavy, design: .rounded))
                .textCase(.uppercase)
                .tracking(0.6)
                .foregroundStyle(Color.brand)
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }

    @ViewBuilder
    private var timer: some View {
        if let expires = power.expiresDate, expires > Date() {
            VStack(alignment: .trailing, spacing: 2) {
                Text(timerInterval: Date.countdownRange(to: expires), countsDown: true)
                    .font(Font.stat(18, weight: .heavy))
                    .monospacedDigit()
                    .multilineTextAlignment(.trailing)
                    .frame(minWidth: 70, alignment: .trailing)
                Text("restante")
                    .statLabelStyle()
            }
        } else {
            Image(systemName: "checkmark.seal.fill")
                .font(.title2)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(Color.brand)
        }
    }
}

/// Small faded tile for a used or expired power.
private struct PowerSpentTile: View {
    let power: UserPower

    var body: some View {
        VStack(spacing: 6) {
            Text(power.emoji)
                .font(.system(size: 28))
                .grayscale(1)
            Text(power.name)
                .font(.system(.caption, design: .rounded, weight: .bold))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            Text(power.status == "expired" ? "Caducado" : "Usado")
                .font(.system(size: 10, weight: .heavy, design: .rounded))
                .textCase(.uppercase)
                .tracking(0.5)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .padding(.horizontal, 6)
        .background(Color.surface, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous).strokeBorder(Color.hairline, lineWidth: 1))
        .opacity(0.65)
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
            .listBackground()
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
                            .fontWeight(.bold)
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
