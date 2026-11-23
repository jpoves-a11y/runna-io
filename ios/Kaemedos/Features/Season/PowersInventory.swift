import SwiftUI

/// Poderes: the powers working now, the ones ready to use (same power grouped, ×2) and cosmetics.
/// Each power is its 3D artwork, its name and where it counts (an icon you can tap); the description
/// and the details are one tap away (the power's card), and the rules are behind the ⓘ by the title.
struct InventorySheet: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var model = InventoryModel()
    @State private var season = SeasonStore.shared
    @State private var detail: PowerStack?
    @State private var targetItem: InventoryItem?
    @State private var busyId: String?
    @State private var message: String?
    @State private var spiedRoute: RunRoute?
    @State private var showRadar = false
    @State private var showRules = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: DS.Spacing.xxl) {
                    if !model.active.isEmpty { activeSection }
                    availableSection
                    if !model.cosmetics.isEmpty { cosmeticsSection }
                }
                .padding(.horizontal, DS.Spacing.screen)
                .padding(.vertical, DS.Spacing.l)
            }
            .screenBackground()
            .overlay {
                if model.isLoading { ProgressView() }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) { titleWithInfo }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .task { await model.load() }
            .refreshable { await model.load() }
            .sheet(item: $detail) { stack in
                PowerDetailSheet(
                    stack: stack,
                    usability: usability(stack.first),
                    isBusy: busyId != nil
                ) {
                    detail = nil
                    // After this sheet has gone (Espía and co. open the rival picker)
                    let item = stack.first
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { use(item) }
                }
            }
            .sheet(item: $targetItem) { item in
                TargetPickerSheet(item: item, rivals: rivals) { targetId, nickname in
                    Task { await activate(item, targetUserId: targetId, nickname: nickname) }
                }
            }
            .sheet(item: $spiedRoute) { route in
                SpyRouteSheet(route: route)
            }
            .sheet(isPresented: $showRadar) {
                RadarSheet()
            }
            .alert("Poderes", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(message ?? "")
            }
            .errorAlert($errorMessage)
        }
    }

    // MARK: Title and rules

    private var titleWithInfo: some View {
        HStack(spacing: 6) {
            Text("Poderes")
                .font(.headline)
            Button {
                showRules = true
            } label: {
                Image(systemName: "info.circle")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .accessibilityLabel("Cómo funcionan los poderes")
            .popover(isPresented: $showRules) {
                rules
                    .presentationCompactAdaptation(.popover)
            }
        }
    }

    private var rules: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Label("**Competición**: solo cuentan en la competición de tu club.", systemImage: "flag.2.crossed.fill")
            Label("**Global**: extras para tu mapa global, como mucho 1 km² más por carrera.", systemImage: "globe.europe.africa.fill")
            Label("**Descanso**: para los cofres de los días de descanso. Duran dos semanas.", systemImage: "gift.fill")
            Label("Si no los usas, los de defensa caducan a los 3 días y el resto a los 7. Puedes tener \(model.cap) de cada.", systemImage: "hourglass")
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(DS.Spacing.l)
        .frame(width: 320, alignment: .leading)
    }

    // MARK: Active

    private var activeSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            SectionLabel("Activos")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: DS.Spacing.m) {
                    ForEach(model.active) { item in
                        Button {
                            if item.itemId == "radar" { showRadar = true } else { detail = PowerStack(items: [item]) }
                        } label: {
                            ActivePowerCard(item: item)
                        }
                        .buttonStyle(.pressable)
                    }
                }
                .padding(.vertical, 2)
            }
            .scrollClipDisabled()
        }
    }

    // MARK: Ready to use

    private var stacks: [PowerStack] {
        var order: [String] = []
        var groups: [String: [InventoryItem]] = [:]
        for item in model.available {
            if groups[item.itemId] == nil { order.append(item.itemId) }
            groups[item.itemId, default: []].append(item)
        }
        return order.map { PowerStack(items: groups[$0] ?? []) }
    }

    @ViewBuilder
    private var availableSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            SectionLabel("Para usar")
            if stacks.isEmpty && !model.isLoading {
                emptyState
            }
            ForEach(stacks) { stack in
                PowerRow(
                    stack: stack,
                    usability: usability(stack.first),
                    isBusy: busyId == stack.first.id,
                    onOpen: { detail = stack },
                    onUse: { use(stack.first) }
                )
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: DS.Spacing.m) {
            ChestView(rarity: "epic", size: 72)
                .frame(height: 96)
            Text("Aún no tienes poderes")
                .font(.headline)
            Text("Salen de los cofres, los retos y las recompensas de cada competición.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, DS.Spacing.xl)
        .card()
    }

    // MARK: Cosmetics

    private var cosmeticsSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            SectionLabel("Cosméticos")
            VStack(spacing: 0) {
                ForEach(Array(model.cosmetics.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { HairlineDivider() }
                    cosmeticRow(item)
                        .padding(.vertical, DS.Spacing.s)
                }
            }
            .card(padding: DS.Spacing.m)
        }
    }

    private func cosmeticRow(_ item: InventoryItem) -> some View {
        HStack(spacing: DS.Spacing.m) {
            PowerArt(itemId: item.itemId, rarity: item.rarity, size: 36, glow: false)
            Text(item.name.replacingOccurrences(of: "Título: ", with: "").replacingOccurrences(of: "Escudo: ", with: ""))
                .font(.body.weight(.semibold))
            PowerScopeBadge(scope: "cosmetic", size: 22)
            Spacer()
            if item.itemId.hasPrefix("title_") {
                if model.equippedTitle == item.itemId {
                    Button("Quitar") { equip(nil) }
                        .buttonStyle(SecondaryButtonStyle(tint: .secondary))
                } else {
                    Button("Llevar") { equip(item.itemId) }
                        .buttonStyle(SecondaryButtonStyle(tint: .brand))
                }
            }
        }
    }

    // MARK: Using

    /// nil: it can be used now; otherwise why not (shown on its card).
    private func usability(_ item: InventoryItem) -> String? {
        guard let definition = item.definition else { return "No disponible" }
        if definition.activation == "passive" { return "Se usa solo" }
        switch definition.usablePhase {
        case "competition":
            return season.isCompeting ? nil : "Solo durante la competición de tu club"
        case "rest":
            return season.cycle?.isRest == true && season.club != nil ? nil : "Solo en los días de descanso"
        default:
            return nil
        }
    }

    /// Rivals of my competition for target items.
    private var rivals: [GameUser] {
        guard let competition = season.competition else { return [] }
        if competition.mode == "duel" || competition.mode == "derby" {
            return competition.duel?.opponentStandings.compactMap(\.user) ?? []
        }
        if competition.mode == "target" || competition.mode == "explorers" { return [] }
        let me = session.userId
        return competition.standings.compactMap { standing -> GameUser? in
            guard standing.userId != me, let user = standing.user else { return nil }
            if competition.mode == "teams", standing.team == competition.myTeam { return nil }
            if competition.mode == "elimination", standing.eliminatedCut != nil { return nil }
            return user
        }
    }

    private func use(_ item: InventoryItem) {
        guard usability(item) == nil, busyId == nil else { return }
        if item.definition?.needsTarget == true {
            targetItem = item
        } else {
            Task { await activate(item, targetUserId: nil, nickname: nil) }
        }
    }

    private func activate(_ item: InventoryItem, targetUserId: String?, nickname: String?) async {
        busyId = item.id
        defer { busyId = nil }
        do {
            let response = try await model.activate(item, targetUserId: targetUserId, nickname: nickname)
            Haptics.success()
            if let route = response.route {
                spiedRoute = route
            } else if item.itemId == "radar" {
                showRadar = true
            } else {
                message = response.message ?? "\(item.name) activado."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func equip(_ itemId: String?) {
        Task {
            do {
                try await model.equipTitle(itemId)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

/// The copies of one power waiting to be used (the one that expires first goes first).
struct PowerStack: Identifiable {
    let items: [InventoryItem]

    var id: String { items.first?.itemId ?? "" }
    var first: InventoryItem {
        items.min { ($0.expiresDate ?? .distantFuture) < ($1.expiresDate ?? .distantFuture) } ?? items[0]
    }
    var count: Int { items.count }
}

// MARK: - Row

private struct PowerRow: View {
    let stack: PowerStack
    let usability: String?
    let isBusy: Bool
    let onOpen: () -> Void
    let onUse: () -> Void

    private var item: InventoryItem { stack.first }

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            Button(action: onOpen) {
                HStack(spacing: DS.Spacing.m) {
                    PowerArt(itemId: item.itemId, rarity: item.rarity, size: 64)
                        .overlay(alignment: .bottomTrailing) {
                            if stack.count > 1 {
                                Text("×\(stack.count)")
                                    .font(.caption.weight(.bold))
                                    .monospacedDigit()
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color(uiColor: .label), in: Capsule())
                                    .foregroundStyle(Color(uiColor: .systemBackground))
                                    .offset(x: 6, y: 4)
                            }
                        }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.name)
                            .font(.title3.weight(.bold))
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                            .minimumScaleFactor(0.85)
                        HStack(spacing: 8) {
                            RarityPill(rarity: item.rarity)
                            if let expires = item.expiresDate {
                                Label(SeasonStore.remaining(max(60, expires.timeIntervalSinceNow)), systemImage: "hourglass")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .labelStyle(.titleAndIcon)
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            PowerScopeBadge(scope: item.definition?.scope ?? item.scope)
            useButton
        }
        .padding(DS.Spacing.m)
        .background(
            LinearGradient(
                colors: [PowerArt.glowColor(item.rarity).opacity(0.14), Color.surface],
                startPoint: .leading, endPoint: .trailing
            ),
            in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous)
                .strokeBorder(PowerArt.glowColor(item.rarity).opacity(0.25), lineWidth: 1)
        )
    }

    @ViewBuilder
    private var useButton: some View {
        if item.definition?.activation == "passive" {
            Image(systemName: "checkmark.seal.fill")
                .font(.title3)
                .foregroundStyle(Color.brand)
                .accessibilityLabel("Se usa solo")
        } else {
            Button(action: onUse) {
                Group {
                    if isBusy {
                        ProgressView().tint(Color.onBrand)
                    } else {
                        Text("Usar")
                    }
                }
                .font(.subheadline.weight(.bold))
                .foregroundStyle(Color.onBrand)
                .frame(width: 64, height: 36)
                .background(Color.brand, in: Capsule())
                .opacity(usability == nil ? 1 : 0.35)
            }
            .buttonStyle(.pressable)
            .disabled(usability != nil || isBusy)
            .accessibilityHint(usability ?? "")
        }
    }
}

// MARK: - Active

private struct ActivePowerCard: View {
    let item: InventoryItem

    @State private var pulse = false

    private var status: String {
        if let until = item.activeUntilDate { return SeasonStore.remaining(until.timeIntervalSinceNow) }
        return item.itemId == "double_loot" ? "Próximo cofre" : "Próxima carrera"
    }

    var body: some View {
        VStack(spacing: DS.Spacing.s) {
            PowerArt(itemId: item.itemId, rarity: item.rarity, size: 58)
                .scaleEffect(pulse ? 1.04 : 0.98)
                .animation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true), value: pulse)
            Text(item.name)
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
            Label(status, systemImage: item.activeUntilDate == nil ? "figure.run" : "timer")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Color.brand)
                .lineLimit(1)
        }
        .frame(width: 118)
        .padding(.vertical, DS.Spacing.m)
        .background(Color.surface, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous)
                .strokeBorder(Color.brand.opacity(0.5), lineWidth: 1.5)
        )
        .onAppear { pulse = true }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Detail

/// A power's card: big artwork, name, where it counts, what it does and the button.
private struct PowerDetailSheet: View {
    let stack: PowerStack
    let usability: String?
    let isBusy: Bool
    let onUse: () -> Void

    private var item: InventoryItem { stack.first }

    private var timing: String? {
        guard let definition = item.definition else { return nil }
        switch definition.activation {
        case "next_run": return "Se aplica en tu siguiente carrera"
        case "timed": return definition.activeHours.map { "Dura \(Int($0)) h desde que lo actives" }
        case "instant": return "Efecto inmediato"
        case "target": return "Eliges a un rival"
        case "passive": return "Se usa solo cuando hace falta"
        default: return nil
        }
    }

    var body: some View {
        VStack(spacing: DS.Spacing.l) {
            PowerArt(itemId: item.itemId, rarity: item.rarity, size: 150)
                .padding(.top, DS.Spacing.xl)
            VStack(spacing: DS.Spacing.s) {
                Text(item.name)
                    .font(.title.weight(.bold))
                    .multilineTextAlignment(.center)
                HStack(spacing: DS.Spacing.s) {
                    RarityPill(rarity: item.rarity)
                    PowerScopeBadge(scope: item.definition?.scope ?? item.scope, size: 24)
                    if stack.count > 1 {
                        Text("Tienes \(stack.count)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if let description = item.definition?.description {
                Text(description)
                    .font(.body)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: DS.Spacing.l) {
                if let timing {
                    Label(timing, systemImage: "bolt.fill")
                }
                if let expires = item.expiresDate, !item.isActive {
                    Label("Caduca en \(SeasonStore.remaining(max(60, expires.timeIntervalSinceNow)))", systemImage: "hourglass")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if item.isAvailable, item.definition?.activation != "passive" {
                Button(action: onUse) {
                    Text(usability ?? "Usar ahora")
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(usability != nil || isBusy)
            }
        }
        .padding(.horizontal, DS.Spacing.xl)
        .padding(.bottom, DS.Spacing.l)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
