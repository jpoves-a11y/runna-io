import SwiftUI
import MapKit
import AVFoundation

// MARK: - What the video shows

/// Titles and figures drawn over the map in the shared video (all editable before making it).
struct RouteShareOptions: Equatable {
    var title: String
    var date: Date?
    /// m² conquered with the run (nil hides it)
    var area: Double?
    var showsTitle = true
    var showsDate = true
    var showsDistance = true
    var showsTime = true
    var showsPace = true
    var showsArea = true
    var showsBrand = true
    /// Big summary card when the runner reaches the finish.
    var showsEndCard = true
}

/// Shape of the video.
enum RouteShareFormat: String, CaseIterable, Identifiable {
    case story, post, square

    var id: String { rawValue }

    var title: String {
        switch self {
        case .story: return "Historia"
        case .post: return "Post"
        case .square: return "Cuadrado"
        }
    }

    /// width / height
    var aspect: CGFloat {
        switch self {
        case .story: return 9.0 / 16.0
        case .post: return 4.0 / 5.0
        case .square: return 1
        }
    }

    /// Pixel size of the exported video.
    var videoSize: CGSize {
        switch self {
        case .story: return CGSize(width: 1080, height: 1920)
        case .post: return CGSize(width: 1080, height: 1350)
        case .square: return CGSize(width: 1080, height: 1080)
        }
    }
}

// MARK: - Overlay drawn over the map

/// Title, live counters and the final card of the shared video. Sizes follow the frame's width,
/// so the preview and the video look the same.
struct RouteShareOverlay: View {
    let options: RouteShareOptions
    /// 0...1 of the route run so far
    let fraction: Double
    let isFinished: Bool
    /// metres and seconds of the whole run
    let distance: Double
    let duration: Int?
    /// 0...1: how far the end card has come in. The video sets it frame by frame (SwiftUI doesn't
    /// animate there); on screen it stays 1 and the card comes in with its transition.
    var endCardReveal: Double = 1

    /// Everything that changes from frame to frame (counters, end card): the video draws the overlay
    /// again only when it changes.
    var renderKey: String {
        let values = counterItems(live: !isFinished).map(\.value).joined(separator: "|")
        return "\(values)|\(isFinished)|\(Int((endCardReveal * 100).rounded()))"
    }

    private var paceText: String? {
        guard let duration, duration > 0, distance >= 50 else { return nil }
        return Format.pace(distanceMeters: distance, seconds: duration).replacingOccurrences(of: " /km", with: "")
    }

    var body: some View {
        GeometryReader { geometry in
            let unit = geometry.size.width / 360
            ZStack {
                // Shades so white text reads over any map
                VStack(spacing: 0) {
                    LinearGradient(colors: [Color.black.opacity(0.55), Color.black.opacity(0)], startPoint: .top, endPoint: .bottom)
                        .frame(height: 150 * unit)
                    Spacer(minLength: 0)
                    LinearGradient(colors: [Color.black.opacity(0), Color.black.opacity(0.6)], startPoint: .top, endPoint: .bottom)
                        .frame(height: 170 * unit)
                }
                VStack(alignment: .leading, spacing: 0) {
                    header(unit: unit)
                    Spacer(minLength: 0)
                    if isFinished && options.showsEndCard {
                        endCard(unit: unit)
                            .scaleEffect(0.9 + 0.1 * endCardReveal)
                            .opacity(endCardReveal)
                            .frame(maxWidth: .infinity)
                            .transition(.scale(scale: 0.9).combined(with: .opacity))
                        Spacer(minLength: 0)
                    }
                    counters(unit: unit)
                }
                .padding(18 * unit)
            }
            .foregroundStyle(Color.white)
            .animation(.spring(response: 0.5, dampingFraction: 0.8), value: isFinished)
        }
        .allowsHitTesting(false)
    }

    @ViewBuilder
    private func header(unit: CGFloat) -> some View {
        HStack(alignment: .top, spacing: 8 * unit) {
            VStack(alignment: .leading, spacing: 3 * unit) {
                if options.showsTitle, !options.title.isEmpty {
                    Text(options.title)
                        .font(.system(size: 22 * unit, weight: .bold))
                        .lineLimit(2)
                        .minimumScaleFactor(0.7)
                }
                if options.showsDate, let date = options.date {
                    Text(Format.dayAndTime(date))
                        .font(.system(size: 13 * unit, weight: .medium))
                        .opacity(0.85)
                }
            }
            .shadow(color: .black.opacity(0.4), radius: 4 * unit, y: 1)
            Spacer(minLength: 0)
            if options.showsBrand {
                ShareBrandMark(unit: unit)
            }
        }
    }

