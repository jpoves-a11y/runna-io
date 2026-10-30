import SwiftUI
import UIKit
import WidgetKit

// Home and lock screen widgets (their views are in Shared/WidgetViews.swift):
// - Liga semanal (medium, large): your friends' week as coloured bars with their pictures.
// - Tu semana (small + lock screen): ring against the leader, km, runs and the week day by day.
// - Mi territorio (medium, large): map of the place where you run the most, with castles and zones
//   wearing away.
// - Defiende (small): the zone you need to run through soon, or your streak; opens the run screen.
// They fetch GET /api/widget/summary by themselves every ~30 minutes (Shared/WidgetData.swift).

// MARK: - Timeline

struct RunnaWidgetProvider: TimelineProvider {
    enum Extras { case none, avatars, map, focusMap }
    let extras: Extras

    func placeholder(in context: Context) -> RunnaWidgetEntry {
        RunnaWidgetEntry(date: Date(), summary: .sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (RunnaWidgetEntry) -> Void) {
        if context.isPreview {
            completion(RunnaWidgetEntry(date: Date(), summary: .sample))
            return
        }
        Task { completion(await entry(context)) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RunnaWidgetEntry>) -> Void) {
        Task {
            let entry = await entry(context)
            // Every 30 minutes (5 when it couldn't load, 3 while the server works out the map), and right
            // when the week turns over
            let wait: TimeInterval = entry.summary == nil ? 5 * 60 : entry.summary?.mapPending == true ? 3 * 60 : 30 * 60
            var next = Date().addingTimeInterval(wait)
            if let end = entry.summary?.weekEndDate, end > Date() { next = min(next, end.addingTimeInterval(60)) }
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }

    private func entry(_ context: Context) async -> RunnaWidgetEntry {
        let outcome = await WidgetDataLoader.load()
        guard let summary = outcome.summary else {
            return RunnaWidgetEntry(date: Date(), summary: nil, problem: outcome)
        }
        var entry = RunnaWidgetEntry(date: Date(), summary: summary)
        switch extras {
        case .none:
            break
        case .avatars:
            entry.avatars = await WidgetAvatars.load(summary.week.entries.map { (id: $0.id, url: $0.avatarUrl) })
        case .map:
            entry.map = await WidgetMapRenderer.render(summary, size: context.displaySize, insets: TerritoryView.mapInsets(for: context.family))
            if entry.map != nil, let place = summary.map.place {
                entry.placeName = await WidgetPlaceNames.name(for: place)
            }
        case .focusMap:
            if let point = summary.defense.atRisk {
                entry.map = await WidgetMapRenderer.render(summary, size: context.displaySize, focus: point.coordinate)
            }
        }
        return entry
    }
}

// MARK: - Widgets

struct RunnaLeagueWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RunnaLeagueWidget", provider: RunnaWidgetProvider(extras: .avatars)) { entry in
            WidgetFrame(entry: entry, url: "runnaio://tab/rankings") { summary, family in
                LeagueView(summary: summary, family: family, avatars: entry.avatars, date: entry.date)
            }
        }
        .configurationDisplayName("Liga semanal")
        .description("Lo que ha conquistado esta semana cada uno de tus amigos.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}

/// Kept as "RunnaHomeWidget" so widgets already placed keep working.
struct RunnaHomeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RunnaHomeWidget", provider: RunnaWidgetProvider(extras: .none)) { entry in
            WidgetFrame(entry: entry, url: "runnaio://tab/rankings") { summary, family in
                MyWeekView(summary: summary, family: family, date: entry.date)
            }
        }
        .configurationDisplayName("Tu semana")
        .description("Tu territorio de la semana, tu puesto y cada día de un vistazo.")
        // Medium too: the first version of this widget had it, and placed medium ones went black without it
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct RunnaTerritoryWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RunnaTerritoryWidget", provider: RunnaWidgetProvider(extras: .map)) { entry in
            WidgetFrame(entry: entry, url: "runnaio://tab/map", mapBackground: entry.map, marginsDisabled: true) { summary, family in
                TerritoryView(summary: summary, family: family, hasMap: entry.map != nil, placeName: entry.placeName)
            }
        }
        .configurationDisplayName("Mi territorio")
        .description("El mapa de la ciudad donde más corres, con tus castillos y las zonas que se desgastan.")
        .supportedFamilies([.systemMedium, .systemLarge])
        .contentMarginsDisabled()
    }
}

struct RunnaDefendWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "RunnaDefendWidget", provider: RunnaWidgetProvider(extras: .focusMap)) { entry in
            WidgetFrame(entry: entry, url: "runnaio://run", mapBackground: entry.map) { summary, _ in
                DefendView(summary: summary, date: entry.date, hasMap: entry.map != nil)
            }
        }
        .configurationDisplayName("Defiende")
        .description("La zona que tienes que pisar pronto, o tu racha. Tócalo para empezar a correr.")
        .supportedFamilies([.systemSmall])
    }
}
