import SwiftUI

/// One event of the friends feed: author, headline, route map hero, stats, achievements,
/// reactions and the first comments.
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
        VStack(alignment: .leading, spacing: 14) {
            header
            headlineView
            typeSpecificContent
            if hasRoute {
                routeHero
            }
            if !stats.isEmpty {
                ActivityStatsStrip(stats: stats)
            }
            FeedEventEmblems(event: event, currentUserId: currentUserId, onOpenUser: onOpenUser)
            actionBar
            if !previewComments.isEmpty {
                commentPreviews
            }
        }
        .activityCard(tint: kind.isSpecial ? kind.tint : nil)
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 12) {
            authorAvatar
            VStack(alignment: .leading, spacing: 2) {
                authorName
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            ActivityKindBadge(kind: kind)
            if !isMine && !isSystemEvent {
                moreMenu
            }
        }
    }

    @ViewBuilder
    private var authorAvatar: some View {
        if isSystemEvent {
            ZStack {
                Circle().fill(.goldGradient)
                Text("🏴‍☠️").font(.system(size: 22))
            }
            .frame(width: 44, height: 44)
            .accessibilityHidden(true)
        } else {
            Button { onOpenUser(event.user.id) } label: {
                AvatarView(name: event.user.name, avatar: event.user.avatar, color: event.user.color, size: 44)
            }
            .buttonStyle(.pressable)
            .accessibilityLabel("Ver perfil de \(event.user.name)")
        }
    }

    @ViewBuilder
    private var authorName: some View {
        if isSystemEvent {
            Text("Runna")
                .font(Font.cardTitle)
        } else {
            Button { onOpenUser(event.user.id) } label: {
                Text(isMine ? "Tú" : event.user.displayName)
                    .font(Font.cardTitle)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
            }
            .buttonStyle(.plain)
        }
    }

    private var moreMenu: some View {
        Menu {
            Button(action: onReport) {
                Label("Denunciar publicación", systemImage: "exclamationmark.bubble")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 32)
                .background(Color.surfaceRaised, in: Circle())
                .contentShape(Circle())
        }
        .accessibilityLabel("Más opciones")
    }

    private var subtitle: String {
        let time = Format.relative(event.date)
        if !hasRoute, event.eventType == "activity", let routeName = event.routeName, !routeName.isEmpty {
            return "\(time) · \(routeName)"
        }
        return time
    }

    // MARK: Headline

    private var headlineView: some View {
        Text(headline)
            .font(.system(.body, design: .rounded, weight: kind.isSpecial ? .bold : .semibold))
            .foregroundStyle(kind == .steal || kind == .sentinel ? Color.steal : Color.primary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var victimIsMe: Bool {
        guard let victimId = event.victim?.id else { return false }
        return victimId == currentUserId
    }

    private var headline: String {
        let meta = event.metadata
        switch event.eventType {
        case "treasure_found":
            return isMine ? "¡Has encontrado un tesoro!" : "¡Ha encontrado un tesoro!"
        case "treasure_spawned":
            return "¡Ha aparecido un tesoro en el mapa! Corre a por él."
        case "nickname_changed":
            let target = meta?.targetName ?? event.victim?.name ?? "un jugador"
            if isMine { return "Has bautizado a \(target) con un apodo nuevo" }
            if victimIsMe { return "¡Te ha puesto un apodo!" }
            return "Ha bautizado a \(target) con un apodo nuevo"
        case "sentinel_alert":
            if let message = meta?.alertMessage, !message.isEmpty { return message }
            let attacker = meta?.attackerName ?? "Alguien"
            if let area = meta?.stolenArea, area > 0 {
                return "\(attacker) te ha robado \(Format.area(area))"
            }
            return "\(attacker) ha entrado en tu territorio"
        case "personal_record":
            return "¡Nuevo récord personal! \(Self.recordLabel(event.recordType ?? ""))"
        case "territory_stolen":
            let area = Format.area(event.areaStolen ?? 0)
            if victimIsMe { return "¡Te ha robado \(area)!" }
            if isMine { return "Has robado \(area) a \(event.victim?.name ?? "alguien")" }
            return "Ha robado \(area) a \(event.victim?.name ?? "alguien")"
        case "ran_together":
            return isMine ? "Has corrido en buena compañía" : "Ha corrido en buena compañía"
        default:
            return runHeadline
        }
    }

    private var runHeadline: String {
        guard let distance = event.distance, distance > 0 else { return "Ha salido a correr" }
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
        ActivityRouteMap(cacheKey: "feed-\(event.id)", coordinates: event.routeCoordinates, color: userColor)
            .frame(height: 184)
            .overlay(alignment: .topTrailing) { conquestBadge }
            .overlay(alignment: .bottomLeading) { routeNameChip }
    }

    @ViewBuilder
    private var conquestBadge: some View {
        if let area = event.newArea, area > 0 {
            HStack(spacing: 4) {
                Image(systemName: "flag.fill")
                    .font(.caption.weight(.bold))
                Text("+\(Format.area(area))")
                    .font(.system(.footnote, design: .rounded, weight: .heavy))
                    .monospacedDigit()
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.brandGradient, in: Capsule())
            .shadow(color: Color.brand.opacity(0.4), radius: 6, x: 0, y: 3)
            .padding(10)
        }
    }

    @ViewBuilder
    private var routeNameChip: some View {
        if let routeName = event.routeName, !routeName.isEmpty {
            HStack(spacing: 5) {
                Circle().fill(userColor).frame(width: 8, height: 8)
                Text(routeName)
                    .font(.system(.caption, design: .rounded, weight: .semibold))
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .glassSurface(Capsule())
            .padding(10)
        }
    }

    private var stats: [ActivityStat] {
        var items: [ActivityStat] = []
        if let distance = event.distance, distance > 0 {
            items.append(ActivityStat(systemImage: "figure.run", value: Format.distance(distance), label: "Distancia", tint: Color.sky))
        }
        if let duration = event.duration, duration > 0 {
            items.append(ActivityStat(systemImage: "stopwatch.fill", value: Format.duration(duration), label: "Tiempo", tint: Color.grape))
        }
        if let pace = paceText {
            items.append(ActivityStat(systemImage: "speedometer", value: pace, label: "Ritmo", tint: Color.gold))
        }
        if !hasRoute, let area = event.newArea, area > 0 {
            items.append(ActivityStat(systemImage: "flag.fill", value: "+\(Format.area(area))", label: "Conquista", tint: Color.brand))
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
        HStack(spacing: 8) {
            ActivityReactionPill(
                systemImage: "flame",
                activeImage: "flame.fill",
                count: event.likeCount,
                isActive: event.userReaction == "like",
                tint: Color.steal,
                accessibilityLabel: "Me gusta, \(event.likeCount)"
            ) { onReact("like") }
            .disabled(isReacting)

            ActivityReactionPill(
                systemImage: "hand.thumbsdown",
                activeImage: "hand.thumbsdown.fill",
                count: event.dislikeCount,
                isActive: event.userReaction == "dislike",
                tint: Color.grape,
                accessibilityLabel: "No me gusta, \(event.dislikeCount)"
            ) { onReact("dislike") }
            .disabled(isReacting)

            ActivityReactionPill(
                systemImage: "bubble.left",
                activeImage: "bubble.left.fill",
                count: event.commentCount,
                isActive: false,
                tint: Color.sky,
                accessibilityLabel: "\(event.commentCount) comentarios"
            ) { onComments() }

            Spacer(minLength: 0)
        }
    }

    private var commentPreviews: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(previewComments.prefix(2)) { comment in
                FeedCommentPreviewLine(comment: comment, people: people, onOpenUser: onOpenUser)
            }
            if event.commentCount > min(previewComments.count, 2) {
                Button(action: onComments) {
                    HStack(spacing: 4) {
                        Text("Ver los \(event.commentCount) comentarios")
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.bold))
                    }
                    .font(.system(.footnote, design: .rounded, weight: .semibold))
                    .foregroundStyle(Color.brand)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
        .onTapGesture { onComments() }
    }
}

// MARK: - Pieces of the card

private struct FeedCommentPreviewLine: View {
    let comment: FeedComment
    let people: [MentionCandidate]
    let onOpenUser: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            AvatarView(name: comment.user.name, avatar: comment.user.avatar, color: comment.user.color, size: 24)
            VStack(alignment: .leading, spacing: 1) {
                Text(comment.user.name)
                    .font(.system(.caption, design: .rounded, weight: .bold))
                    .foregroundStyle(Color(hex: comment.user.color))
                    .lineLimit(1)
                MentionText(text: comment.content, people: people, onOpenUser: onOpenUser)
                    .font(.footnote)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
    }
}

private struct FeedTreasureBlock: View {
    let rarity: String
    let name: String
    let emoji: String?
    let zone: String?

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(Rarity.color(rarity).opacity(0.22))
                    .frame(width: 76, height: 76)
                    .blur(radius: 6)
                Image(Rarity.chestImage(rarity))
                    .resizable()
                    .scaledToFit()
                    .frame(width: 64, height: 64)
            }
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text("\(emoji ?? "🎁") \(name)")
                    .font(Font.cardTitle)
                    .fixedSize(horizontal: false, vertical: true)
                RarityPill(rarity: rarity)
                if let zone, !zone.isEmpty {
                    Label(zone, systemImage: "mappin.and.ellipse")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Rarity.color(rarity).opacity(0.10), in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous)
                .strokeBorder(Rarity.color(rarity).opacity(0.35), lineWidth: 1)
        )
    }
}

