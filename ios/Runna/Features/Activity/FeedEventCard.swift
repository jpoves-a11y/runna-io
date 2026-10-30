import SwiftUI

/// One event of the friends feed: author row, headline, edge-to-edge route map, stats row,
/// achievements, quiet reactions and the first comments.
struct FeedEventCard: View {
    let event: FeedEvent
    let currentUserId: String?
    let previewComments: [FeedComment]
    let people: [MentionCandidate]
    let isReacting: Bool
    let onReact: (String) -> Void
    let onComments: () -> Void
    let onOpenUser: (String) -> Void
    let onReport: () -> Void

    private static let systemUsername = "_runna_system"

    /// Treasure spawns are posted by the server's system user, which has no real profile.
    private var isSystemEvent: Bool {
        event.eventType == "treasure_spawned" || event.user.username == Self.systemUsername
    }

    private var isMine: Bool { event.userId == currentUserId }
    private var kind: ActivityEventKind { ActivityEventKind(event.eventType) }
    private var userColor: Color { Color(hex: event.user.color) }
    private var hasRoute: Bool { event.routeCoordinates.count >= 2 }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            topSection
                .padding(.horizontal, DS.Spacing.l)
                .padding(.top, DS.Spacing.l)
                .padding(.bottom, hasRoute ? DS.Spacing.m : 0)
            if hasRoute {
                routeHero
            }
            bottomSection
                .padding(.horizontal, DS.Spacing.l)
                .padding(.top, DS.Spacing.m)
                .padding(.bottom, DS.Spacing.s)
        }
        .activityCard(padding: 0)
    }

    private var topSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            header
            headlineView
            typeSpecificContent
        }
    }

    private var bottomSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            if !stats.isEmpty {
                ActivityStatsStrip(stats: stats)
            }
            FeedEventEmblems(event: event, currentUserId: currentUserId, onOpenUser: onOpenUser)
            VStack(alignment: .leading, spacing: 0) {
                HairlineDivider()
                actionBar
                    .padding(.vertical, DS.Spacing.xs)
            }
            if !previewComments.isEmpty {
                commentPreviews
                    .padding(.bottom, DS.Spacing.s)
            }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: DS.Spacing.m) {
            authorAvatar
            VStack(alignment: .leading, spacing: 2) {
                authorName
                metaLine
            }
            Spacer(minLength: DS.Spacing.s)
            if !isMine && !isSystemEvent {
                moreMenu
            }
        }
    }

    @ViewBuilder
    private var authorAvatar: some View {
        if isSystemEvent {
            Image(systemName: "shippingbox")
                .font(.system(size: 17, weight: .regular))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.secondary)
                .frame(width: 40, height: 40)
                .background(Color.surfaceRaised, in: Circle())
                .overlay(Circle().strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline))
                .accessibilityHidden(true)
        } else {
            Button { onOpenUser(event.user.id) } label: {
                AvatarView(name: event.user.name, avatar: event.user.avatar, color: event.user.color, size: 40)
            }
            .buttonStyle(.pressable)
            .accessibilityLabel("Ver perfil de \(event.user.name)")
        }
    }

    @ViewBuilder
    private var authorName: some View {
        if isSystemEvent {
            Text("Runna")
                .font(.subheadline.weight(.semibold))
        } else {
            Button { onOpenUser(event.user.id) } label: {
                Text(isMine ? "Tú" : event.user.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
            }
            .buttonStyle(.plain)
        }
    }

    private var metaLine: some View {
        HStack(spacing: 6) {
            ActivityKindBadge(kind: kind)
            Text("·")
                .font(Font.meta)
                .foregroundStyle(.tertiary)
            Text(subtitle)
                .font(Font.meta)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private var moreMenu: some View {
        Menu {
            Button(action: onReport) {
                Label("Denunciar publicación", systemImage: "exclamationmark.bubble")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Más opciones")
    }

    private var subtitle: String {
        let time = Format.relative(event.date)
        if event.eventType == "activity", let routeName = event.routeName, !routeName.isEmpty, !hasRoute {
            return "\(time) · \(routeName)"
        }
        return time
    }

    // MARK: Headline

    @ViewBuilder
    private var headlineView: some View {
        VStack(alignment: .leading, spacing: 2) {
            if hasRoute, event.eventType == "activity", let routeName = event.routeName, !routeName.isEmpty {
                Text(routeName)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(headline)
                .font(kind.isSpecial ? Font.body.weight(.medium) : Font.subheadline)
                .foregroundStyle(headlineColor)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var headlineColor: Color {
        if kind == .steal || kind == .sentinel { return Color.steal }
        return kind.isSpecial ? Color.primary : Color.secondary
    }

    private var victimIsMe: Bool {
        guard let victimId = event.victim?.id else { return false }
        return victimId == currentUserId
    }

    private var headline: String {
        let meta = event.metadata
        switch event.eventType {
        case "treasure_found":
            return isMine ? "Has encontrado un tesoro" : "Ha encontrado un tesoro"
        case "treasure_spawned":
            return "Ha aparecido un tesoro en el mapa."
        case "nickname_changed":
            let target = meta?.targetName ?? event.victim?.name ?? "un jugador"
            if isMine { return "Has puesto un apodo a \(target)" }
            if victimIsMe { return "Te ha puesto un apodo" }
            return "Ha puesto un apodo a \(target)"
        case "sentinel_alert":
            if let message = meta?.alertMessage, !message.isEmpty { return message }
            let attacker = meta?.attackerName ?? "Alguien"
            if let area = meta?.stolenArea, area > 0 {
                return "\(attacker) te ha robado \(Format.area(area))"
            }
            return "\(attacker) ha entrado en tu territorio"
        case "personal_record":
            return "Nuevo récord personal"
        case "territory_stolen":
            let area = Format.area(event.areaStolen ?? 0)
            if victimIsMe { return "Te ha robado \(area)" }
            if isMine { return "Has robado \(area) a \(event.victim?.name ?? "alguien")" }
            return "Ha robado \(area) a \(event.victim?.name ?? "alguien")"
        case "ran_together":
            return isMine ? "Has corrido acompañado" : "Ha corrido acompañado"
        default:
            return runHeadline
        }
    }

    private var runHeadline: String {
        guard let distance = event.distance, distance > 0 else { return isMine ? "Has salido a correr" : "Ha salido a correr" }
        let verb = isMine ? "Has corrido" : "Ha corrido"
        if let area = event.newArea, area > 0 {
            return "\(verb) \(Format.distance(distance)) y conquistado \(Format.area(area))"
        }
        return "\(verb) \(Format.distance(distance))"
    }

    // MARK: Type-specific blocks

    @ViewBuilder
    private var typeSpecificContent: some View {
        switch event.eventType {
        case "treasure_found", "treasure_spawned":
            FeedTreasureBlock(
                rarity: event.metadata?.rarity ?? "common",
                name: event.metadata?.treasureName ?? "Un tesoro",
                emoji: event.metadata?.emoji,
                zone: event.metadata?.zone
            )
        case "nickname_changed":
            FeedNicknameBlock(nickname: event.metadata?.nickname ?? "???")
        case "personal_record":
            if let value = event.recordValue {
                FeedRecordBlock(
                    label: Self.recordLabel(event.recordType ?? ""),
                    value: Self.recordValue(type: event.recordType ?? "", value: value)
                )
            }
        default:
            EmptyView()
        }
    }

    // MARK: Route + stats

    private var routeHero: some View {
        ActivityRouteMap(
            cacheKey: "feed-\(event.id)",
            coordinates: event.routeCoordinates,
            color: userColor,
            cornerRadius: 0,
            bordered: false
        )
        .frame(height: 188)
        .overlay(alignment: .topLeading) { conquestBadge }
    }

    @ViewBuilder
    private var conquestBadge: some View {
        if let area = event.newArea, area > 0 {
            HStack(spacing: 5) {
                Image(systemName: "flag")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.brand)
                Text("+\(Format.area(area))")
                    .font(.footnote.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.primary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .glassSurface(Capsule())
            .padding(DS.Spacing.m)
            .accessibilityLabel("Conquistado \(Format.area(area))")
        }
    }

    private var stats: [ActivityStat] {
        var items: [ActivityStat] = []
        if let distance = event.distance, distance > 0 {
            let parts = ActivityFormat.distanceParts(distance)
            items.append(ActivityStat(systemImage: "figure.run", value: parts.value, label: "Distancia", tint: Color.primary, unit: parts.unit))
        }
        if let duration = event.duration, duration > 0 {
            items.append(ActivityStat(systemImage: "stopwatch", value: Format.duration(duration), label: "Tiempo", tint: Color.primary))
        }
        if let pace = paceText {
            items.append(ActivityStat(systemImage: "speedometer", value: pace, label: "Ritmo", tint: Color.primary, unit: "/km"))
        }
        if !hasRoute, let area = event.newArea, area > 0 {
            let parts = ActivityFormat.areaParts(area)
            items.append(ActivityStat(systemImage: "flag", value: "+\(parts.value)", label: "Conquista", tint: Color.brand, unit: parts.unit))
        }
        return items
    }

    /// Pace only for runs of at least 100 m with a plausible pace (2–20 min/km), like the web app.
    private var paceText: String? {
        guard let distance = event.distance, let duration = event.duration, distance >= 100, duration > 0 else { return nil }
        let secondsPerKm = Double(duration) / (distance / 1000)
        guard secondsPerKm >= 120, secondsPerKm <= 1200 else { return nil }
        return Format.pace(distanceMeters: distance, seconds: duration).replacingOccurrences(of: " /km", with: "")
    }

    // MARK: Records

    static func recordLabel(_ type: String) -> String {
        switch type {
        case "longest_run": return "Carrera más larga"
        case "fastest_pace": return "Ritmo más rápido"
        case "biggest_conquest": return "Mayor conquista"
        default: return "Récord"
        }
    }

    /// longest_run in metres, fastest_pace in decimal min/km, biggest_conquest in m².
    static func recordValue(type: String, value: Double) -> String {
        switch type {
        case "longest_run":
            return Format.distance(value)
        case "fastest_pace":
            guard value.isFinite, value > 0 else { return "--" }
            let totalSeconds = Int((value * 60).rounded())
            return String(format: "%d:%02d /km", totalSeconds / 60, totalSeconds % 60)
        case "biggest_conquest":
            return Format.area(value)
        default:
            return value.formatted()
        }
    }

    // MARK: Actions and comments

    private var actionBar: some View {
        HStack(spacing: DS.Spacing.l) {
            ActivityReactionPill(
                systemImage: "hand.thumbsup",
                activeImage: "hand.thumbsup.fill",
                count: event.likeCount,
                isActive: event.userReaction == "like",
                tint: Color.brand,
                accessibilityLabel: "Me gusta, \(event.likeCount)"
            ) { onReact("like") }
            .disabled(isReacting)

            ActivityReactionPill(
                systemImage: "hand.thumbsdown",
                activeImage: "hand.thumbsdown.fill",
                count: event.dislikeCount,
                isActive: event.userReaction == "dislike",
                tint: Color.primary,
                accessibilityLabel: "No me gusta, \(event.dislikeCount)"
            ) { onReact("dislike") }
            .disabled(isReacting)

            ActivityReactionPill(
                systemImage: "bubble.left",
                activeImage: "bubble.left.fill",
                count: event.commentCount,
                isActive: false,
                tint: Color.primary,
                accessibilityLabel: "\(event.commentCount) comentarios"
            ) { onComments() }

            Spacer(minLength: 0)
        }
    }

    private var commentPreviews: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            ForEach(previewComments.prefix(2)) { comment in
                FeedCommentPreviewLine(comment: comment, people: people, onOpenUser: onOpenUser)
            }
            if event.commentCount > min(previewComments.count, 2) {
                Button(action: onComments) {
                    Text("Ver los \(event.commentCount) comentarios")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture { onComments() }
    }
}

// MARK: - Pieces of the card

private struct FeedCommentPreviewLine: View {
    let comment: FeedComment
    let people: [MentionCandidate]
    let onOpenUser: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: DS.Spacing.s) {
            AvatarView(name: comment.user.name, avatar: comment.user.avatar, color: comment.user.color, size: 24)
            VStack(alignment: .leading, spacing: 1) {
                Text(comment.user.name)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                MentionText(text: comment.content, people: people, onOpenUser: onOpenUser)
                    .font(.footnote)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
    }
}

/// Treasure: chest image, name, rarity and zone on a neutral nested tile.
private struct FeedTreasureBlock: View {
    let rarity: String
    let name: String
    let emoji: String?
    let zone: String?

    private var title: String {
        if let emoji, !emoji.isEmpty { return "\(emoji) \(name)" }
        return name
    }

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            Image(Rarity.chestImage(rarity))
                .resizable()
                .scaledToFit()
                .frame(width: 44, height: 44)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(Font.cardTitle)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    Circle()
                        .fill(Rarity.color(rarity))
                        .frame(width: 6, height: 6)
                    Text(Rarity.label(rarity))
                        .statLabelStyle()
                    if let zone, !zone.isEmpty {
                        Text("·")
                            .font(Font.meta)
                            .foregroundStyle(.tertiary)
                        Text(zone)
                            .font(Font.meta)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(DS.Spacing.m)
        .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
    }
}

/// Nickname: the new nickname set in large type, with its duration.
private struct FeedNicknameBlock: View {
    let nickname: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("“\(nickname)”")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
            Label("Durante 48 horas", systemImage: "clock")
                .font(Font.meta)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(DS.Spacing.m)
        .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
    }
}

/// Personal record: the value as a condensed hero figure with its label.
private struct FeedRecordBlock: View {
    let label: String
    let value: String

    private var parts: (value: String, unit: String?) {
        guard let space = value.lastIndex(of: " ") else { return (value, nil) }
        return (String(value[..<space]), String(value[value.index(after: space)...]))
    }

    var body: some View {
        HStack(alignment: .center, spacing: DS.Spacing.m) {
            VStack(alignment: .leading, spacing: 2) {
                StatValue(value: parts.value, unit: parts.unit, font: Font.stat(34, weight: .bold))
                Text(label)
                    .statLabelStyle()
            }
            Spacer(minLength: 0)
            Image(systemName: "medal")
                .font(.system(size: 22, weight: .regular))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        }
        .padding(DS.Spacing.m)
        .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
    }
}

/// Extra achievements of a run: stolen territory, companions, records, treasures, fortresses.
private struct FeedEventEmblems: View {
    let event: FeedEvent
    let currentUserId: String?
    let onOpenUser: (String) -> Void

    private var meta: FeedMetadata? { event.metadata }
    private var victims: [Victim] { (meta?.victims ?? []).filter { $0.stolenArea > 0 } }
    private var companions: [FeedMetadata.NameRef] { meta?.ranTogetherWith ?? [] }
    private var records: [FeedMetadata.Record] { event.eventType == "personal_record" ? [] : (meta?.records ?? []) }
    private var treasures: [FeedMetadata.TreasureRef] { event.eventType == "treasure_found" ? [] : (meta?.treasures ?? []) }
    private var destroyed: Int { meta?.fortressesDestroyed ?? 0 }
    private var layers: Int { meta?.fortificationLayers ?? 0 }

    private var isEmpty: Bool {
        victims.isEmpty && companions.isEmpty && records.isEmpty && treasures.isEmpty && destroyed == 0 && layers == 0
    }

    var body: some View {
        if !isEmpty {
            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                if !victims.isEmpty {
                    FeedStealList(
                        victims: victims,
                        isMine: event.userId == currentUserId,
                        currentUserId: currentUserId,
                        onOpenUser: onOpenUser
                    )
                }
                if !companions.isEmpty {
                    companionsRow
                }
                ForEach(Array(records.enumerated()), id: \.offset) { _, record in
                    ActivityEmblemRow(systemImage: "medal", text: recordText(record), tint: Color.secondary)
                }
                ForEach(Array(treasures.enumerated()), id: \.offset) { _, treasure in
                    ActivityEmblemRow(systemImage: "shippingbox", text: treasureText(treasure), tint: Color.secondary)
                }
                if destroyed > 0 {
                    ActivityEmblemRow(
                        systemImage: "hammer",
                        text: destroyed == 1 ? "Ha derribado 1 castillo" : "Ha derribado \(destroyed) castillos",
                        tint: Color.secondary
                    )
                }
                if layers > 0 {
                    ActivityEmblemRow(
                        systemImage: "shield.lefthalf.filled",
                        text: "Ha reforzado \(Format.area(meta?.fortificationArea ?? 0)) (+\(layers) \(layers == 1 ? "castillo" : "castillos"))",
                        tint: Color.secondary
                    )
                }
            }
        }
    }

    private func recordText(_ record: FeedMetadata.Record) -> String {
        let label = FeedEventCard.recordLabel(record.type)
        guard let value = record.value else { return "Récord: \(label)" }
        return "Récord: \(label) · \(FeedEventCard.recordValue(type: record.type, value: value))"
    }

    private func treasureText(_ treasure: FeedMetadata.TreasureRef) -> String {
        let name: String = treasure.treasureName ?? "Tesoro"
        guard let rarity = treasure.rarity else { return name }
        return "\(name) · \(Rarity.label(rarity))"
    }

    private var companionsRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "person.2")
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 18)
            Text("Con")
                .font(.footnote)
                .foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(Array(companions.enumerated()), id: \.offset) { index, companion in
                        companionName(companion, isLast: index == companions.count - 1)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func companionName(_ companion: FeedMetadata.NameRef, isLast: Bool) -> some View {
        let isYou: Bool = companion.id != nil && companion.id == currentUserId
        let text = Text((isYou ? "ti" : companion.name) + (isLast ? "" : ","))
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.primary)
            .lineLimit(1)

        if let id = companion.id {
            Button { onOpenUser(id) } label: { text }
                .buttonStyle(.plain)
        } else {
            text
        }
    }
}

/// Who lost territory in this run, as simple coral text lines.
private struct FeedStealList: View {
    let victims: [Victim]
    let isMine: Bool
    let currentUserId: String?
    let onOpenUser: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(victims) { victim in
                row(victim)
            }
        }
    }

    private func text(for victim: Victim) -> String {
        let area: String = Format.area(victim.stolenArea)
        if victim.userId == currentUserId { return "Te ha robado \(area)" }
        return isMine ? "Has robado \(area) a \(victim.userName)" : "Ha robado \(area) a \(victim.userName)"
    }

    private func row(_ victim: Victim) -> some View {
        Button { onOpenUser(victim.userId) } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "bolt")
                    .font(.footnote.weight(.medium))
                    .frame(width: 18)
                Text(text(for: victim))
                    .font(.footnote.weight(.medium))
                    .monospacedDigit()
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .foregroundStyle(Color.steal)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
