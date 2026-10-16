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

// MARK: - Medals

enum RankingMedal {
    static let silver = Color.adaptive(light: 0x9AA6B2, dark: 0xC8D1DA)
    static let bronze = Color.adaptive(light: 0xC87A3C, dark: 0xE39A5C)

    static func color(_ place: Int) -> Color {
        switch place {
        case 1: return Color.gold
        case 2: return silver
        default: return bronze
        }
    }

    static func gradient(_ place: Int) -> LinearGradient {
        switch place {
        case 1:
            return LinearGradient.goldGradient
        case 2:
            return LinearGradient(colors: [Color.adaptive(light: 0xC9D2DB, dark: 0xE4EAF0), silver], startPoint: .topLeading, endPoint: .bottomTrailing)
        default:
            return LinearGradient(colors: [Color.adaptive(light: 0xE0A26B, dark: 0xF0B985), bronze], startPoint: .topLeading, endPoint: .bottomTrailing)
        }
    }
}

// MARK: - Capsule picker

/// Custom segmented control: capsule track with a sliding gradient pill.
struct RankingCapsulePicker<Value: Hashable>: View {
    struct Option: Identifiable {
        let value: Value
        let title: String
        let systemImage: String
        var gradient: LinearGradient = LinearGradient.brandGradient
        var id: String { title }
    }

    let options: [Option]
    @Binding var selection: Value

    @Namespace private var namespace

    var body: some View {
        HStack(spacing: 4) {
            ForEach(options) { option in
                optionButton(option)
            }
        }
        .padding(4)
        .background(Color.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.hairline, lineWidth: 1))
        .shadow(color: Color.black.opacity(0.05), radius: 8, x: 0, y: 3)
        .sensoryFeedback(.selection, trigger: selection)
    }

    private func optionButton(_ option: Option) -> some View {
        let isSelected = option.value == selection
        return Button {
            withAnimation(.snappy(duration: 0.3)) { selection = option.value }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: option.systemImage)
                    .font(.subheadline.weight(.bold))
                    .symbolEffect(.bounce, value: isSelected)
                Text(option.title)
                    .font(.system(.subheadline, design: .rounded, weight: .bold))
                    .lineLimit(1)
            }
            .foregroundStyle(isSelected ? Color.white : Color.secondary)
            .frame(maxWidth: .infinity, minHeight: 42)
            .background {
                if isSelected {
                    Capsule()
                        .fill(option.gradient)
                        .matchedGeometryEffect(id: "rankingPickerSelection", in: namespace)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(option.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

// MARK: - Podium

/// Top-3 hero: 2nd · 1st · 3rd on pedestals, crown for the leader, medal badges and territory-colour rings.
struct RankingPodiumCard: View {
    let items: [RankingItem]
    var onSelect: ((RankingItem) -> Void)? = nil

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        RankingPodium(items: Array(items.prefix(3)), onSelect: onSelect)
            .padding(.top, DS.Spacing.l)
            .padding(.horizontal, DS.Spacing.m)
            .frame(maxWidth: .infinity)
            .background { backdrop }
            .clipShape(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous).strokeBorder(Color.hairline, lineWidth: 1))
            .shadow(color: Color.black.opacity(colorScheme == .dark ? 0 : 0.06), radius: 12, x: 0, y: 4)
    }

    private var backdrop: some View {
        ZStack {
            Color.surface
            RadialGradient(colors: [Color.gold.opacity(0.26), Color.clear], center: .top, startRadius: 4, endRadius: 230)
            RadialGradient(colors: [Color.brand.opacity(0.12), Color.clear], center: .bottomLeading, startRadius: 4, endRadius: 200)
        }
    }
}

struct RankingPodium: View {
    let items: [RankingItem]
    var onSelect: ((RankingItem) -> Void)? = nil

    @State private var appeared = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            RankingPodiumColumn(item: item(at: 2), place: 2, raised: appeared, onSelect: onSelect)
            RankingPodiumColumn(item: item(at: 1), place: 1, raised: appeared, onSelect: onSelect)
            RankingPodiumColumn(item: item(at: 3), place: 3, raised: appeared, onSelect: onSelect)
        }
        .onAppear {
            if reduceMotion {
                appeared = true
            } else {
                withAnimation(.spring(response: 0.6, dampingFraction: 0.72).delay(0.08)) {
                    appeared = true
                }
            }
        }
    }

    private func item(at place: Int) -> RankingItem? {
        items.count >= place ? items[place - 1] : nil
    }
}

