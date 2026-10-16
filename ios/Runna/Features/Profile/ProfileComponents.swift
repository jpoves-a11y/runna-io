import SwiftUI
import PhotosUI

// MARK: - Own profile building blocks (prefixed `Profile` to avoid clashes)

/// Hero header of your own profile: big avatar (tap to change), name, @username, colour and actions.
struct ProfileHeroCard: View {
    let user: AppUser
    @Binding var avatarItem: PhotosPickerItem?
    let isUploadingAvatar: Bool
    let onEdit: () -> Void
    let onRemoveAvatar: () -> Void

    private var tint: Color { Color(hex: user.color) }

    var body: some View {
        VStack(spacing: DS.Spacing.m) {
            avatarPicker
            identity
            chips
            actions
                .padding(.top, 4)
        }
        .padding(.horizontal, DS.Spacing.xl)
        .padding(.top, DS.Spacing.xxl)
        .padding(.bottom, DS.Spacing.xl)
        .frame(maxWidth: .infinity)
        .background { SocialHeroBackdrop(color: tint) }
        .clipShape(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous)
                .strokeBorder(Color.hairline, lineWidth: 1)
        }
    }

    private var avatarPicker: some View {
        PhotosPicker(selection: $avatarItem, matching: .images) {
            ZStack(alignment: .bottomTrailing) {
                AvatarView(name: user.name, avatar: user.avatar, color: user.color, size: 116)
                    .shadow(color: tint.opacity(0.45), radius: 16, x: 0, y: 8)
                cameraBadge
            }
        }
        .buttonStyle(.borderless)
        .disabled(isUploadingAvatar)
        .accessibilityLabel("Cambiar foto de perfil")
    }

    private var cameraBadge: some View {
        ZStack {
            Circle().fill(.brandGradient)
            if isUploadingAvatar {
                ProgressView()
                    .controlSize(.small)
                    .tint(Color.white)
            } else {
                Image(systemName: "camera.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Color.white)
            }
        }
        .frame(width: 36, height: 36)
        .overlay(Circle().stroke(Color.surface, lineWidth: 3))
        .offset(x: 2, y: 2)
    }

    private var identity: some View {
        VStack(spacing: 3) {
            Text(user.name)
                .font(.system(.title, design: .rounded, weight: .heavy))
                .multilineTextAlignment(.center)
                .lineLimit(2)
            if !user.username.isEmpty {
                Text("@\(user.username)")
                    .font(.system(.subheadline, design: .rounded, weight: .semibold))
                    .foregroundStyle(tint)
            }
            if let email = user.email {
                Text(email)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    private var chips: some View {
        HStack(spacing: 8) {
            SocialColorChip(color: user.color)
            if let rank = user.rank {
                StatPill(value: "#\(rank)", label: "en tu crew", systemImage: "trophy.fill", tint: .gold)
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 10) {
            Button(action: onEdit) {
                SocialPillLabel(title: "Editar perfil", systemImage: "pencil", tint: .brand, kind: .filled)
            }
            .buttonStyle(.borderless)
            if user.avatar != nil {
                Button(action: onRemoveAvatar) {
                    SocialPillLabel(title: "Quitar foto", systemImage: "trash", tint: .steal, kind: .soft)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Quitar foto de perfil")
            }
        }
    }
}

/// Stat grid: territory, rank and friends; and, when there is conquest data, stolen / lost / balance.
struct ProfileStatsCard: View {
    let user: AppUser
    let conquest: ConquestStats?

    var body: some View {
        VStack(spacing: DS.Spacing.l) {
            mainRow
            if let conquest {
                Rectangle()
                    .fill(Color.hairline)
                    .frame(height: 1)
                conquestRow(conquest)
            }
        }
        .padding(.vertical, 10)
    }

    private var mainRow: some View {
        let area = Format.areaParts(user.totalArea)
        return HStack(spacing: 0) {
            StatTile(value: area.value, label: "Territorio", unit: area.unit, tint: .brand)
            separator
            StatTile(value: user.rank.map { "#\($0)" } ?? "–", label: "Ranking", tint: .gold)
            separator
            StatTile(value: "\(user.friendCount ?? 0)", label: "Amigos", tint: .sky)
        }
    }

    private func conquestRow(_ conquest: ConquestStats) -> some View {
        let stolen = Format.areaParts(conquest.totalStolen)
        let lost = Format.areaParts(conquest.totalLost)
        let net = conquest.totalStolen - conquest.totalLost
        let balance = Format.areaParts(net)
        let balanceTint: Color = net > 0 ? Color.brand : (net < 0 ? Color.steal : Color.secondary)
        return HStack(spacing: 0) {
            StatTile(value: stolen.value, label: "Has robado", unit: stolen.unit, tint: .brand)
            separator
            StatTile(value: lost.value, label: "Te han robado", unit: lost.unit, tint: .steal)
            separator
            StatTile(value: (net > 0 ? "+" : "") + balance.value, label: "Balance", unit: balance.unit, tint: balanceTint)
        }
    }

    private var separator: some View {
        Rectangle()
            .fill(Color.hairline)
            .frame(width: 1, height: 38)
    }
}

/// "Rivalidades": your nemesis (who steals the most from you), your favourite victim and the top 3 lists.
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
                    ProfileRivalCard(
                        title: "Tu némesis",
                        caption: "Te ha robado",
                        entry: nemesis,
                        systemImage: "flame.fill",
                        tint: .steal
                    )
                }
                if let victim = victims.first {
                    ProfileRivalCard(
                        title: "Tu víctima favorita",
                        caption: "Le has robado",
                        entry: victim,
                        systemImage: "crown.fill",
                        tint: .brand
                    )
                }
                if attackers.count > 1 {
                    ProfileTopList(title: "Quién te roba más", entries: attackers, tint: .steal)
                }
                if victims.count > 1 {
                    ProfileTopList(title: "Tus víctimas", entries: victims, tint: .brand)
                }
            }
            .padding(.vertical, 6)
        }
    }

    private var emptyState: some View {
        HStack(spacing: 12) {
            SocialIconTile(systemImage: "figure.fencing", tint: .steal, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text("Aún no hay piques")
                    .font(.system(.subheadline, design: .rounded, weight: .bold))
                Text("Corre por el territorio de un amigo para robárselo y que empiece la guerra.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 6)
    }
}

/// Highlighted rival: their colour avatar, a role badge and the amount.
private struct ProfileRivalCard: View {
    let title: String
    let caption: String
    let entry: ConquestStats.Entry
    let systemImage: String
    let tint: Color

    private var name: String { entry.userName.isEmpty ? "Usuario" : entry.userName }

    var body: some View {
        HStack(spacing: 14) {
            AvatarView(name: name, avatar: nil, color: entry.userColor, size: 54)
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: systemImage)
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Color.white)
                        .frame(width: 22, height: 22)
                        .background(tint.gradient, in: Circle())
                        .overlay(Circle().stroke(Color.surface, lineWidth: 2))
                        .offset(x: 3, y: 3)
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Font.statLabel)
                    .textCase(.uppercase)
                    .tracking(0.6)
                    .foregroundStyle(tint)
                Text(name)
                    .font(.system(.headline, design: .rounded, weight: .bold))
                    .lineLimit(1)
                Text("\(caption) \(Format.area(entry.amount))")
                    .font(.system(.caption, design: .rounded, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background {
            RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous)
                .fill(tint.opacity(0.10))
        }
        .overlay {
            RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous)
                .strokeBorder(tint.opacity(0.25), lineWidth: 1)
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
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(.subheadline, design: .rounded, weight: .bold))
                .padding(.top, 4)
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                row(index: index, entry: entry)
            }
        }
    }

    private func row(index: Int, entry: ConquestStats.Entry) -> some View {
        HStack(spacing: 10) {
            Text("\(index + 1)")
                .font(.system(.caption, design: .rounded, weight: .heavy))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(width: 20, height: 20)
                .background(Color.surfaceRaised, in: Circle())
            Circle()
                .fill(Color(hex: entry.userColor))
                .frame(width: 10, height: 10)
            Text(entry.userName.isEmpty ? "Usuario" : entry.userName)
                .font(.subheadline)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(Format.area(entry.amount))
                .font(.system(.subheadline, design: .rounded, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(tint)
        }
        .accessibilityElement(children: .combine)
    }
}
