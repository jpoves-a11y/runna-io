import SwiftUI
import UIKit
import WidgetKit

// Home screen / lock screen widget: this week's territory, your position among friends,
// the total and a nudge when you haven't run for a few days.

struct RunnaHomeEntry: TimelineEntry {
    let date: Date
    let snapshot: RunnaWidgetSnapshot?
}

struct RunnaHomeProvider: TimelineProvider {
    func placeholder(in context: Context) -> RunnaHomeEntry {
        RunnaHomeEntry(date: Date(), snapshot: Self.sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (RunnaHomeEntry) -> Void) {
        completion(RunnaHomeEntry(date: Date(), snapshot: WidgetSnapshotStore.load() ?? Self.sample))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RunnaHomeEntry>) -> Void) {
        let now = Date()
        let entry = RunnaHomeEntry(date: now, snapshot: WidgetSnapshotStore.load())
        // The app reloads the widget when its data changes; besides, redraw when the week turns over
        // (the week's figures go back to zero) or in an hour (the "days without running" line).
        let nextWeek = RunnaWidgetSnapshot.weekStart(of: now).addingTimeInterval(7 * 24 * 3600 + 60)
        let next = min(nextWeek, now.addingTimeInterval(3600))
        completion(Timeline(entries: [entry], policy: .after(next)))
    }

    static let sample = RunnaWidgetSnapshot(
        name: "Runna",
        colorHex: "#16A34A",
        totalArea: 1_250_000,
        weekStart: RunnaWidgetSnapshot.weekStart(of: Date()),
        weekArea: 182_000,
        weekDistance: 14_200,
        weekRuns: 3,
        weekRank: 2,
        weekPlayers: 6,
        weekLeaderName: "Ana",
        lastRunAt: Date().addingTimeInterval(-86_400)
    )
}

struct RunnaHomeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RunnaHomeWidget", provider: RunnaHomeProvider()) { entry in
            RunnaHomeWidgetView(entry: entry)
                .containerBackground(for: .widget) { Color(uiColor: .systemBackground) }
        }
        .configurationDisplayName("Tu territorio")
        .description("Lo que has conquistado esta semana y tu puesto entre tus amigos.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

private struct RunnaHomeWidgetView: View {
    let entry: RunnaHomeEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        if let snapshot = entry.snapshot {
            switch family {
            case .systemMedium: medium(snapshot)
            case .accessoryRectangular: rectangular(snapshot)
            default: small(snapshot)
            }
        } else {
            empty
        }
    }

    // MARK: Pieces

    private var empty: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Runna.io", systemImage: "flag.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Text("Abre Runna.io para ver tu territorio aquí.")
                .font(.footnote.weight(.medium))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func header(_ snapshot: RunnaWidgetSnapshot) -> some View {
        HStack(spacing: 5) {
            Image(systemName: "flag.fill")
                .foregroundStyle(color(snapshot))
            Text("Esta semana")
                .foregroundStyle(.secondary)
        }
        .font(.caption.weight(.semibold))
        .lineLimit(1)
    }

    private func weekArea(_ snapshot: RunnaWidgetSnapshot, size: CGFloat) -> some View {
        let area = week(snapshot) ? snapshot.weekArea : 0
        return Text(area > 0 ? "+\(RunnaWidgetSnapshot.areaText(area))" : "Sin conquistas")
            .font(.system(size: area > 0 ? size : size * 0.62, weight: .semibold).width(.condensed))
            .foregroundStyle(area > 0 ? color(snapshot) : Color.primary)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
    }

    private func rankLine(_ snapshot: RunnaWidgetSnapshot) -> String? {
        guard week(snapshot), let rank = snapshot.weekRank, snapshot.weekPlayers > 1 else { return nil }
        if rank == 1 { return "1.º de \(snapshot.weekPlayers) amigos" }
        if let leader = snapshot.weekLeaderName { return "\(rank).º · lidera \(leader)" }
        return "\(rank).º de \(snapshot.weekPlayers)"
    }

    private func distanceLine(_ snapshot: RunnaWidgetSnapshot) -> String {
        guard week(snapshot), snapshot.weekRuns > 0 else { return "0 km esta semana" }
        let runs = snapshot.weekRuns == 1 ? "1 carrera" : "\(snapshot.weekRuns) carreras"
        return "\(RunnaWidgetSnapshot.distanceText(snapshot.weekDistance)) · \(runs)"
    }

    /// "Hoy has corrido" / "Hace 4 días que no corres" (nil when unknown).
    private func lastRunLine(_ snapshot: RunnaWidgetSnapshot) -> String? {
        guard let last = snapshot.lastRunAt else { return nil }
        let calendar = Calendar.current
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: last), to: calendar.startOfDay(for: entry.date)).day ?? 0
        switch days {
        case ..<1: return "Hoy has corrido"
        case 1: return "Corriste ayer"
        default: return "Hace \(days) días que no corres"
        }
    }

    // MARK: Families

    private func small(_ snapshot: RunnaWidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            header(snapshot)
            Spacer(minLength: 0)
            weekArea(snapshot, size: 30)
            if let rank = rankLine(snapshot) {
                Text(rank)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
            Text(distanceLine(snapshot))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func medium(_ snapshot: RunnaWidgetSnapshot) -> some View {
        HStack(alignment: .top, spacing: 16) {
            small(snapshot)
            VStack(alignment: .leading, spacing: 4) {
                Text("Total")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(RunnaWidgetSnapshot.areaText(snapshot.totalArea))
                    .font(.system(size: 22, weight: .semibold).width(.condensed))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Spacer(minLength: 0)
                if let line = lastRunLine(snapshot) {
                    Text(line)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(line.hasPrefix("Hace") ? Color.orange : Color.secondary)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private func rectangular(_ snapshot: RunnaWidgetSnapshot) -> some View {
        let area = week(snapshot) ? snapshot.weekArea : 0
        return VStack(alignment: .leading, spacing: 1) {
            Label("Runna · semana", systemImage: "flag.fill")
                .font(.caption2.weight(.semibold))
            Text(area > 0 ? "+\(RunnaWidgetSnapshot.areaText(area))" : "Sin conquistas")
                .font(.headline)
                .lineLimit(1)
            Text(rankLine(snapshot) ?? distanceLine(snapshot))
                .font(.caption2)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Helpers

    private func week(_ snapshot: RunnaWidgetSnapshot) -> Bool {
        snapshot.isCurrentWeek(at: entry.date)
    }

    private func color(_ snapshot: RunnaWidgetSnapshot) -> Color {
        let digits = snapshot.colorHex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return .green }
        return Color(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}