    @ViewBuilder
    private func counters(unit: CGFloat) -> some View {
        let items = counterItems(live: !isFinished)
        if !items.isEmpty {
            HStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    if index > 0 {
                        Rectangle()
                            .fill(Color.white.opacity(0.3))
                            .frame(width: 1, height: 30 * unit)
                    }
                    VStack(spacing: 2 * unit) {
                        Text(item.value)
                            .font(.system(size: 24 * unit, weight: .bold).width(.condensed))
                            .monospacedDigit()
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)
                        Text(item.label.uppercased())
                            .font(.system(size: 10 * unit, weight: .semibold))
                            .tracking(0.8)
                            .opacity(0.8)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(.vertical, 12 * unit)
            .background(Color.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 16 * unit, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16 * unit, style: .continuous).stroke(Color.white.opacity(0.15), lineWidth: 1))
        }
    }

    private struct CounterItem {
        let value: String
        let label: String
    }

    /// Distance and time count up with the runner; pace and territory are for the whole run.
    private func counterItems(live: Bool) -> [CounterItem] {
        let shown = live ? fraction : 1
        var items: [CounterItem] = []
        if options.showsDistance {
            items.append(CounterItem(value: Format.distance(distance * shown), label: "Distancia"))
        }
        if options.showsTime, let duration {
            items.append(CounterItem(value: Format.duration(Int((Double(duration) * shown).rounded())), label: "Tiempo"))
        }
        if options.showsPace, let paceText {
            items.append(CounterItem(value: paceText, label: "Ritmo /km"))
        }
        if options.showsArea, isFinished, !options.showsEndCard, let area = options.area, area > 0 {
            items.append(CounterItem(value: "+\(Format.area(area))", label: "Territorio"))
        }
        return items
    }

    @ViewBuilder
    private func endCard(unit: CGFloat) -> some View {
        VStack(spacing: 10 * unit) {
            Text(Format.distance(distance))
                .font(.system(size: 52 * unit, weight: .heavy).width(.condensed))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            HStack(spacing: 18 * unit) {
                if let duration {
                    endFigure(Format.duration(duration), label: "Tiempo", unit: unit)
                }
                if let paceText {
                    endFigure(paceText, label: "Ritmo /km", unit: unit)
                }
            }
            if options.showsArea, let area = options.area, area > 0 {
                HStack(spacing: 6 * unit) {
                    Image(systemName: "flag.fill")
                    Text("+\(Format.area(area)) conquistados")
                }
                .font(.system(size: 15 * unit, weight: .bold))
                .padding(.horizontal, 14 * unit)
                .padding(.vertical, 7 * unit)
                .background(Color.brand, in: Capsule())
            }
        }
        .padding(.horizontal, 26 * unit)
        .padding(.vertical, 22 * unit)
        .background(Color.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 24 * unit, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24 * unit, style: .continuous).stroke(Color.white.opacity(0.18), lineWidth: 1))
    }

    private func endFigure(_ value: String, label: String, unit: CGFloat) -> some View {
        VStack(spacing: 2 * unit) {
            Text(value)
                .font(.system(size: 22 * unit, weight: .bold).width(.condensed))
                .monospacedDigit()
            Text(label.uppercased())
                .font(.system(size: 10 * unit, weight: .semibold))
                .tracking(0.8)
                .opacity(0.8)
        }
    }
}

/// Watermark: a small brand tile with a runner and "runna.io" in a light rounded type, no box behind
/// it; a soft shadow keeps it readable over any map.
private struct ShareBrandMark: View {
    let unit: CGFloat

