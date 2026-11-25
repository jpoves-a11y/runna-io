import SwiftUI
import MapKit
import CoreLocation

/// Territory won in a run: the conquered area as the hero number, then the people you took
/// territory from, each with a plain "Enviar foto" button.
struct ConquestCard: View {
    let result: ConquestResult
    /// Victims who already got a photo for this run.
    let sentVictimIds: Set<String>
    let onTaunt: (Victim) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.xxl) {
            if let validation = result.validation, validation.isRejected || validation.isFlagged {
                validationCard(validation)
            }
            if !result.isRejected {
                conqueredHero
                if let competition = result.competition {
                    competitionCard(competition)
                } else if let note = competitionNoteText {
                    competitionNote(note)
                }
                if !result.challengesCompleted.isEmpty {
                    challengesCard
                }
            }
            let victims: [Victim] = result.stolenVictims
            if !victims.isEmpty {
                stolenSection(victims)
            }
        }
    }

    /// Global map: the new area this run added (nobody can take it away).
    private var conqueredHero: some View {
        let parts = Format.areaParts(result.globalGained + result.globalBonus)
        let gained: Double = result.globalGained + result.globalBonus
        return VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Text("Mapa global")
                .statLabelStyle()
            StatValue(
                value: gained > 0 ? "+\(parts.value)" : parts.value,
                unit: parts.unit,
                font: Font.stat(56, weight: .semibold),
                tint: gained > 0 ? Color.brand : Color.primary
            )
            if result.globalBonus > 0 {
                Text(boostsText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if gained <= 0 {
                Text("Ya habías corrido por aquí: esta carrera no suma área nueva al mapa global.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let total = result.globalTotal, total > 0 {
                Text("Total: \(Format.area(total))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: DS.Spacing.xl)
        .accessibilityElement(children: .combine)
    }

    /// "Incluye 0,05 km² del Explorador y 0,02 km² del Alba."
    private var boostsText: String {
        let names = ["explorer": "del Explorador", "tourist": "del Turista", "dawn": "del Alba", "expedition": "de la Expedición"]
        let parts = result.globalBoosts
            .filter { $0.value > 0 }
            .sorted { $0.value > $1.value }
            .map { "\(Format.area($0.value)) \(names[$0.key] ?? "de tus poderes")" }
        if parts.isEmpty { return "Incluye \(Format.area(result.globalBonus)) de tus poderes." }
        if parts.count == 1 { return "Incluye \(parts[0])." }
        return "Incluye " + parts.dropLast().joined(separator: ", ") + " y " + (parts.last ?? "") + "."
    }

    /// Competition map: area won (and stolen) in the running club competition.
    private func competitionCard(_ competition: ConquestResult.CompetitionPart) -> some View {
        let parts = Format.areaParts(competition.mode == "explorers" ? competition.explored : competition.newArea)
        return VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Text(result.joinedCompetition ? "¡Ya compites! Competición de tu club" : "Competición de tu club")
                .statLabelStyle()
            switch competition.mode {
            case "flags":
                if competition.flags.isEmpty {
                    Text("No has pasado por ninguna bandera libre o rival.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(competition.flags, id: \.flagId) { flag in
                        Label(flag.from == nil ? "Has capturado la \(flag.name)" : "Has robado la \(flag.name)", systemImage: "flag.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.brand)
                    }
                }
            case "explorers":
                StatValue(value: "+\(parts.value)", unit: parts.unit, font: Font.stat(30, weight: .semibold))
                Text("Área nueva de tu mapa global: es lo que cuenta en Exploradores.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            default:
                HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.l) {
                    StatValue(value: "+\(parts.value)", unit: parts.unit, font: Font.stat(30, weight: .semibold))
                    if result.totalStolen > 0 {
                        stolenSummary
                    }
                }
                Text("Llevas \(Format.area(competition.totalArea)) en el mapa de competición.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        .accessibilityElement(children: .combine)
    }

    /// Why this run didn't count for my club's competition (it still counts for the global map).
    private var competitionNoteText: String? {
        switch result.competitionNote {
        case "after_close": return "Llegó después del cierre de la competición (el lunes a las 6:00): solo cuenta para el mapa global."
        case "closed_entry": return "La competición de tu club es por equipos y ya había empezado: entrarás en la próxima. Esta carrera cuenta para el mapa global."
        case "next_cycle": return "Entraste en el club después de las primeras 48 horas: compites desde la próxima competición."
        case "eliminated": return "Caíste en la Eliminación: esta carrera cuenta para tu mapa global."
        default: return nil
        }
    }

    private func competitionNote(_ text: String) -> some View {
        HStack(alignment: .top, spacing: DS.Spacing.m) {
            Image(systemName: "info.circle")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .card()
    }

    private var challengesCard: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: result.challengesCompleted.count == 1 ? "Reto completado" : "Retos completados")
            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                ForEach(result.challengesCompleted) { challenge in
                    HStack(spacing: DS.Spacing.m) {
                        Image(systemName: "checkmark.seal")
                            .foregroundStyle(Color.brand)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(challenge.title)
                                .font(.subheadline.weight(.semibold))
                            if let reward = challenge.rewardName {
                                Text("Recompensa: \(reward)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
        }
    }

    /// The anti-cheat refused the run, or sent it to review.
    private func validationCard(_ validation: RunValidation) -> some View {
        HStack(alignment: .top, spacing: DS.Spacing.m) {
            Image(systemName: validation.isRejected ? "xmark.octagon" : "exclamationmark.triangle")
                .font(.title3)
                .foregroundStyle(validation.isRejected ? Color.steal : Color.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text(validation.isRejected ? "Esta carrera no cuenta" : "Carrera en revisión")
                    .font(.headline)
                Text(validation.message ?? (validation.isRejected
                    ? "No cumple las reglas de juego limpio."
                    : "Cuenta, pero la revisaremos."))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        .accessibilityElement(children: .combine)
    }

    private var stolenSummary: some View {
        HStack(spacing: 4) {
            Text("Robado:")
                .foregroundStyle(.secondary)
            Text(Format.area(result.totalStolen))
                .foregroundStyle(Color.steal)
                .fontWeight(.semibold)
                .monospacedDigit()
        }
        .font(.subheadline)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }

    private func stolenSection(_ victims: [Victim]) -> some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: victims.count == 1 ? "Territorio robado a" : "Territorio robado a \(victims.count) corredores")
            VStack(spacing: 0) {
                ForEach(Array(victims.enumerated()), id: \.element.id) { index, victim in
                    if index > 0 {
                        HairlineDivider()
                            .padding(.leading, 64)
                    }
                    ConquestVictimRow(victim: victim, sent: sentVictimIds.contains(victim.userId)) {
                        onTaunt(victim)
                    }
                }
            }
            .card(padding: 0)
        }
    }
}

/// One victim: avatar, name, area taken (coral text) and the photo action.
private struct ConquestVictimRow: View {
    let victim: Victim
    let sent: Bool
    let onTaunt: () -> Void

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            AvatarView(name: victim.userName, avatar: nil, color: victim.userColor, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(victim.userName)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Text("−\(Format.area(victim.stolenArea))")
                    .font(.subheadline.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(Color.steal)
            }
            Spacer(minLength: DS.Spacing.s)
            actionView
        }
        .padding(.horizontal, DS.Spacing.l)
        .padding(.vertical, DS.Spacing.m)
        .animation(.snappy, value: sent)
    }

    @ViewBuilder
    private var actionView: some View {
        if sent {
            Label("Enviada", systemImage: "checkmark")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .transition(.opacity)
        } else {
            Button("Enviar foto", action: onTaunt)
                .buttonStyle(SecondaryButtonStyle(tint: Color.primary))
                .accessibilityLabel("Enviar foto a \(victim.userName)")
        }
    }
}

// MARK: - Report pieces (shared by the run summary and the conquest inbox)

/// Editorial header of a report: large title and a secondary line (with a small spinner while working).
/// `systemImage` is kept for API compatibility and not drawn.
struct RunCelebrationHeader: View {
    let title: String
    let subtitle: String
    var systemImage: String = "flag.checkered"
    var isWorking: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Text(title)
                .font(Font.screenTitle)
                .tracking(DS.Tracking.title)
                .fixedSize(horizontal: false, vertical: true)
                .contentTransition(.opacity)
            HStack(spacing: DS.Spacing.s) {
                if isWorking {
                    ProgressView()
                        .controlSize(.small)
                }
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .contentTransition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Distance · time · pace in one flat card, separated by hairlines.
struct RunStatsCard: View {
    let distance: Double
    let duration: Int

    var body: some View {
        let distanceParts: (String, String?) = Self.split(Format.distance(distance))
        let paceParts: (String, String?) = Self.split(Format.pace(distanceMeters: distance, seconds: duration))
        return HStack(spacing: 0) {
            StatTile(value: distanceParts.0, label: "Distancia", unit: distanceParts.1)
            StatDivider(height: 40)
            StatTile(value: Format.duration(duration), label: "Tiempo")
            StatDivider(height: 40)
            StatTile(value: paceParts.0, label: "Ritmo", unit: paceParts.1)
        }
        .card(padding: DS.Spacing.l)
    }

    /// "5,23 km" → ("5,23", "km").
    private static func split(_ text: String) -> (String, String?) {
        guard let space = text.firstIndex(of: " ") else { return (text, nil) }
        let value = String(text[..<space])
        let unit = String(text[text.index(after: space)...])
        return (value, unit.isEmpty ? nil : unit)
    }
}

/// Card with a spinner (or quiet icon) and a short status message.
struct RunStatusCard: View {
    let systemImage: String
    let title: String
    let message: String
    var tint: Color = Color.brand
    var isLoading: Bool = false

    /// Coral stays for problems; anything else is a neutral icon.
    private var iconColor: Color { tint == Color.steal ? Color.steal : Color.secondary }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.m) {
            Group {
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: systemImage)
                        .font(.body)
                        .foregroundStyle(iconColor)
                }
            }
            .frame(width: 22)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(Font.cardTitle)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

/// One treasure in a run summary.
struct TreasureLine: Identifiable, Hashable {
    let id: String
    let emoji: String
    let name: String
    let rarity: String
    /// The power inside (art in the asset catalog: power_<itemId>)
    var itemId: String? = nil
    var detail: String? = nil
    /// A chest whose power is revealed with the opening animation (until it has been opened here)
    var sealed = false

    /// Live-collected treasures plus the ones the server collected along the route, without duplicates.
    static func merge(live: [Treasure], server: [CollectedTreasure]) -> [TreasureLine] {
        var lines: [TreasureLine] = []
        var seen: Set<String> = []
        for treasure in live where !seen.contains(treasure.id) {
            seen.insert(treasure.id)
            lines.append(TreasureLine(
                id: treasure.id,
                emoji: treasure.emoji ?? "🎁",
                name: treasure.powerName ?? treasure.name,
                rarity: treasure.rarity
            ))
        }
        for treasure in server where !seen.contains(treasure.treasureId) {
            seen.insert(treasure.treasureId)
            lines.append(TreasureLine(
                id: treasure.treasureId,
                emoji: treasure.powerEmoji ?? "🎁",
                name: treasure.powerName ?? treasure.treasureName,
                rarity: treasure.rarity,
                itemId: treasure.powerType,
                detail: treasure.powerDescription,
                // Servers that tell what was inside: the chest opens in 3D before showing it
                sealed: treasure.powerName != nil && treasure.powerType != nil
            ))
        }
        return lines
    }

    static func rarityName(_ rarity: String) -> String {
        switch rarity.lowercased() {
        case "common": return "Común"
        case "rare": return "Raro"
        case "epic": return "Épico"
        case "legendary": return "Legendario"
        default: return rarity.capitalized
        }
    }

    static func rarityColor(_ rarity: String) -> Color {
        switch rarity.lowercased() {
        case "rare": return Color.sky
        case "epic": return Color.grape
        case "legendary": return Color.gold
        default: return Color.secondary
        }
    }
}

/// Chests opened in a run. Each one stays closed ("Toca para abrirlo") until it's tapped: then it
/// opens in 3D and the power inside appears. Once opened on this iPhone, the row shows the power.
struct TreasuresCard: View {
    let treasures: [TreasureLine]

    @State private var opening: TreasureLine?
    /// Opened in this view (RevealedChests remembers them across launches)
    @State private var openedNow: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: treasures.count == 1 ? "Cofre abierto" : "\(treasures.count) cofres abiertos")
            VStack(spacing: 0) {
                ForEach(Array(treasures.enumerated()), id: \.element.id) { index, treasure in
                    if index > 0 {
                        HairlineDivider()
                            .padding(.leading, 60)
                    }
                    if isClosed(treasure) {
                        closedRow(treasure)
                    } else {
                        row(treasure)
                    }
                }
            }
            .card(padding: 0)
        }
        .onAppear {
            if treasures.contains(where: isClosed) { ChestOpening3DView.prewarm() }
        }
        .fullScreenCover(item: $opening) { treasure in
            ChestRevealOverlay(
                content: ChestContent(itemId: treasure.itemId ?? "", name: treasure.name, rarity: treasure.rarity, detail: treasure.detail),
                buttonTitle: "Genial"
            ) {
                RevealedChests.insert(treasure.id)
                openedNow.insert(treasure.id)
                opening = nil
            }
            .presentationBackground(.black)
        }
    }

    private func isClosed(_ treasure: TreasureLine) -> Bool {
        treasure.sealed && !openedNow.contains(treasure.id) && !RevealedChests.contains(treasure.id)
    }

    private func closedRow(_ treasure: TreasureLine) -> some View {
        Button {
            Haptics.tap()
            opening = treasure
        } label: {
            HStack(spacing: DS.Spacing.m) {
                ChestView(rarity: treasure.rarity, size: 36)
                    .frame(width: 36)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Cofre \(TreasureLine.rarityName(treasure.rarity).lowercased())")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Toca para abrirlo")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: DS.Spacing.s)
                Image(systemName: "sparkles")
                    .foregroundStyle(TreasureLine.rarityColor(treasure.rarity))
            }
            .padding(.horizontal, DS.Spacing.l)
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityLabel("Cofre \(TreasureLine.rarityName(treasure.rarity).lowercased()). Toca para abrirlo")
    }

    private func row(_ treasure: TreasureLine) -> some View {
        HStack(spacing: DS.Spacing.m) {
            Group {
                if let itemId = treasure.itemId, UIImage(named: "power_\(itemId)") != nil {
                    PowerArt(itemId: itemId, rarity: treasure.rarity, size: 36, glow: false)
                } else {
                    Text(treasure.emoji)
                        .font(.title3)
                }
            }
            .frame(width: 36)
            .accessibilityHidden(true)
            Text(treasure.name)
                .font(.body)
                .lineLimit(2)
            Spacer(minLength: DS.Spacing.s)
            Text(TreasureLine.rarityName(treasure.rarity))
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, DS.Spacing.l)
        .frame(minHeight: 56)
        .accessibilityElement(children: .combine)
    }
}
