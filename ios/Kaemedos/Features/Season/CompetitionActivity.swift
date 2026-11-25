import SwiftUI

/// "Actividad" of my competition, under its banner: every power activated and every steal, newest
/// first (in Duelo and Derbi, of both clubs). The last three are shown; the rest, folded.
/// A trap (Bomba Temporal, Emboscada) shows only that there is one, until somebody falls in it.
struct CompetitionActivityCard: View {
    @Environment(AppRouter.self) private var router
    @State private var events: [CompetitionActivityEvent] = []
    @State private var hasLoaded = false
    @State private var expanded = false
    @State private var report: CompetitionActivityEvent?

    /// Shown without unfolding
    private static let latest = 3

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Actividad", subtitle: "Poderes y robos de la competición")
            VStack(spacing: 0) {
                if events.isEmpty {
                    Text(hasLoaded ? "Aún no ha pasado nada. El primero en activar un poder o robar sale aquí." : "Cargando…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, DS.Spacing.s)
                } else {
                    ForEach(Array(visible.enumerated()), id: \.element.id) { index, event in
                        if index > 0 { HairlineDivider().padding(.leading, 44) }
                        ActivityEventRow(event: event) { report = event }
                    }
                    if events.count > Self.latest {
                        HairlineDivider()
                        Button {
                            Haptics.tap()
                            withAnimation(.snappy) { expanded.toggle() }
                        } label: {
                            HStack {
                                Text(expanded ? "Ver menos" : "Ver toda la actividad (\(events.count - Self.latest) más)")
                                    .font(.subheadline.weight(.medium))
                                Spacer()
                                Image(systemName: "chevron.down")
                                    .font(.footnote.weight(.semibold))
                                    .rotationEffect(.degrees(expanded ? 180 : 0))
                            }
                            .foregroundStyle(Color.brand)
                            .padding(.vertical, DS.Spacing.s)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .card(padding: DS.Spacing.m)
        }
        .task(id: router.reloadSignal) { await load() }
        .task {
            // While on screen, it keeps itself up to date
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60 * 1_000_000_000)
                await load()
            }
        }
        .sheet(item: $report) { event in
            ReportSheet(targetType: "nickname", targetId: event.reportNicknameId ?? event.id, reportedUserId: event.reportUserId)
        }
    }

    private var visible: [CompetitionActivityEvent] {
        expanded ? events : Array(events.prefix(Self.latest))
    }

    private func load() async {
        if let response: CompetitionActivityResponse = try? await APIClient.shared.request("GET", "/api/season/activity") {
            withAnimation(.snappy) { events = response.events }
        }
        hasLoaded = true
    }
}

private struct ActivityEventRow: View {
    let event: CompetitionActivityEvent
    let onReport: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: DS.Spacing.m) {
            icon
                .frame(width: 32, height: 32)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.text)
                    .font(.subheadline)
                    .fontWeight(event.aboutMe ? .semibold : .regular)
                    .fixedSize(horizontal: false, vertical: true)
                Text(Format.relative(event.date))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if event.reportNicknameId != nil {
                Menu {
                    Button(role: .destructive, action: onReport) {
                        Label("Denunciar apodo", systemImage: "exclamationmark.bubble")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Opciones del apodo")
            }
        }
        .padding(.vertical, DS.Spacing.s)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var icon: some View {
        if let itemId = event.itemId, UIImage(named: "power_\(itemId)") != nil {
            PowerArt(itemId: itemId, rarity: "common", size: 30, glow: false)
        } else {
            Text(event.emoji)
                .font(.title3)
        }
    }
}

/// A card that starts folded: its title (and a hint of what's inside) until tapped. For the less
/// important parts of a screen (the members of the club, its history).
struct FoldedSection<Preview: View, Content: View>: View {
    let title: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    @ViewBuilder let preview: () -> Preview
    @ViewBuilder let content: () -> Content

    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: title, actionTitle: actionTitle, action: action)
            VStack(spacing: 0) {
                Button {
                    Haptics.tap()
                    withAnimation(.snappy) { expanded.toggle() }
                } label: {
                    HStack(spacing: DS.Spacing.m) {
                        preview()
                        Spacer(minLength: 0)
                        Text(expanded ? "Ocultar" : "Ver")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Color.brand)
                        Image(systemName: "chevron.down")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Color.brand)
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                    .padding(.vertical, DS.Spacing.xs)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if expanded {
                    HairlineDivider()
                        .padding(.vertical, DS.Spacing.s)
                    content()
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .card(padding: DS.Spacing.m)
        }
    }
}