private struct RankingPodiumColumn: View {
    let item: RankingItem?
    let place: Int
    let raised: Bool
    let onSelect: ((RankingItem) -> Void)?

    private var avatarSize: CGFloat { place == 1 ? 80 : 62 }
    private var pedestalHeight: CGFloat {
        switch place {
        case 1: return 92
        case 2: return 66
        default: return 48
        }
    }

    var body: some View {
        VStack(spacing: 10) {
            if let item {
                profileButton(item)
            } else {
                emptySpot
            }
            pedestal
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func profileButton(_ item: RankingItem) -> some View {
        if let onSelect {
            Button {
                onSelect(item)
            } label: {
                RankingPodiumProfile(item: item, place: place, avatarSize: avatarSize, celebrate: raised)
            }
            .buttonStyle(.pressable)
        } else {
            RankingPodiumProfile(item: item, place: place, avatarSize: avatarSize, celebrate: raised)
        }
    }

    private var emptySpot: some View {
        VStack(spacing: 8) {
            Circle()
                .strokeBorder(Color.secondary.opacity(0.35), style: StrokeStyle(lineWidth: 2, dash: [5, 5]))
                .frame(width: avatarSize, height: avatarSize)
                .overlay {
                    Image(systemName: "questionmark")
                        .font(.system(size: avatarSize * 0.3, weight: .bold, design: .rounded))
                        .foregroundStyle(.tertiary)
                }
            Text("¿Quién?")
                .font(.system(.caption, design: .rounded, weight: .semibold))
                .foregroundStyle(.tertiary)
        }
        .accessibilityLabel("Puesto \(place) libre")
    }

    private var pedestal: some View {
        let medal = RankingMedal.color(place)
        let shape = UnevenRoundedRectangle(topLeadingRadius: 16, topTrailingRadius: 16, style: .continuous)
        return shape
            .fill(LinearGradient(colors: [medal.opacity(0.55), medal.opacity(0.10)], startPoint: .top, endPoint: .bottom))
            .overlay(alignment: .top) {
                Text("\(place)")
                    .font(Font.stat(place == 1 ? 34 : 26, weight: .black))
                    .foregroundStyle(Color.white.opacity(0.95))
                    .shadow(color: medal.opacity(0.6), radius: 4, x: 0, y: 1)
                    .padding(.top, 6)
                    .opacity(raised ? 1 : 0)
            }
            .frame(height: raised ? pedestalHeight : 10)
            .accessibilityHidden(true)
    }
}

private struct RankingPodiumProfile: View {
    let item: RankingItem
    let place: Int
    let avatarSize: CGFloat
    let celebrate: Bool

    var body: some View {
        VStack(spacing: 6) {
            avatar
            VStack(spacing: 3) {
                name
                Text(Format.area(item.area))
                    .font(.system(.caption, design: .rounded, weight: .heavy))
                    .monospacedDigit()
                    .foregroundStyle(place == 1 ? Color.gold : Color.secondary)
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .padding(.top, 8)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Puesto \(place): \(item.hasNickname ? (item.nickname ?? item.name) : item.name), \(Format.area(item.area))\(item.isMe ? ", tú" : "")")
    }

    private var avatar: some View {
        VStack(spacing: 0) {
            if place == 1 {
                Image(systemName: "crown.fill")
                    .font(.system(size: 26, weight: .bold))
                    .foregroundStyle(LinearGradient.goldGradient)
                    .shadow(color: Color.gold.opacity(0.55), radius: 6, x: 0, y: 2)
                    .symbolEffect(.bounce, value: celebrate)
                    .padding(.bottom, 2)
            }
            AvatarView(name: item.name, avatar: item.avatar, color: item.color, size: avatarSize)
                .shadow(color: Color(hex: item.color).opacity(0.40), radius: place == 1 ? 14 : 8, x: 0, y: 4)
                .overlay(alignment: .bottom) {
                    medalBadge.offset(y: 11)
                }
        }
    }

    private var medalBadge: some View {
        Text("\(place)")
            .font(.system(size: 13, weight: .black, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: 24, height: 24)
            .background(RankingMedal.gradient(place), in: Circle())
            .overlay(Circle().stroke(Color.surface, lineWidth: 2.5))
    }

    private var nameStyle: Font.TextStyle { place == 1 ? Font.TextStyle.subheadline : Font.TextStyle.footnote }

    @ViewBuilder
    private var name: some View {
        HStack(spacing: 4) {
            if item.hasNickname {
                Text("🎭 \(item.nickname ?? "")")
                    .foregroundStyle(Color.pink)
            } else {
                Text(item.name)
            }
        }
        .font(.system(nameStyle, design: .rounded, weight: .bold))
        .lineLimit(1)
        .minimumScaleFactor(0.75)
        if item.isMe {
            RankingMeBadge()
        }
    }
}

/// Small "TÚ" capsule next to the user's own entry.
struct RankingMeBadge: View {
    var body: some View {
        Text("Tú")
            .font(.system(size: 10, weight: .heavy, design: .rounded))
            .textCase(.uppercase)
            .tracking(0.6)
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(LinearGradient.brandGradient, in: Capsule())
    }
}

// MARK: - Rows

/// Leaderboard row: rank, avatar with colour ring, name/@username/nickname, area (and competition extras).
struct RankRow: View {
    let item: RankingItem

    var body: some View {
        HStack(spacing: 12) {
            Text("\(item.rank)")
                .font(Font.stat(17, weight: .heavy))
                .monospacedDigit()
                .foregroundStyle(item.isMe ? Color.brand : Color.secondary)
                .frame(minWidth: 26)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            AvatarView(name: item.name, avatar: item.avatar, color: item.color, size: 44)
            nameColumn
            Spacer(minLength: 6)
            valueColumn
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background { backdrop }
        .contentShape(RoundedRectangle(cornerRadius: DS.Radius.tile + 2, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private var nameColumn: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if item.hasNickname {
                    Text("🎭 \(item.nickname ?? "")")
                        .font(.system(.body, design: .rounded, weight: .bold))
                        .foregroundStyle(Color.pink)
                        .lineLimit(1)
                } else {
                    Text(item.name)
                        .font(.system(.body, design: .rounded, weight: item.isMe ? .heavy : .semibold))
                        .lineLimit(1)
                }
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
        HStack(spacing: 6) {
            if item.stolen > 0 {
                RankingMiniChip(systemImage: "flame.fill", text: Format.area(item.stolen), tint: Color.steal)
                    .accessibilityLabel("\(Format.area(item.stolen)) robados")
            }
            if item.treasures > 0 {
                RankingMiniChip(systemImage: "gift.fill", text: "\(item.treasures)", tint: Color.gold)
                    .accessibilityLabel("\(item.treasures) tesoros")
            }
        }
        .padding(.top, 1)
    }

    private var valueColumn: some View {
        let parts = Format.areaParts(item.area)
        return VStack(alignment: .trailing, spacing: 0) {
            Text(parts.value)
                .font(Font.stat(18, weight: .heavy))
                .monospacedDigit()
                .contentTransition(.numericText())
                .lineLimit(1)
            Text(parts.unit)
                .font(.system(.caption2, design: .rounded, weight: .semibold))
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var backdrop: some View {
        let shape = RoundedRectangle(cornerRadius: DS.Radius.tile + 2, style: .continuous)
        if item.isMe {
            shape
                .fill(Color.brand.opacity(0.12))
                .background(shape.fill(Color.surface))
                .overlay(shape.strokeBorder(Color.brand.opacity(0.55), lineWidth: 1.5))
        } else {
            shape
                .fill(Color.surface)
                .overlay(shape.strokeBorder(Color.hairline, lineWidth: 1))
        }
    }
}

struct RankingMiniChip: View {
    let systemImage: String
    let text: String
    let tint: Color

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage)
                .font(.system(size: 9, weight: .bold))
            Text(text)
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .monospacedDigit()
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(tint.opacity(0.13), in: Capsule())
    }
}

// MARK: - Your position

/// "Tu posición": how far the user is from the next player up (or how far ahead when leading).
struct RankingPositionCard: View {
    let me: RankingItem
    let above: RankingItem?
    let below: RankingItem?

    var body: some View {
        HStack(spacing: 14) {
            Text("#\(me.rank)")
                .font(Font.stat(20, weight: .black))
                .monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .frame(width: 58, height: 58)
                .background(badgeGradient, in: Circle())
                .shadow(color: badgeColor.opacity(0.35), radius: 8, x: 0, y: 4)
            VStack(alignment: .leading, spacing: 3) {
                Text("Tu posición")
                    .statLabelStyle()
                Text(title)
                    .font(.system(.headline, design: .rounded, weight: .bold))
                    .fixedSize(horizontal: false, vertical: true)
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Image(systemName: above == nil ? "crown.fill" : "arrow.up.forward.circle.fill")
                .font(.title2)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(badgeColor)
        }
        .card(padding: 14)
        .accessibilityElement(children: .combine)
    }

    private var badgeColor: Color { above == nil ? Color.gold : Color.steal }

    private var badgeGradient: LinearGradient {
        above == nil ? LinearGradient.goldGradient : LinearGradient.stealGradient
    }

    private static func label(_ item: RankingItem) -> String {
        item.hasNickname ? (item.nickname ?? item.name) : item.name
    }

    private var title: String {
        guard let above else { return "¡Vas en cabeza! 👑" }
        let gap = above.area - me.area
        if gap <= 0 { return "Empate con \(Self.label(above))" }
        return "A \(Format.area(gap)) de \(Self.label(above))"
    }

    private var message: String {
        if above == nil {
            guard let below else { return "Nadie te hace sombra. De momento." }
            let lead = me.area - below.area
            if lead <= 0 { return "\(Self.label(below)) te pisa los talones." }
            return "Le sacas \(Format.area(lead)) a \(Self.label(below)). ¡Que no te lo roben!"
        }
        return "Una carrera más y le adelantas. ¡Sal a robarle terreno!"
    }
}

// MARK: - Board

/// Podium for the top 3, the user's position, then the rest as rows.
struct RankingBoardView: View {
    let items: [RankingItem]
    var showsPosition: Bool = true
    var footnote: String? = nil
    var onSelect: ((RankingItem) -> Void)? = nil

    private var rest: [RankingItem] { Array(items.dropFirst(3)) }

    var body: some View {
        VStack(spacing: DS.Spacing.l) {
            if !items.isEmpty {
                RankingPodiumCard(items: Array(items.prefix(3)), onSelect: onSelect)
            }
            if showsPosition {
                positionCard
            }
            if !rest.isEmpty {
                LazyVStack(spacing: 10) {
                    ForEach(rest) { item in
                        row(item)
                    }
                }
            }
            if let footnote {
                Text(footnote)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, DS.Spacing.l)
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

    @ViewBuilder
    private func row(_ item: RankingItem) -> some View {
        if let onSelect {
            Button {
                onSelect(item)
            } label: {
                RankRow(item: item)
            }
            .buttonStyle(PressableButtonStyle(scale: 0.98))
        } else {
            RankRow(item: item)
        }
    }
}

// MARK: - Loading

/// Placeholder podium and rows while the leaderboard loads.
struct RankingSkeleton: View {
    @State private var dim = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: DS.Spacing.l) {
            RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous)
                .fill(Color.surface)
                .frame(height: 230)
            ForEach(0..<4, id: \.self) { _ in
                RoundedRectangle(cornerRadius: DS.Radius.tile + 2, style: .continuous)
                    .fill(Color.surface)
                    .frame(height: 68)
            }
        }
        .opacity(dim ? 0.45 : 1)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                dim = true
            }
        }
        .accessibilityLabel("Cargando clasificación")
    }
}
