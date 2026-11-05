import SwiftUI
import MapKit
import AVFoundation
import AVKit
import ReplayKit
import CoreImage

// MARK: - What the video shows

/// Titles and figures drawn over the map in the shared video (all editable before recording).
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
/// so the preview and the recording look the same.
struct RouteShareOverlay: View {
    let options: RouteShareOptions
    /// 0...1 of the route run so far
    let fraction: Double
    let isFinished: Bool
    /// metres and seconds of the whole run
    let distance: Double
    let duration: Int?

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
/// preview, then record it (the replay plays once in full) and share or save the video.
struct RouteShareEditor: View {
    let coordinates: [CLLocationCoordinate2D]
    let distance: Double
    let duration: Int?
    /// The owner's colour (offered first).
    let ownerColor: Color

    @Environment(\.dismiss) private var dismiss

    @AppStorage("shareFormat") private var formatRaw = RouteShareFormat.story.rawValue
    @State private var config: RouteReplayConfig
    @State private var options: RouteShareOptions
    @State private var colorIndex = 0
    @State private var restartToken = 0
    @State private var phase: Phase = .editing
    @State private var previewRect: CGRect = .zero
    @State private var recorder = RouteVideoRecorder()
    @State private var errorMessage: String?

    private enum Phase: Equatable {
        case editing
        case preparing
        case recording
        case saving
        case done(URL)
    }

    init(coordinates: [CLLocationCoordinate2D], distance: Double, duration: Int?, title: String, date: Date?, area: Double?, color: Color) {
        self.coordinates = coordinates
        self.distance = distance
        self.duration = duration
        self.ownerColor = color
        _config = State(initialValue: RouteReplayConfig(
            mode: RouteReplayMode(rawValue: UserDefaults.standard.string(forKey: "routeReplayMode") ?? "") ?? .threeD,
            satellite: UserDefaults.standard.object(forKey: "routeReplaySatellite") as? Bool ?? true,
            speed: 1
        ))
        _options = State(initialValue: RouteShareOptions(title: title, date: date, area: area))
    }

    private var format: RouteShareFormat { RouteShareFormat(rawValue: formatRaw) ?? .story }

    private var palette: [Color] { [ownerColor, .brand, .white, .gold, .steal, .sky, .grape] }
    private var routeColor: Color { palette[min(colorIndex, palette.count - 1)] }

    private var isCapturing: Bool { phase == .preparing || phase == .recording }

    var body: some View {
        ZStack {
            (isCapturing ? Color.black : Color.canvas).ignoresSafeArea()
            VStack(spacing: 0) {
                if !isCapturing {
                    topBar
                }
                preview
                    .padding(.horizontal, isCapturing ? 0 : DS.Spacing.l)
                    .padding(.vertical, isCapturing ? 0 : DS.Spacing.s)
                if !isCapturing {
                    controls
                }
            }
            if phase == .saving {
                savingOverlay
            }
        }
        .statusBarHidden(isCapturing)
        .animation(.snappy, value: isCapturing)
        .sheet(item: Binding<SharedVideo?>(
            get: {
                if case .done(let url) = phase { return SharedVideo(url: url) }
                return nil
            },
            set: { newValue in
                if newValue == nil { phase = .editing }
            }
        )) { video in
            SharedVideoSheet(url: video.url)
        }
        .errorAlert($errorMessage)
        .onDisappear {
            Task { await recorder.cancel() }
        }
    }

    // MARK: Top bar

    private var topBar: some View {
        HStack {
            Button("Cerrar") { dismiss() }
                .foregroundStyle(.primary)
            Spacer()
            Text("Compartir vídeo")
                .font(.headline)
            Spacer()
            Button {
                restartToken += 1
            } label: {
                Image(systemName: "arrow.counterclockwise")
            }
            .accessibilityLabel("Ver de nuevo")
        }
        .padding(.horizontal, DS.Spacing.l)
        .frame(height: 44)
    }

    // MARK: Preview

