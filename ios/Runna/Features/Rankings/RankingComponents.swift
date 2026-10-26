import SwiftUI

// MARK: - Model

/// One player in any leaderboard (friends, competition, weekly summary, final results).
struct RankingItem: Identifiable, Hashable {
    let id: String
    let rank: Int
    let name: String
    let username: String
    let nickname: String?
    let avatar: String?
    let color: String
    let area: Double
    var stolen: Double = 0
    var treasures: Int = 0
    var isMe: Bool = false

    var hasNickname: Bool {
        guard let nickname else { return false }
        return !nickname.isEmpty
    }

    /// "@username" (+ "antes: name" while a Pluma del Troll nickname is active).
    var subtitle: String? {
        let handle: String? = username.isEmpty ? nil : "@\(username)"
        if hasNickname {
            let parts: [String?] = [handle, "antes: \(name)"]
            return parts.compactMap { $0 }.joined(separator: " · ")
        }
        return handle
    }
}

extension RankingItem {
    init(user: AppUser, rank: Int, isMe: Bool) {
        self.init(
            id: user.id,
            rank: rank,
            name: user.name,
            username: user.username,
            nickname: user.nickname,
            avatar: user.avatar,
            color: user.color,
            area: user.totalArea,
            isMe: isMe
        )
    }

    init(user: UserRef, rank: Int, area: Double, stolen: Double = 0, treasures: Int = 0, isMe: Bool) {
        self.init(
            id: user.id,
            rank: rank,
            name: user.name,
            username: user.username,
            nickname: user.nickname,
            avatar: user.avatar,
            color: user.color,
            area: area,
            stolen: stolen,
            treasures: treasures,
            isMe: isMe
        )
    }

    init(entry: CompetitionEntry, rank: Int, isMe: Bool) {
        self.init(
            user: entry.user,
            rank: rank,
            area: entry.totalArea,
            stolen: entry.areaStolen,
            treasures: entry.treasuresCollected,
            isMe: isMe
        )
    }
}

extension RankingItem {
    /// Name as shown in lists: the active nickname, else the real name.
    var displayName: String {
        if hasNickname, let nickname { return nickname }
        return name
    }
}

// MARK: - Medals

/// Rank accents. Only #1 gets a colour (gold); the rest of the podium stays neutral.
enum RankingMedal {
    static let silver = Color.secondary
    static let bronze = Color.secondary

    static func color(_ place: Int) -> Color {
        place == 1 ? Color.gold : Color.secondary
    }

    /// Legacy: flat colour (no gradients).
    static func gradient(_ place: Int) -> LinearGradient {
        let base: Color = place == 1 ? Color.gold : Color(uiColor: .systemGray)
        return LinearGradient(colors: [base, base], startPoint: .top, endPoint: .bottom)
    }
}

// MARK: - Name

/// Player name, with a small masks glyph while a Pluma del Troll nickname is active.
struct RankingNameText: View {
    let item: RankingItem
    var font: Font = .body.weight(.semibold)

    var body: some View {
        HStack(spacing: 4) {
            if item.hasNickname {
                Image(systemName: "theatermasks")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Apodo")
            }
            Text(item.displayName)
                .font(font)
                .foregroundStyle(Color.primary)
                .lineLimit(1)
        }
    }
}

/// Small "TÚ" label next to the user's own entry: brand text, no fill.
struct RankingMeBadge: View {
    var body: some View {
        Text("Tú")
            .font(Font.statLabel)
            .textCase(.uppercase)
            .tracking(DS.Tracking.label)
            .foregroundStyle(Color.brand)
            .accessibilityLabel("tú")
    }
}

// MARK: - Top three

/// Restrained top-3 summary: three equal columns (rank, avatar, name, area) split by hairlines.
struct RankingTopThreeCard: View {
    let items: [RankingItem]
    var onSelect: ((RankingItem) -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            column(place: 1)
            StatDivider(height: 120)
                .padding(.top, DS.Spacing.s)
            column(place: 2)
            StatDivider(height: 120)
                .padding(.top, DS.Spacing.s)
            column(place: 3)
        }
        .padding(.vertical, DS.Spacing.l)
        .padding(.horizontal, DS.Spacing.xs)
        .frame(maxWidth: .infinity)
        .background(Color.surface, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
        .hairlineBorder(radius: DS.Radius.card)
    }