    var body: some View {
        HStack(spacing: 6 * unit) {
            RoundedRectangle(cornerRadius: 4.5 * unit, style: .continuous)
                .fill(LinearGradient(colors: [Color.brandLime, Color.brand], startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 17 * unit, height: 17 * unit)
                .overlay {
                    Image(systemName: "figure.run")
                        .font(.system(size: 10 * unit, weight: .semibold))
                        .foregroundStyle(Color.white)
                }
            HStack(spacing: 0) {
                Text("runna")
                    .font(.system(size: 15 * unit, weight: .semibold, design: .rounded))
                Text(".io")
                    .font(.system(size: 15 * unit, weight: .regular, design: .rounded))
                    .opacity(0.7)
            }
            .tracking(0.3 * unit)
        }
        .foregroundStyle(Color.white)
        .shadow(color: .black.opacity(0.45), radius: 6 * unit, y: 1 * unit)
        .opacity(0.95)
        .accessibilityLabel("Runna.io")
    }
}

// MARK: - Editor

/// Share a run as a video: choose the format, 2D/3D, map, speed, colour and what is shown, watch the
/// preview, then make the video. It isn't recorded from the screen: it's made frame by frame behind
/// a progress screen (`RouteVideoRenderer`), with the map loaded first, and saved to Photos on its
/// own; then it can be shared.
struct RouteShareEditor: View {
    let coordinates: [CLLocationCoordinate2D]
    let distance: Double
    let duration: Int?
    /// The owner's colour (offered first).
    let ownerColor: Color
    /// Whose flag runs the route (nil: the signed-in user).
    let runner: ReplayRunner?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.displayScale) private var displayScale
    @Environment(\.colorScheme) private var colorScheme
    @Environment(SessionStore.self) private var session: SessionStore?

    @AppStorage("shareFormat") private var formatRaw = RouteShareFormat.story.rawValue
    @State private var config: RouteReplayConfig
    @State private var options: RouteShareOptions
    @State private var colorIndex = 0
    @State private var restartToken = 0
    @State private var phase: Phase = .editing
    @State private var renderer: RouteVideoRenderer?
    @State private var renderTask: Task<Void, Never>?
    @State private var errorMessage: String?

    private enum Phase: Equatable {
        case editing
        case rendering
        case done(URL, SaveResult)
    }

    /// What happened when saving the video to Photos.
    private enum SaveResult: Equatable {
        case saved
        case noPermission
        case failed
    }

    init(coordinates: [CLLocationCoordinate2D], distance: Double, duration: Int?, title: String, date: Date?, area: Double?, color: Color, runner: ReplayRunner? = nil) {
        self.coordinates = coordinates
        self.distance = distance
        self.duration = duration
        self.ownerColor = color
        self.runner = runner
        _config = State(initialValue: RouteReplayConfig(
            mode: RouteReplayMode(rawValue: UserDefaults.standard.string(forKey: "routeReplayMode") ?? "") ?? .threeD,
            satellite: UserDefaults.standard.object(forKey: "routeReplaySatellite") as? Bool ?? true,
            speed: 1
        ))
        _options = State(initialValue: RouteShareOptions(title: title, date: date, area: area))
    }

    private var format: RouteShareFormat { RouteShareFormat(rawValue: formatRaw) ?? .story }

    /// The flag's runner: the one given, else the signed-in user.
    private var flagRunner: ReplayRunner {
        if let runner { return runner }
        if let user = session?.user { return ReplayRunner(user: user) }
        return ReplayRunner(name: "", avatar: nil, color: "#16A34A")
    }

    private var palette: [Color] { [ownerColor, .brand, .white, .gold, .steal, .sky, .grape] }
    private var routeColor: Color { palette[min(colorIndex, palette.count - 1)] }

    var body: some View {
        ZStack {
            Color.canvas.ignoresSafeArea()
            VStack(spacing: 0) {
                topBar
                stage
                    .padding(.horizontal, DS.Spacing.l)
                    .padding(.vertical, DS.Spacing.s)
                bottomPanel
            }
        }
        .animation(.snappy, value: phase)
        .errorAlert($errorMessage)
        .onDisappear {
            renderTask?.cancel()
        }
    }

    // MARK: Top bar