private struct FeedNicknameBlock: View {
    let nickname: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "theatermasks.fill")
                .font(.title2)
                .foregroundStyle(.white)
                .frame(width: 48, height: 48)
                .background(.grapeGradient, in: Circle())
            Text("“\(nickname)”")
                .font(Font.stat(26, weight: .heavy))
                .foregroundStyle(Color.grape)
                .multilineTextAlignment(.center)
            Label("Durará 48 horas", systemImage: "clock")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
        .background(Color.grape.opacity(0.10), in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
    }
}

private struct FeedRecordBlock: View {
    let label: String
    let value: String

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "medal.fill")
                .font(.title2)
                .foregroundStyle(.white)
                .frame(width: 52, height: 52)
                .background(.goldGradient, in: Circle())
                .shadow(color: Color.gold.opacity(0.4), radius: 8, x: 0, y: 4)
            VStack(alignment: .leading, spacing: 2) {
                Text(value)
                    .font(Font.stat(28, weight: .heavy))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Text(label)
                    .statLabelStyle()
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(Color.gold.opacity(0.10), in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
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
            VStack(alignment: .leading, spacing: 10) {
                if !victims.isEmpty {
                    FeedStealList(victims: victims, currentUserId: currentUserId, onOpenUser: onOpenUser)
                }
                if !companions.isEmpty {
                    companionsRow
                }
                ForEach(Array(records.enumerated()), id: \.offset) { _, record in
                    ActivityEmblemRow(systemImage: "medal.fill", text: recordText(record), tint: Color.gold)
                }
                ForEach(Array(treasures.enumerated()), id: \.offset) { _, treasure in
                    treasureRow(treasure)
                }
                if destroyed > 0 {
                    ActivityEmblemRow(
                        systemImage: "hammer.fill",
                        text: destroyed == 1 ? "Ha derribado 1 fortaleza" : "Ha derribado \(destroyed) fortalezas",
                        tint: Color.steal
                    )
                }
                if layers > 0 {
                    ActivityEmblemRow(
                        systemImage: "shield.lefthalf.filled",
                        text: "Ha reforzado \(Format.area(meta?.fortificationArea ?? 0)) (+\(layers) \(layers == 1 ? "capa" : "capas"))",
                        tint: Color.sky
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

    private func treasureRow(_ treasure: FeedMetadata.TreasureRef) -> some View {
        HStack(spacing: 8) {
            ActivityEmblemRow(systemImage: "gift.fill", text: treasure.treasureName ?? "Tesoro", tint: Color.gold)
            if let rarity = treasure.rarity {
                RarityPill(rarity: rarity)
            }
        }
    }

    private var companionsRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Corrieron juntos")
                .statLabelStyle()
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(companions.enumerated()), id: \.offset) { _, companion in
                        companionChip(companion)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func companionChip(_ companion: FeedMetadata.NameRef) -> some View {
        let isYou: Bool = companion.id != nil && companion.id == currentUserId
        let chip = HStack(spacing: 5) {
            Image(systemName: "figure.run")
                .font(.caption2.weight(.bold))
            Text(isYou ? "Tú" : companion.name)
                .font(.system(.caption, design: .rounded, weight: .semibold))
                .lineLimit(1)
        }
        .foregroundStyle(Color.sky)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color.sky.opacity(0.14), in: Capsule())

        if let id = companion.id {
            Button { onOpenUser(id) } label: { chip }
                .buttonStyle(.pressable)
        } else {
            chip
        }
    }
}

/// Coral block listing who lost territory in this run.
private struct FeedStealList: View {
    let victims: [Victim]
    let currentUserId: String?
    let onOpenUser: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "bolt.fill")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 22, height: 22)
                    .background(.stealGradient, in: Circle())
                Text("Territorio robado")
                    .font(.system(.footnote, design: .rounded, weight: .bold))
                    .foregroundStyle(Color.steal)
            }
            ForEach(victims) { victim in
                row(victim)
            }
        }
        .padding(12)
        .background(Color.steal.opacity(0.09), in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous)
                .strokeBorder(Color.steal.opacity(0.25), lineWidth: 1)
        )
    }

    private func row(_ victim: Victim) -> some View {
        let isYou: Bool = victim.userId == currentUserId
        return Button { onOpenUser(victim.userId) } label: {
            HStack(spacing: 10) {
                AvatarView(name: victim.userName, avatar: nil, color: victim.userColor, size: 26)
                Text(isYou ? "A ti" : "a \(victim.userName)")
                    .font(.system(.subheadline, design: .rounded, weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text("-\(Format.area(victim.stolenArea))")
                    .font(.system(.subheadline, design: .rounded, weight: .heavy))
                    .monospacedDigit()
                    .foregroundStyle(Color.steal)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