    @ViewBuilder
    private func column(place: Int) -> some View {
        if items.count >= place {
            let item: RankingItem = items[place - 1]
            if let onSelect {
                Button {
                    onSelect(item)
                } label: {
                    RankingTopThreeColumn(item: item, place: place)
                }
                .buttonStyle(.pressable)
            } else {
                RankingTopThreeColumn(item: item, place: place)
            }
        } else {
            RankingTopThreeEmpty(place: place)
        }
    }
}

private struct RankingTopThreeColumn: View {
    let item: RankingItem
    let place: Int

    var body: some View {
        let parts = Format.areaParts(item.area)
        VStack(spacing: DS.Spacing.s) {
            rankLabel
            AvatarView(name: item.name, avatar: item.avatar, color: item.color, size: 52)
            VStack(spacing: 2) {
                RankingNameText(item: item, font: .footnote.weight(.semibold))
                    .frame(maxWidth: .infinity)
                if item.isMe {
                    RankingMeBadge()
                } else if !item.username.isEmpty {
                    Text("@\(item.username)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            StatValue(value: parts.value, unit: parts.unit, font: Font.stat(22, weight: .semibold))
        }
        .padding(.horizontal, DS.Spacing.s)
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Puesto \(place): \(item.displayName), \(Format.area(item.area))\(item.isMe ? ", tú" : "")")
    }

    private var rankLabel: some View {
        HStack(spacing: 3) {
            if place == 1 {
                Image(systemName: "crown.fill")
                    .font(.caption2.weight(.semibold))
            }
            Text("\(place)")
                .font(Font.stat(15, weight: .semibold))
                .monospacedDigit()
        }
        .foregroundStyle(place == 1 ? Color.gold : Color.secondary)
        .frame(height: 18)
    }
}

private struct RankingTopThreeEmpty: View {
    let place: Int

    var body: some View {
        VStack(spacing: DS.Spacing.s) {
            Text("\(place)")
                .font(Font.stat(15, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .frame(height: 18)
            Circle()
                .strokeBorder(Color.hairline, lineWidth: 1)
                .frame(width: 52, height: 52)
            Text("Libre")
                .font(.footnote)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Puesto \(place) libre")
    }
}

// MARK: - Rows

/// Leaderboard row: monospaced rank, avatar, name + @username, area right-aligned.
/// Drawn flat: place rows inside `RankingListCard` (which adds the container and hairlines).
struct RankRow: View {
    let item: RankingItem

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            Text("\(item.rank)")
                .font(.system(.subheadline, design: .monospaced).weight(.medium))
                .foregroundStyle(item.isMe ? Color.brand : Color.secondary)
                .frame(minWidth: 24, alignment: .leading)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            AvatarView(name: item.name, avatar: item.avatar, color: item.color, size: 36)
            nameColumn
            Spacer(minLength: DS.Spacing.s)
            valueColumn
        }
        .padding(.horizontal, DS.Spacing.l)
        .padding(.vertical, 10)
        .background(item.isMe ? Color.brand.opacity(0.07) : Color.clear)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var nameColumn: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                RankingNameText(item: item, font: .subheadline.weight(.semibold))
                if item.isMe {
                    RankingMeBadge()
                }
            }
            if let subtitle = item.subtitle {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if item.stolen > 0 || item.treasures > 0 {
                extras
            }
        }
    }

    private var extras: some View {
        HStack(spacing: 10) {
            if item.stolen > 0 {
                RankingMiniChip(systemImage: "arrow.down.right", text: "\(Format.area(item.stolen)) robados", tint: Color.steal)
            }
            if item.treasures > 0 {
                RankingMiniChip(systemImage: "shippingbox", text: "\(item.treasures)", tint: Color.secondary)
                    .accessibilityLabel("\(item.treasures) tesoros")
            }
        }
    }

    private var valueColumn: some View {
        let parts = Format.areaParts(item.area)
        return StatValue(value: parts.value, unit: parts.unit, font: Font.stat(19, weight: .semibold))
            .fixedSize()
    }
}

/// Quiet inline metadata: small symbol + text in one colour. No capsule.
struct RankingMiniChip: View {
    let systemImage: String
    let text: String
    let tint: Color

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage)
                .font(.caption2.weight(.semibold))
            Text(text)
                .font(.caption2.weight(.medium))
                .monospacedDigit()
        }
        .foregroundStyle(tint)
        .lineLimit(1)
    }
}

/// Rows inside one flat card, separated by inset hairlines.
struct RankingListCard: View {
    let items: [RankingItem]
    var onSelect: ((RankingItem) -> Void)? = nil

