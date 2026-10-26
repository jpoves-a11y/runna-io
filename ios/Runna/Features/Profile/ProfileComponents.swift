import SwiftUI
import PhotosUI

// MARK: - Own profile building blocks (prefixed `Profile` to avoid clashes)

/// Header of your own profile: avatar (tap to change photo), name, @username, colour and
/// an "Editar perfil" button. Flat, on the canvas — no tinted hero.
struct ProfileHeroCard: View {
    let user: AppUser
    @Binding var avatarItem: PhotosPickerItem?
    let isUploadingAvatar: Bool
    let onEdit: () -> Void
    let onRemoveAvatar: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.l) {
            HStack(alignment: .center, spacing: DS.Spacing.l) {
                avatarPicker
                identity
                Spacer(minLength: 0)
            }
            actions
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var avatarPicker: some View {
        PhotosPicker(selection: $avatarItem, matching: .images) {
            ZStack(alignment: .bottomTrailing) {
                AvatarView(name: user.name, avatar: user.avatar, color: user.color, size: 76)
                cameraBadge
            }
        }
        .buttonStyle(.borderless)
        .disabled(isUploadingAvatar)
        .accessibilityLabel("Cambiar foto de perfil")
    }

    private var cameraBadge: some View {
        ZStack {
            Circle().fill(Color.surface)
            Circle().strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline)
            if isUploadingAvatar {
                ProgressView()
                    .controlSize(.mini)
            } else {
                Image(systemName: "camera")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.primary)
            }
        }
        .frame(width: 26, height: 26)
        .offset(x: 2, y: 2)
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(user.name)
                .font(.title2.weight(.bold))
                .tracking(DS.Tracking.title)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
            if !user.username.isEmpty {
                Text("@\(user.username)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            SocialColorChip(color: user.color)
                .padding(.top, 2)
            if let email = user.email {
                Text(email)
                    .font(Font.meta)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
    }

    private var actions: some View {
        HStack(spacing: DS.Spacing.s) {
            Button(action: onEdit) {
                SocialPillLabel(title: "Editar perfil", tint: .primary, kind: .soft, expand: true)
            }
            .buttonStyle(.borderless)
            if user.avatar != nil {
                Button(action: onRemoveAvatar) {
                    SocialPillLabel(title: "Quitar foto", tint: .primary, kind: .soft, expand: true)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Quitar foto de perfil")
            }
        }
    }
}

/// Stat grid: territory, rank and friends; and, when there is conquest data, stolen / lost / balance.
/// Condensed figures, hairline dividers, labels under values.
struct ProfileStatsCard: View {
    let user: AppUser
    let conquest: ConquestStats?

    var body: some View {
        VStack(spacing: DS.Spacing.l) {
            mainRow
            if let conquest {
                HairlineDivider()
                    .padding(.horizontal, DS.Spacing.s)
                conquestRow(conquest)
            }
        }
        .padding(.vertical, DS.Spacing.s)
    }

    private var mainRow: some View {
        let area = Format.areaParts(user.totalArea)
        let rankTint: Color = user.rank == 1 ? Color.gold : Color.primary
        return HStack(spacing: 0) {
            StatTile(value: area.value, label: "Territorio", unit: area.unit, tint: .brand)
            StatDivider()
            StatTile(value: user.rank.map { "#\($0)" } ?? "–", label: "Ranking", tint: rankTint)
            StatDivider()
            StatTile(value: "\(user.friendCount ?? 0)", label: "Amigos")
        }
    }

    private func conquestRow(_ conquest: ConquestStats) -> some View {
        let stolen = Format.areaParts(conquest.totalStolen)
        let lost = Format.areaParts(conquest.totalLost)
        let net = conquest.totalStolen - conquest.totalLost
        let balance = Format.areaParts(net)
        let balanceTint: Color = net < 0 ? Color.steal : Color.primary
        return HStack(spacing: 0) {
            StatTile(value: stolen.value, label: "Robado", unit: stolen.unit)
            StatDivider()
            StatTile(value: lost.value, label: "Perdido", unit: lost.unit, tint: .steal)
            StatDivider()
            StatTile(value: (net > 0 ? "+" : "") + balance.value, label: "Balance", unit: balance.unit, tint: balanceTint)
        }
    }
}

/// "Rivalidades": who steals the most from you, who you steal the most from, and the top 3 lists.
struct ProfileRivalriesContent: View {
    let conquest: ConquestStats

    private var attackers: [ConquestStats.Entry] {
        Array(conquest.lostToUser.filter { $0.amount > 0 }.sorted { $0.amount > $1.amount }.prefix(3))
    }

    private var victims: [ConquestStats.Entry] {
        Array(conquest.stolenByUser.filter { $0.amount > 0 }.sorted { $0.amount > $1.amount }.prefix(3))
    }

    var body: some View {
        if attackers.isEmpty && victims.isEmpty {
            emptyState
        } else {
            VStack(alignment: .leading, spacing: DS.Spacing.m) {
                if let nemesis = attackers.first {
                    ProfileRivalCard(title: "Quien más te roba", entry: nemesis, amountTint: .steal)
                }
                if attackers.first != nil && victims.first != nil {
                    HairlineDivider()
                }
                if let victim = victims.first {
                    ProfileRivalCard(title: "A quien más robas", entry: victim, amountTint: .primary)
                }
                if attackers.count > 1 {
                    HairlineDivider()
                    ProfileTopList(title: "Te roban", entries: attackers, tint: .steal)
                }
                if victims.count > 1 {
                    HairlineDivider()
                    ProfileTopList(title: "Les robas", entries: victims, tint: .primary)
                }
            }
            .padding(.vertical, DS.Spacing.xs)
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Sin rivalidades todavía")
                .font(.subheadline.weight(.semibold))
            Text("Corre por el territorio de un amigo para robárselo.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, DS.Spacing.xs)
    }
}

/// Highlighted rival: avatar with their colour, a small label, the name and the amount right-aligned.
private struct ProfileRivalCard: View {
    let title: String
    let entry: ConquestStats.Entry
    let amountTint: Color

    private var name: String { entry.userName.isEmpty ? "Usuario" : entry.userName }

    var body: some View {
        let parts = Format.areaParts(entry.amount)
        return HStack(spacing: DS.Spacing.m) {
            AvatarView(name: name, avatar: nil, color: entry.userColor, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .statLabelStyle()
                Text(name)
                    .font(.body.weight(.semibold))
                    .lineLimit(1)
            }
            Spacer(minLength: DS.Spacing.s)
            StatValue(value: parts.value, unit: parts.unit, font: Font.stat(19, weight: .semibold), tint: amountTint)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Top-3 list (victims / attackers).
private struct ProfileTopList: View {
    let title: String
    let entries: [ConquestStats.Entry]
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Text(title)
                .statLabelStyle()
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                row(index: index, entry: entry)
            }
        }
    }

    private func row(index: Int, entry: ConquestStats.Entry) -> some View {
        HStack(spacing: 10) {
            Text("\(index + 1)")
                .font(.footnote.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .frame(width: 16, alignment: .leading)
            Circle()
                .fill(Color(hex: entry.userColor))
                .frame(width: 8, height: 8)
            Text(entry.userName.isEmpty ? "Usuario" : entry.userName)
                .font(.subheadline)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(Format.area(entry.amount))
                .font(.subheadline.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(tint)
        }
        .accessibilityElement(children: .combine)
    }
}