    private var topBar: some View {
        ZStack {
            Text(barTitle)
                .font(.headline)
            HStack {
                switch phase {
                case .editing:
                    Button("Cerrar") { dismiss() }
                        .foregroundStyle(.primary)
                    Spacer()
                    Button {
                        restartToken += 1
                    } label: {
                        Image(systemName: "arrow.counterclockwise")
                    }
                    .accessibilityLabel("Ver de nuevo")
                case .rendering:
                    Button("Cancelar") { renderTask?.cancel() }
                        .foregroundStyle(.primary)
                    Spacer()
                case .done:
                    Button("Editar") { phase = .editing }
                        .foregroundStyle(.primary)
                    Spacer()
                    Button("Listo") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
        .padding(.horizontal, DS.Spacing.l)
        .frame(height: 44)
    }

    private var barTitle: String {
        switch phase {
        case .editing: return "Compartir vídeo"
        case .rendering: return "Creando vídeo"
        case .done: return "Tu vídeo"
        }
    }

    // MARK: Preview, progress, result

    private var stage: some View {
        GeometryReader { geometry in
            let size = fitted(aspect: format.aspect, in: geometry.size)
            stageContent(size: size)
                .frame(width: size.width, height: size.height)
                .clipShape(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private func stageContent(size: CGSize) -> some View {
        switch phase {
        case .editing:
            RouteReplayView(
                coordinates: coordinates,
                color: routeColor,
                distance: distance,
                duration: duration,
                height: size.height,
                allowsFullScreen: false,
                config: config,
                share: options,
                restartToken: restartToken,
                runner: flagRunner
            )
        case .rendering:
            renderingCard
        case .done(let url, _):
            LoopingVideoView(url: url)
        }
    }

    /// The video's map being drawn (MapKit only draws on screen), frosted over: its frames go one by
    /// one, not in real time, so they shouldn't be taken for the video. Progress on top.
    private var renderingCard: some View {
        ZStack {
            Color.black
            if let renderer {
                RouteVideoMapHost(renderer: renderer)
                ZStack {
                    Rectangle().fill(.ultraThinMaterial)
                    Color.black.opacity(0.3)
                    VideoRenderProgressView(progress: renderer.progress)
                }
                .environment(\.colorScheme, .dark)
            }
        }
    }

    /// Largest size with `aspect` (width / height) that fits `space`.
    private func fitted(aspect: CGFloat, in space: CGSize) -> CGSize {
        guard space.width > 0, space.height > 0 else { return .zero }
        if space.width / space.height > aspect {
            return CGSize(width: (space.height * aspect).rounded(.down), height: space.height.rounded(.down))
        }
        return CGSize(width: space.width.rounded(.down), height: (space.width / aspect).rounded(.down))
    }

    // MARK: Bottom panel

    @ViewBuilder
    private var bottomPanel: some View {
        switch phase {
        case .editing:
            controls
        case .rendering:
            VStack(spacing: DS.Spacing.s) {
                Label("Deja Runna.io abierta mientras se crea", systemImage: "iphone")
                    .font(.footnote.weight(.semibold))
                Text("Se hace fotograma a fotograma, sin grabar la pantalla, y se guarda en Fotos al terminar.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity)
            .padding(DS.Spacing.l)
            .background(Color.surface)
        case .done(let url, let result):
            donePanel(url: url, result: result)
        }
    }

    private var controls: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Spacing.l) {
                Picker("Formato", selection: $formatRaw) {
                    ForEach(RouteShareFormat.allCases) { format in
                        Text(format.title).tag(format.rawValue)
                    }
                }
                .pickerStyle(.segmented)

                HStack(spacing: DS.Spacing.m) {
                    Picker("Vista", selection: $config.mode) {
                        Text("3D").tag(RouteReplayMode.threeD)
                        Text("2D").tag(RouteReplayMode.flat)
                    }
                    .pickerStyle(.segmented)
                    Picker("Mapa", selection: $config.satellite) {
                        Text("Satélite").tag(true)
                        Text("Mapa").tag(false)
                    }
                    .pickerStyle(.segmented)
                }

                VStack(alignment: .leading, spacing: DS.Spacing.s) {
                    SectionLabel("Velocidad")
                    Picker("Velocidad", selection: $config.speed) {
                        Text("Rápida").tag(0.6)
                        Text("Normal").tag(1.0)
                        Text("Lenta").tag(1.5)
                    }
                    .pickerStyle(.segmented)
                }

                VStack(alignment: .leading, spacing: DS.Spacing.s) {
                    SectionLabel("Color de la ruta")
                    HStack(spacing: DS.Spacing.m) {
                        ForEach(Array(palette.enumerated()), id: \.offset) { index, color in
                            Button {
                                colorIndex = index
                            } label: {
                                Circle()
                                    .fill(color)
                                    .frame(width: 30, height: 30)
                                    .overlay(Circle().stroke(Color.hairline, lineWidth: 1))
                                    .overlay(Circle().stroke(Color.primary, lineWidth: colorIndex == index ? 2.5 : 0).padding(-4))
                            }
                            .buttonStyle(.pressable)
                            .accessibilityLabel("Color \(index + 1)")
                            .accessibilityAddTraits(colorIndex == index ? .isSelected : [])
                        }
                    }
                }

                VStack(alignment: .leading, spacing: DS.Spacing.s) {
                    SectionLabel("Título")
                    TextField("Título", text: $options.title)
                        .textFieldStyle(.roundedBorder)
                        .submitLabel(.done)
                }

                VStack(alignment: .leading, spacing: DS.Spacing.s) {
                    SectionLabel("Qué se ve")
                    FlowChips(items: dataToggles)
                }

                Button {
                    startRendering()
                } label: {
                    Label("Crear vídeo", systemImage: "film")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(phase != .editing || renderTask != nil)

                Text("Se crea fotograma a fotograma en alta calidad, sin grabar la pantalla y con el mapa ya cargado, y se guarda solo en Fotos.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, DS.Spacing.l)
            .padding(.vertical, DS.Spacing.m)
        }
        .scrollDismissesKeyboard(.interactively)
        .frame(maxHeight: 360)
        .background(Color.surface)
    }

    private var dataToggles: [FlowChips.Item] {
        var items: [FlowChips.Item] = [
            .init(title: "Título", isOn: options.showsTitle) { options.showsTitle.toggle() },
            .init(title: "Fecha", isOn: options.showsDate) { options.showsDate.toggle() },
            .init(title: "Distancia", isOn: options.showsDistance) { options.showsDistance.toggle() },
        ]
        if duration != nil {
            items.append(.init(title: "Tiempo", isOn: options.showsTime) { options.showsTime.toggle() })
            items.append(.init(title: "Ritmo", isOn: options.showsPace) { options.showsPace.toggle() })
        }
        if let area = options.area, area > 0 {
            items.append(.init(title: "Territorio", isOn: options.showsArea) { options.showsArea.toggle() })
        }
        items.append(.init(title: "Resumen final", isOn: options.showsEndCard) { options.showsEndCard.toggle() })
        items.append(.init(title: "Marca Runna.io", isOn: options.showsBrand) { options.showsBrand.toggle() })
        return items
    }

    private func donePanel(url: URL, result: SaveResult) -> some View {
        VStack(spacing: DS.Spacing.m) {
            HStack(alignment: .top, spacing: DS.Spacing.s) {
                Image(systemName: result == .saved ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                    .foregroundStyle(result == .saved ? Color.brand : Color.secondary)
                    .symbolEffect(.bounce, value: result == .saved)
                Text(saveMessage(result))
                    .font(.subheadline.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            ShareLink(item: url, preview: SharePreview("Mi carrera en Runna.io")) {
                Label("Compartir vídeo", systemImage: "square.and.arrow.up")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle())
            if result == .noPermission {
                Button("Permitir guardar en Fotos") {
                    if let settings = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(settings)
                    }
                }
                .buttonStyle(SecondaryButtonStyle())
            }
        }
        .padding(DS.Spacing.l)
        .background(Color.surface)
    }

    private func saveMessage(_ result: SaveResult) -> String {
        switch result {
        case .saved: return "Guardado en Fotos"
        case .noPermission: return "Runna.io no tiene permiso para guardar en Fotos. Puedes guardarlo desde Compartir."
        case .failed: return "No se ha podido guardar en Fotos. Puedes guardarlo desde Compartir."
        }
    }

    // MARK: Making the video

    private func startRendering() {
        guard phase == .editing, renderTask == nil, let plan = RouteReplayPlan(coordinates: coordinates) else { return }
        let job = RouteVideoRenderer.Job(
            plan: plan,
            mode: config.mode,
            satellite: config.satellite,
            speed: config.speed,
            color: UIColor(routeColor),
            options: options,
            distance: distance,
            duration: duration,
            format: format,
            colorScheme: colorScheme,
            runner: flagRunner
        )
        let renderer = RouteVideoRenderer(job: job, screenScale: displayScale)
        self.renderer = renderer
        phase = .rendering
        renderTask = Task { @MainActor in
            // Asked first, so the question doesn't wait for the end
            let canSave = await VideoLibrary.requestAccess()
            renderer.setRunnerPhoto(await job.runner.loadPhoto())
            do {
                Self.removeOldVideos()
                let url = try await renderer.render()
                let result: SaveResult
                if canSave {
                    result = await VideoLibrary.save(url) ? .saved : .failed
                } else {
                    result = .noPermission
                }
                if result == .saved {
                    Haptics.success()
                }
                phase = .done(url, result)
            } catch {
                if !(error is CancellationError) {
                    errorMessage = error.localizedDescription
                }
                phase = .editing
            }
            self.renderer = nil
            renderTask = nil
        }
    }

    /// Videos made before (temporary files of tens of MB each).
    private static func removeOldVideos() {
        let folder = FileManager.default.temporaryDirectory
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        for file in files where file.lastPathComponent.hasPrefix("runna-") && file.pathExtension == "mp4" {
            try? FileManager.default.removeItem(at: file)
        }
    }
}

/// Ring, percentage and time left while the video is made. Reads the progress in its own body, so
/// only this re-renders while the frames are made.
private struct VideoRenderProgressView: View {
    let progress: RouteVideoProgress

    var body: some View {
        let fraction = progress.fraction
        VStack(spacing: DS.Spacing.l) {
            ZStack {
                ProgressRing(fraction: fraction, lineWidth: 6, tint: .white, track: Color.white.opacity(0.2))
                Text("\(Int(fraction * 100))%")
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .monospacedDigit()
            }
            .frame(width: 104, height: 104)
            VStack(spacing: 4) {
                Text(progress.isLoadingMap ? "Cargando el mapa…" : "Creando tu vídeo…")
                    .font(.headline)
                Text(detail)
                    .font(.subheadline)
                    .opacity(0.75)
            }
            .multilineTextAlignment(.center)
        }
        .foregroundStyle(.white)
        .padding(DS.Spacing.l)
    }

    private var detail: String {
        if progress.isLoadingMap {
            return "Para que no falte ninguna zona"
        }
        guard let remaining = progress.remaining else {
            return "Se guardará en Fotos al terminar"
        }
        if remaining < 10 {
            return "Casi listo"
        }
        if remaining < 60 {
            return "Quedan unos \(max(10, Int((remaining / 5).rounded()) * 5)) s"
        }
        let minutes = Int((remaining / 60).rounded())
        return minutes <= 1 ? "Queda alrededor de un minuto" : "Quedan unos \(minutes) min"
    }
}

/// Toggle chips that wrap onto several lines.
private struct FlowChips: View {
    struct Item {
        let title: String
        let isOn: Bool
        let action: () -> Void
    }

    let items: [Item]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: DS.Spacing.s)], alignment: .leading, spacing: DS.Spacing.s) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                ChipToggle(title: item.title, isOn: item.isOn, systemImage: item.isOn ? "checkmark" : nil, action: item.action)
            }
        }
    }
}

// MARK: - The finished video

/// The finished video playing in a loop, without controls, filling its card.
private struct LoopingVideoView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> LoopingPlayerView {
        let view = LoopingPlayerView()
        view.play(url)
        return view
    }

    func updateUIView(_ uiView: LoopingPlayerView, context: Context) {
        uiView.play(url)
    }

    static func dismantleUIView(_ uiView: LoopingPlayerView, coordinator: ()) {
        uiView.stop()
    }
}

private final class LoopingPlayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }

    private var player: AVQueuePlayer?
    private var looper: AVPlayerLooper?
    private var url: URL?

    func play(_ url: URL) {
        guard url != self.url else { return }
        self.url = url
        let player = AVQueuePlayer()
        player.isMuted = true
        looper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url))
        self.player = player
        if let playerLayer = layer as? AVPlayerLayer {
            playerLayer.player = player
            playerLayer.videoGravity = .resizeAspect
        }
        backgroundColor = .black
        player.play()
    }

    func stop() {
        player?.pause()
        looper = nil
        player = nil
    }
}
