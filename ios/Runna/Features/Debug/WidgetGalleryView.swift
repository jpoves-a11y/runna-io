#if DEBUG
import SwiftUI
import WidgetKit

/// Every widget drawn by the app at its real size, with the logged-in user's data (the same views and map
/// renderer as the RunnaLive extension, from Shared). Opened by runnaio://widgets/<page> for the CI
/// screenshots: it's the only way to see the widgets without a phone.
struct WidgetGalleryView: View {
    let page: Int

    @State private var summary: WidgetSummary?
    @State private var avatars: [String: UIImage] = [:]
    @State private var maps: [String: UIImage] = [:]
    @State private var placeName: String?
    @State private var failure: String?

    init(page: Int) {
        self.page = page
    }

    private static let small = CGSize(width: 170, height: 170)
    private static let medium = CGSize(width: 364, height: 170)
    private static let large = CGSize(width: 364, height: 382)

    var body: some View {
        ZStack {
            // A dark wallpaper, like a home screen
            LinearGradient(colors: [Color(white: 0.16), Color(white: 0.06)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            if let summary {
                ScrollView {
                    VStack(spacing: 14) {
                        content(summary)
                    }
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity)
                }
            } else if let failure {
                Text(failure)
                    .foregroundStyle(Color.white)
                    .padding()
            } else {
                ProgressView()
                    .tint(Color.white)
            }
        }
        .task { await load() }
    }

    @ViewBuilder
    private func content(_ summary: WidgetSummary) -> some View {
        switch page {
        case 2:
            widget(summary, size: Self.large, family: .systemLarge) { summary, family in
                LeagueView(summary: summary, family: family, avatars: avatars, date: Date())
            }
            widget(summary, size: Self.medium, family: .systemMedium) { summary, family in
                LeagueView(summary: summary, family: family, avatars: avatars, date: Date())
            }
            widget(summary, size: Self.medium, family: .systemMedium) { summary, family in
                MyWeekView(summary: summary, family: family, date: Date())
            }
        case 3:
            HStack(spacing: 14) {
                widget(summary, size: Self.small, family: .systemSmall) { summary, family in
                    MyWeekView(summary: summary, family: family, date: Date())
                }
                widget(summary, size: Self.small, family: .systemSmall, map: maps["defend"]) { summary, _ in
                    DefendView(summary: summary, date: Date(), hasMap: maps["defend"] != nil)
                }
            }
            lockScreen(summary)
        default:
            widget(summary, size: Self.large, family: .systemLarge, map: maps["large"], marginsDisabled: true) { summary, family in
                TerritoryView(summary: summary, family: family, hasMap: maps["large"] != nil, placeName: placeName)
            }
            widget(summary, size: Self.medium, family: .systemMedium, map: maps["medium"], marginsDisabled: true) { summary, family in
                TerritoryView(summary: summary, family: family, hasMap: maps["medium"] != nil, placeName: placeName)
            }
            Text(caption(summary))
                .font(.caption.monospaced())
                .foregroundStyle(Color.white.opacity(0.7))
                .padding(.horizontal)
        }
    }

    /// One widget at its size, clipped like on the home screen.
    private func widget<Content: View>(
        _ summary: WidgetSummary,
        size: CGSize,
        family: WidgetFamily,
        map: UIImage? = nil,
        marginsDisabled: Bool = false,
        @ViewBuilder content: @escaping (WidgetSummary, WidgetFamily) -> Content
    ) -> some View {
        let entry = RunnaWidgetEntry(date: Date(), summary: summary, avatars: avatars, map: map, placeName: placeName)
        return WidgetFrame(entry: entry, url: "", mapBackground: map, preview: family, marginsDisabled: marginsDisabled, content: content)
            .frame(width: size.width, height: size.height)
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    /// The lock screen widgets in white over a dark background, as iOS draws them.
    private func lockScreen(_ summary: WidgetSummary) -> some View {
        VStack(spacing: 10) {
            WidgetFrame(entry: RunnaWidgetEntry(date: Date(), summary: summary), url: "", preview: .accessoryInline) { summary, family in
                MyWeekView(summary: summary, family: family, date: Date())
            }
            .frame(width: 257, height: 26)
            HStack(spacing: 14) {
                WidgetFrame(entry: RunnaWidgetEntry(date: Date(), summary: summary), url: "", preview: .accessoryCircular) { summary, family in
                    MyWeekView(summary: summary, family: family, date: Date())
                }
                .frame(width: 76, height: 76)
                WidgetFrame(entry: RunnaWidgetEntry(date: Date(), summary: summary), url: "", preview: .accessoryRectangular) { summary, family in
                    MyWeekView(summary: summary, family: family, date: Date())
                }
                .frame(width: 172, height: 76)
            }
        }
        .foregroundStyle(Color.white)
        .padding(16)
        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    /// What the server sent for the map, to check the framing in the screenshot.
    private func caption(_ summary: WidgetSummary) -> String {
        var lines: [String] = []
        if let box = summary.map.bbox, box.count == 4 {
            lines.append(String(format: "bbox %.3f,%.3f → %.3f,%.3f", box[0], box[1], box[2], box[3]))
        }
        if let place = summary.map.place {
            lines.append("place \(placeName ?? "?") · \(WStyle.area(place.area)) · \(place.zones) zonas")
        }
        if let elsewhere = summary.map.elsewhere {
            lines.append("elsewhere \(elsewhere.places) · \(WStyle.area(elsewhere.area))")
        }
        return lines.joined(separator: "\n")
    }

    private func load() async {
        do {
            var fetched: WidgetSummary = try await APIClient.shared.request("GET", "/api/widget/summary")
            // The server works the map out in its queue: ask again like the widgets do
            var attempts = 0
            while fetched.mapPending == true && attempts < 5 {
                attempts += 1
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                fetched = try await APIClient.shared.request("GET", "/api/widget/summary")
            }
            avatars = await WidgetAvatars.load(fetched.week.entries.map { (id: $0.id, url: $0.avatarUrl) })
            if let place = fetched.map.place {
                placeName = await WidgetPlaceNames.name(for: place)
            }
            var rendered: [String: UIImage] = [:]
            rendered["large"] = await WidgetMapRenderer.render(fetched, size: Self.large, insets: TerritoryView.mapInsets(for: .systemLarge))
            rendered["medium"] = await WidgetMapRenderer.render(fetched, size: Self.medium, insets: TerritoryView.mapInsets(for: .systemMedium))
            if let point = fetched.defense.atRisk {
                rendered["defend"] = await WidgetMapRenderer.render(fetched, size: Self.small, focus: point.coordinate)
            }
            maps = rendered
            summary = fetched
        } catch {
            failure = "No se ha podido cargar /api/widget/summary: \(error.localizedDescription)"
        }
    }
}
#endif