    private var preview: some View {
        GeometryReader { geometry in
            let size = fitted(aspect: format.aspect, in: geometry.size)
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
                onFinished: replayFinished
            )
            .frame(width: size.width, height: size.height)
            .clipShape(RoundedRectangle(cornerRadius: isCapturing ? 0 : DS.Radius.card, style: .continuous))
            .background(
                GeometryReader { frameProxy in
                    Color.clear
                        .onAppear { previewRect = frameProxy.frame(in: .global) }
                        .onChange(of: frameProxy.frame(in: .global)) { _, rect in previewRect = rect }
                }
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .allowsHitTesting(!isCapturing)
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

    // MARK: Controls

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
                    Task { await record() }
                } label: {
                    Label("Grabar vídeo", systemImage: "record.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(phase != .editing)

                Text("El vídeo se graba mientras se reproduce la animación entera. iOS te pedirá permiso para grabar la pantalla de Runna.io.")
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

    private var savingOverlay: some View {
        VStack(spacing: DS.Spacing.m) {
            ProgressView()
                .controlSize(.large)
            Text("Preparando el vídeo…")
                .font(.subheadline.weight(.medium))
        }
        .padding(DS.Spacing.xxl)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
    }

    // MARK: Recording

    private func record() async {
        UIApplication.shared.isIdleTimerDisabled = true
        phase = .preparing
        // Let the preview grow to its full size before measuring it
        try? await Task.sleep(nanoseconds: 450_000_000)
        guard previewRect.width > 10, previewRect.height > 10 else {
            phase = .editing
            UIApplication.shared.isIdleTimerDisabled = false
            errorMessage = "No se ha podido preparar la grabación."
            return
        }
        do {
            try await recorder.start(crop: previewRect, screenSize: UIScreen.main.bounds.size, videoSize: format.videoSize)
        } catch {
            phase = .editing
            UIApplication.shared.isIdleTimerDisabled = false
            errorMessage = error.localizedDescription
            return
        }
        phase = .recording
        // Play from the very beginning while recording
        restartToken += 1
    }

    /// The runner reached the finish: in a recording, keep the final view a moment and save the video.
    private func replayFinished() {
        guard phase == .recording else { return }
        Task {
            // End card and the start of the slow turn
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard phase == .recording else { return }
            phase = .saving
            do {
                let url = try await recorder.finish()
                phase = .done(url)
            } catch {
                phase = .editing
                errorMessage = error.localizedDescription
            }
            UIApplication.shared.isIdleTimerDisabled = false
        }
    }
}

private struct SharedVideo: Identifiable {
    let url: URL
    var id: String { url.path }
}

/// The recorded video: watch it, share it (Instagram, WhatsApp…) or save it to Photos from the share sheet.
private struct SharedVideoSheet: View {
    let url: URL

    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer?

    var body: some View {
        NavigationStack {
            VStack(spacing: DS.Spacing.l) {
                VideoPlayer(player: player)
                    .clipShape(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
                    .frame(maxHeight: .infinity)
                ShareLink(item: url, preview: SharePreview("Mi carrera en Runna.io")) {
                    Label("Compartir vídeo", systemImage: "square.and.arrow.up")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                Text("Desde aquí puedes publicarlo en tus historias o guardarlo en Fotos.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(DS.Spacing.l)
            .navigationTitle("Tu vídeo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Editar") { dismiss() }
                }
            }
        }
        .onAppear {
            let newPlayer = AVPlayer(url: url)
            player = newPlayer
            newPlayer.play()
        }
        .onDisappear { player?.pause() }
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

// MARK: - Video recording

/// Records the part of the screen where the replay plays (ReplayKit in-app capture), cropped and
/// scaled to the chosen video size, into an MP4 file.
final class RouteVideoRecorder: @unchecked Sendable {
    enum RecorderError: LocalizedError {
        case unavailable
        case failed(String)

        var errorDescription: String? {
            switch self {
            case .unavailable: return "La grabación de pantalla no está disponible en este iPhone."
            case .failed(let reason): return "No se ha podido grabar el vídeo (\(reason))."
            }
        }
    }

    private let lock = NSLock()
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var sessionStarted = false
    private var crop: CGRect = .zero
    private var screenSize: CGSize = .zero
    private var videoSize: CGSize = .zero
    private var outputURL: URL?
    private var lastFrameTime: CMTime = .invalid
    private var isCapturing = false

    /// Starts capturing. `crop` and `screenSize` are in points (global coordinates).
    func start(crop: CGRect, screenSize: CGSize, videoSize: CGSize) async throws {
        let recorder = RPScreenRecorder.shared()
        guard recorder.isAvailable else { throw RecorderError.unavailable }
        recorder.isMicrophoneEnabled = false

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("runna-\(UUID().uuidString).mp4")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(videoSize.width),
            AVVideoHeightKey: Int(videoSize.height),
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 12_000_000,
                AVVideoExpectedSourceFrameRateKey: 30,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ])
        input.expectsMediaDataInRealTime = true
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: Int(videoSize.width),
            kCVPixelBufferHeightKey as String: Int(videoSize.height),
        ])
        guard writer.canAdd(input) else { throw RecorderError.failed("formato") }
        writer.add(input)

        lock.withLock {
            self.writer = writer
            self.input = input
            self.adaptor = adaptor
            self.crop = crop
            self.screenSize = screenSize
            self.videoSize = videoSize
            self.outputURL = url
            self.sessionStarted = false
            self.lastFrameTime = .invalid
            self.isCapturing = true
        }

        do {
            try await recorder.startCapture(handler: { [weak self] buffer, type, error in
                guard error == nil, type == .video else { return }
                self?.append(buffer)
            })
        } catch {
            reset()
            throw RecorderError.failed(error.localizedDescription)
        }
    }

    /// Stops capturing and returns the finished video file.
    func finish() async throws -> URL {
        try? await RPScreenRecorder.shared().stopCapture()
        let (writer, input, url, started) = lock.withLock { () -> (AVAssetWriter?, AVAssetWriterInput?, URL?, Bool) in
            isCapturing = false
            return (self.writer, self.input, self.outputURL, self.sessionStarted)
        }
        guard let writer, let input, let url, started else {
            reset()
            throw RecorderError.failed("sin imágenes")
        }
        input.markAsFinished()
        await writer.finishWriting()
        reset()
        guard writer.status == .completed else {
            throw RecorderError.failed(writer.error?.localizedDescription ?? "escritura")
        }
        return url
    }

    /// Stops without saving (the editor was closed).
    func cancel() async {
        let capturing = lock.withLock { isCapturing }
        guard capturing else { return }
        try? await RPScreenRecorder.shared().stopCapture()
        lock.withLock { writer?.cancelWriting() }
        reset()
    }

    private func reset() {
        lock.withLock {
            writer = nil
            input = nil
            adaptor = nil
            sessionStarted = false
            isCapturing = false
        }
    }

    /// One screen frame: crop the replay, scale it to the video size and append it.
    private func append(_ sampleBuffer: CMSampleBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard isCapturing, let writer, let input, let adaptor,
              CMSampleBufferDataIsReady(sampleBuffer),
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if !sessionStarted {
            guard writer.startWriting() else { return }
            writer.startSession(atSourceTime: time)
            sessionStarted = true
        }
        guard input.isReadyForMoreMediaData else { return }
        if lastFrameTime.isValid, CMTimeCompare(time, lastFrameTime) <= 0 { return }

        let bufferWidth = CGFloat(CVPixelBufferGetWidth(pixelBuffer))
        let bufferHeight = CGFloat(CVPixelBufferGetHeight(pixelBuffer))
        guard screenSize.width > 0, bufferWidth > 0 else { return }
        let scale = bufferWidth / screenSize.width
        // Core Image's origin is bottom-left
        let region = CGRect(
            x: crop.minX * scale,
            y: bufferHeight - crop.maxY * scale,
            width: crop.width * scale,
            height: crop.height * scale
        ).integral.intersection(CGRect(x: 0, y: 0, width: bufferWidth, height: bufferHeight))
        guard region.width > 1, region.height > 1, let pool = adaptor.pixelBufferPool else { return }

        var output: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &output)
        guard let output else { return }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
            .cropped(to: region)
            .transformed(by: CGAffineTransform(translationX: -region.minX, y: -region.minY))
            .transformed(by: CGAffineTransform(scaleX: videoSize.width / region.width, y: videoSize.height / region.height))
        context.render(image, to: output)
        if adaptor.append(output, withPresentationTime: time) {
            lastFrameTime = time
        }
    }
}