    var body: some View {
        LazyVStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 {
                    HairlineDivider()
                        .padding(.leading, 52)
                }
                row(item)
            }
        }
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
        .hairlineBorder(radius: DS.Radius.card)
    }

    @ViewBuilder
    private func row(_ item: RankingItem) -> some View {
        if let onSelect {
            Button {
                onSelect(item)
            } label: {
                RankRow(item: item)
            }
            .buttonStyle(RankingRowButtonStyle())
        } else {
            RankRow(item: item)
        }
    }
}

/// List-like press feedback: a neutral highlight, no scaling.
private struct RankingRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color(uiColor: .systemFill) : Color.clear)
    }
}

// MARK: - Your position

/// "Tu posición": how far the user is from the next player up (or how far ahead when leading).
struct RankingPositionCard: View {
    let me: RankingItem
    let above: RankingItem?
    let below: RankingItem?

    var body: some View {
        HStack(spacing: DS.Spacing.l) {
            VStack(spacing: 2) {
                Text("#\(me.rank)")
                    .font(Font.stat(28, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(me.rank == 1 ? Color.gold : Color.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Text("Tu puesto")
                    .statLabelStyle()
                    .lineLimit(1)
            }
            .frame(minWidth: 64)
            StatDivider(height: 40)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .card(padding: 14)
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        guard let above else { return "Vas primero" }
        let gap = above.area - me.area
        if gap <= 0 { return "Empatas con \(above.displayName)" }
        return "A \(Format.area(gap)) de \(above.displayName)"
    }

    private var message: String {
        if above == nil {
            guard let below else { return "Nadie más en la clasificación por ahora." }
            let lead = me.area - below.area
            if lead <= 0 { return "Empatas con \(below.displayName)." }
            return "Le sacas \(Format.area(lead)) a \(below.displayName)."
        }
        return "Una carrera más puede bastar para adelantar."
    }
}

// MARK: - Board

/// Top-3 summary, the user's position, then the full list.
struct RankingBoardView: View {
    let items: [RankingItem]
    var showsPosition: Bool = true
    var footnote: String? = nil
    /// When false, every player (including the top 3) is shown as a plain list row.
    var showsTopThree: Bool = true
    var onSelect: ((RankingItem) -> Void)? = nil

    private var listItems: [RankingItem] {
        showsTopThree && items.count >= 3 ? Array(items.dropFirst(3)) : items
    }

    private var usesTopThree: Bool { showsTopThree && items.count >= 3 }

    var body: some View {
        VStack(spacing: DS.Spacing.l) {
            if usesTopThree {
                RankingTopThreeCard(items: Array(items.prefix(3)), onSelect: onSelect)
            }
            if showsPosition {
                positionCard
            }
            if !listItems.isEmpty {
                RankingListCard(items: listItems, onSelect: onSelect)
            }
            if let footnote {
                Text(footnote)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, DS.Spacing.xs)
            }
        }
    }

    @ViewBuilder
    private var positionCard: some View {
        if items.count >= 2, let index = items.firstIndex(where: { $0.isMe }) {
            RankingPositionCard(
                me: items[index],
                above: index > 0 ? items[index - 1] : nil,
                below: index + 1 < items.count ? items[index + 1] : nil
            )
        }
    }
}

// MARK: - Loading

/// Static placeholder blocks while the leaderboard loads (no pulsing).
struct RankingSkeleton: View {
    var body: some View {
        VStack(spacing: DS.Spacing.l) {
            RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous)
                .fill(Color.surface)
                .frame(height: 180)
                .hairlineBorder(radius: DS.Radius.card)
            VStack(spacing: 0) {
                ForEach(0..<5, id: \.self) { index in
                    if index > 0 {
                        HairlineDivider().padding(.leading, 52)
                    }
                    placeholderRow
                }
            }
            .background(Color.surface, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
            .hairlineBorder(radius: DS.Radius.card)
        }
        .overlay { ProgressView() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Cargando clasificación")
    }

    private var placeholderRow: some View {
        HStack(spacing: DS.Spacing.m) {
            RoundedRectangle(cornerRadius: 3).fill(Color(uiColor: .tertiarySystemFill)).frame(width: 18, height: 12)
            Circle().fill(Color(uiColor: .tertiarySystemFill)).frame(width: 36, height: 36)
            RoundedRectangle(cornerRadius: 3).fill(Color(uiColor: .tertiarySystemFill)).frame(width: 120, height: 12)
            Spacer(minLength: 0)
            RoundedRectangle(cornerRadius: 3).fill(Color(uiColor: .tertiarySystemFill)).frame(width: 48, height: 14)
        }
        .padding(.horizontal, DS.Spacing.l)
        .frame(height: 56)
    }
}
