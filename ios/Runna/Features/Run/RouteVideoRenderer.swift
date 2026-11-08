import SwiftUI
import MapKit
import AVFoundation
import Photos

// MARK: - Making the share video

/// How far along a video is, for the progress screen.
@Observable
final class RouteVideoProgress {
    /// 0...1 of the whole job (loading the map, then making the frames)
    var fraction: Double = 0
    /// Loading the map's views, before the first frame
    var isLoadingMap = true
    /// Seconds left, once a few frames are made
    var remaining: Double?
}

/// Makes the share video without recording the screen. The replay (the same animation as on screen:
/// `ReplayDirector` and `ReplayScene`) is computed frame by frame at a fixed 30 fps on a map of its
/// own, shown behind the progress screen because MapKit only draws on screen:
/// 1. First every view the replay goes through is loaded (as before playing it in the app).
/// 2. Then each frame is set up and waits until MapKit has drawn it completely (map tiles, 3D
///    terrain, the line's tiles up to the runner); it's then copied into the video with the titles
///    and figures on top.
/// However fast or slow the iPhone and the network are, the video comes out the same: no dropped
/// frames, no half-loaded areas, the line's end exactly under the runner.
@MainActor
final class RouteVideoRenderer: NSObject, MKMapViewDelegate {
    struct Job {
        let plan: RouteReplayPlan
        let mode: RouteReplayMode
        let satellite: Bool
        let speed: Double
        let color: UIColor
        let options: RouteShareOptions
        /// metres and seconds of the run, for the figures
        let distance: Double
        let duration: Int?
        let format: RouteShareFormat
        /// The editor's, so the titles look as in its preview
        let colorScheme: ColorScheme
        /// Whose flag runs the route
        let runner: ReplayRunner
    }

    enum RenderError: LocalizedError {
        case capture
        case writer(String)

        var errorDescription: String? {
            switch self {
            case .capture: return "No se ha podido dibujar el mapa del vídeo."
            case .writer(let reason): return "No se ha podido crear el vídeo (\(reason))."
            }
        }
    }

    static let framesPerSecond: Int32 = 30
    /// Seconds after the finish phase: the end card, and in 3D the start of the slow turn
    static let tail: Double = 3
    /// Part of the progress bar that loading the map takes
    private static let loadingShare = 0.15

    let progress = RouteVideoProgress()
    /// The map the frames are drawn on, and its size in points: its pixels are the video's
    let mapView: MKMapView
    let mapSize: CGSize

    private let job: Job
    private let timeline: RouteReplayTimeline
    private let scene: ReplayScene
    private var director: ReplayDirector
    private let loadState = MapLoadState()
    private let clock = FrameClock()
    private var flagAlpha: CGFloat = 0
    private var overlayCache: (key: String, image: CGImage)?
    /// Some iOS versions only snapshot the map after a screen update
    private var snapshotsAfterScreenUpdates = false

    init(job: Job, screenScale: CGFloat) {
        self.job = job
        let timeline = RouteReplayTimeline(plan: job.plan, mode: job.mode, speed: job.speed)
        self.timeline = timeline
        scene = ReplayScene(timeline: timeline, color: job.color, runner: job.runner)
        director = ReplayDirector(timeline: timeline)
        let scale = max(1, screenScale)
        let size = CGSize(width: job.format.videoSize.width / scale, height: job.format.videoSize.height / scale)
        mapSize = size
        mapView = MKMapView(frame: CGRect(origin: .zero, size: size))
        super.init()
        mapView.delegate = self
        mapView.showsCompass = false
        mapView.showsScale = false
        mapView.showsUserLocation = false
        mapView.isUserInteractionEnabled = false
        ReplayScene.applyStyle(satellite: job.satellite, mode: job.mode, to: mapView)
        scene.install(on: mapView)
        mapView.camera = timeline.overviewCamera.mkCamera
    }

    /// The runner's photo for the flag (set before rendering).
    func setRunnerPhoto(_ photo: UIImage?) {
        scene.runnerFlag.setPhoto(photo)
    }

    /// Where the runner's wind blows the flag: opposite to their way (over the last tens of metres).
    private static func streamBearing(of frame: ReplayFrame, on plan: RouteReplayPlan) -> Double {
        plan.bearing(at: min(max(frame.run, 30), plan.length - 30), window: 80) + 180
    }

    /// Seconds of video.
    var duration: Double { timeline.total + Self.tail }

    /// Makes the video and returns its file (in the temporary folder). Throws CancellationError
    /// when the task is cancelled.
    func render() async throws -> URL {
        UIApplication.shared.isIdleTimerDisabled = true
        defer { UIApplication.shared.isIdleTimerDisabled = false }

        // 1. Every view of the replay loaded first, then back to the first one
        let cameras = ReplayDirector.preloadCameras(for: timeline) + [timeline.overviewCamera]
        let progress = self.progress
        let loaded = await loadState.preload(cameras, on: mapView) { fraction in
            progress.fraction = fraction * Self.loadingShare
        }
        try Task.checkCancellation()
        guard loaded else { throw CancellationError() }
        progress.isLoadingMap = false

        // 2. The video file
        let videoSize = job.format.videoSize
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("runna-\(UUID().uuidString).mp4")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let compression: [String: Any] = [
            AVVideoAverageBitRateKey: 12_000_000,
            AVVideoExpectedSourceFrameRateKey: Int(Self.framesPerSecond),
            AVVideoMaxKeyFrameIntervalKey: Int(Self.framesPerSecond),
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        ]
        let colors: [String: Any] = [
            AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
            AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
            AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
        ]
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(videoSize.width),
            AVVideoHeightKey: Int(videoSize.height),
            AVVideoCompressionPropertiesKey: compression,
            AVVideoColorPropertiesKey: colors,
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: Int(videoSize.width),
            kCVPixelBufferHeightKey as String: Int(videoSize.height),
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
        ])
        guard writer.canAdd(input) else { throw RenderError.writer("formato") }
        writer.add(input)
        guard writer.startWriting() else { throw RenderError.writer(writer.error?.localizedDescription ?? "inicio") }
        writer.startSession(atSourceTime: .zero)
        var completed = false
        defer {
            if !completed {
                if writer.status == .writing { writer.cancelWriting() }
                try? FileManager.default.removeItem(at: url)
            }
        }

        // 3. The frames
        clock.start()
        defer { clock.stop() }
        let step = 1 / Double(Self.framesPerSecond)
        let frames = Int((duration / step).rounded(.up))
        let geometry = scene.trail.geometry
        var started = CACurrentMediaTime()
        var slowFrames = 0

        for index in 0..<frames {
            try Task.checkCancellation()
            let elapsed = Double(index) * step
            let dt = index == 0 ? 0 : step
            let frame = director.frame(at: elapsed, dt: dt)
            apply(frame, elapsed: elapsed, dt: dt)
            // The titles are made while MapKit draws the map
            let overlay = autoreleasepool { overlayImage(for: frame, elapsed: elapsed) }

            // Up to 0.75 s for MapKit to draw it (3 s the first one); less while the map keeps
            // saying it's busy (it doesn't always report the end), so a bad network can't stall it
            let change = geometry.currentGeneration
            let settled = await loadState.settle(
                clock: clock,
                maxRefreshes: index == 0 ? 180 : (slowFrames >= 8 ? 8 : 45),
                calmRefreshes: 1,
                patience: index == 0 ? 2 : 1
            ) { refreshes in
                // The line's tiles redrawn (MapKit may need none: not waited for long)
                geometry.hasDrawn(generation: change) || refreshes > 12
            }
            slowFrames = settled ? 0 : slowFrames + 1
            try Task.checkCancellation()
            // The flag on the ground at the end of the line on the frame now drawn, moving with the
            // video's clock; one refresh so it's on screen when the frame is copied
            scene.moveFlag(
                to: frame.runner,
                streamBearing: frame.isFinished || frame.run >= timeline.plan.length ? nil : Self.streamBearing(of: frame, on: timeline.plan),
                moving: frame.showsRunner,
                dt: dt
            )
            await clock.next()

            var waits = 0
            while !input.isReadyForMoreMediaData {
                waits += 1
                guard waits < 500, writer.status == .writing else {
                    throw RenderError.writer(writer.error?.localizedDescription ?? "codificador")
                }
                try await Task.sleep(nanoseconds: 4_000_000)
            }
            guard writer.status == .writing, let pool = adaptor.pixelBufferPool else {
                throw RenderError.writer(writer.error?.localizedDescription ?? "escritura")
            }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
            guard let buffer else { throw RenderError.writer("memoria") }

            // A frame where the map didn't come out (blank) is waited for and drawn again
            var drew = autoreleasepool { draw(overlay: overlay, into: buffer) }
            var retries = 0
            while !drew && retries < 3 {
                retries += 1
                _ = await loadState.settle(clock: clock, maxRefreshes: 30, calmRefreshes: 1)
                try Task.checkCancellation()
                drew = autoreleasepool { draw(overlay: overlay, into: buffer) }
            }
            guard drew else { throw RenderError.capture }

            let time = CMTime(value: CMTimeValue(index), timescale: Self.framesPerSecond)
            guard adaptor.append(buffer, withPresentationTime: time) else {
                throw RenderError.writer(writer.error?.localizedDescription ?? "escritura")
            }

            progress.fraction = Self.loadingShare + (1 - Self.loadingShare) * Double(index + 1) / Double(frames)
            if index == 0 {
                started = CACurrentMediaTime()
            } else if index >= 15 {
                let perFrame = (CACurrentMediaTime() - started) / Double(index)
                progress.remaining = perFrame * Double(frames - index - 1)
            }
        }

        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else {
            throw RenderError.writer(writer.error?.localizedDescription ?? "cierre")
        }
        completed = true
        return url
    }

    // MARK: Frames

    /// Sets the map up for `frame`: the runner's flag (fading in a quarter of a second of video, once
    /// they set off), camera and line. The flag is placed once the frame is drawn.
    private func apply(_ frame: ReplayFrame, elapsed: Double, dt: Double) {
        let fade = CGFloat(dt / 0.25)
        flagAlpha = Self.approach(flagAlpha, frame.run > 0 ? 1 : 0, by: fade)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        scene.setFlagAlpha(flagAlpha, animated: false)
        CATransaction.commit()
        mapView.camera = frame.camera.mkCamera
        scene.drawTrail(to: frame.trail)
        if frame.isRevealed {
            scene.addArea()
        }
    }

    private static func approach(_ value: CGFloat, _ target: CGFloat, by step: CGFloat) -> CGFloat {
        value < target ? min(target, value + step) : max(target, value - step)
    }

    /// Copies the map as MapKit shows it now into `buffer`, with the titles on top. False if the
    /// map came out blank.
    private func draw(overlay: CGImage?, into buffer: CVPixelBuffer) -> Bool {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let context = CGContext(
            data: CVPixelBufferGetBaseAddress(buffer),
            width: CVPixelBufferGetWidth(buffer),
            height: CVPixelBufferGetHeight(buffer),
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else { return false }
        let rect = CGRect(x: 0, y: 0, width: context.width, height: context.height)
        // UIKit's origin is at the top left
        context.translateBy(x: 0, y: rect.height)
        context.scaleBy(x: 1, y: -1)
        UIGraphicsPushContext(context)
        defer { UIGraphicsPopContext() }

        var drew = snapshotMap(in: rect, context: context)
        if !drew && !snapshotsAfterScreenUpdates {
            snapshotsAfterScreenUpdates = true
            drew = snapshotMap(in: rect, context: context)
        }
        guard drew else { return false }
        if let overlay {
            UIImage(cgImage: overlay).draw(in: rect)
        }
        return true
    }

    private func snapshotMap(in rect: CGRect, context: CGContext) -> Bool {
        context.setFillColor(UIColor.black.cgColor)
        context.fill(rect)
        _ = mapView.drawHierarchy(in: rect, afterScreenUpdates: snapshotsAfterScreenUpdates)
        return !Self.isBlank(context)
    }

    /// Nothing drawn: still the black the buffer was cleared with, at points spread across it.
    private static func isBlank(_ context: CGContext) -> Bool {
        guard let data = context.data else { return true }
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        let width = context.width
        let height = context.height
        let rowBytes = context.bytesPerRow
        for i in 1...4 {
            for j in 1...4 {
                let offset = (height * j / 5) * rowBytes + (width * i / 5) * 4
                if bytes[offset] != 0 || bytes[offset + 1] != 0 || bytes[offset + 2] != 0 {
                    return false
                }
            }
        }
        return true
    }

    /// Titles, counters and the end card of this frame (made again only when they change). SwiftUI
    /// doesn't animate here, so the end card comes in by hand: half a second, easing out.
    private func overlayImage(for frame: ReplayFrame, elapsed: Double) -> CGImage? {
        let reveal = frame.isFinished ? min(1, max(0, (elapsed - timeline.total) / 0.5)) : 0
        let overlay = RouteShareOverlay(
            options: job.options,
            fraction: frame.run / timeline.plan.length,
            isFinished: frame.isFinished,
            distance: job.distance,
            duration: job.duration,
            endCardReveal: 1 - pow(1 - reveal, 3)
        )
        let key = overlay.renderKey
        if let overlayCache, overlayCache.key == key {
            return overlayCache.image
        }
        // Laid out 360 points wide like the preview (its sizes follow the width), drawn at the video's pixels
        let width: CGFloat = 360
        let height = (width / job.format.aspect).rounded()
        let renderer = ImageRenderer(content: overlay
            .frame(width: width, height: height)
            .environment(\.colorScheme, job.colorScheme))
        renderer.scale = job.format.videoSize.width / width
        renderer.isOpaque = false
        guard let image = renderer.cgImage else { return nil }
        overlayCache = (key, image)
        return image
    }

    // MARK: MKMapViewDelegate

    func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
        scene.renderer(for: overlay)
    }

    func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
        scene.view(for: annotation)
    }

    func mapViewWillStartLoadingMap(_ mapView: MKMapView) {
        loadState.willStartLoading()
    }

    func mapViewDidFinishLoadingMap(_ mapView: MKMapView) {
        loadState.didFinishLoading()
    }

    func mapViewDidFailLoadingMap(_ mapView: MKMapView, withError error: Error) {
        loadState.didFinishLoading()
    }

    func mapViewWillStartRenderingMap(_ mapView: MKMapView) {
        loadState.willStartRendering()
    }

    func mapViewDidFinishRenderingMap(_ mapView: MKMapView, fullyRendered: Bool) {
        loadState.didFinishRendering(fullyRendered: fullyRendered)
    }
}

// MARK: - The renderer's map on screen

/// Shows the renderer's map scaled down to fit, while it keeps drawing at its own size (the video's
/// pixels): MapKit only draws a map that is on screen.
struct RouteVideoMapHost: UIViewRepresentable {
    let renderer: RouteVideoRenderer

    func makeUIView(context: Context) -> RouteVideoMapContainer {
        RouteVideoMapContainer(mapView: renderer.mapView, mapSize: renderer.mapSize)
    }

    func updateUIView(_ uiView: RouteVideoMapContainer, context: Context) {}
}

/// Holds the map at its own size inside a view that only scales it (a snapshot of the map isn't
/// affected by the scale of the views around it).
final class RouteVideoMapContainer: UIView {
    private let scaler = UIView()
    private let mapView: MKMapView
    private let mapSize: CGSize

    init(mapView: MKMapView, mapSize: CGSize) {
        self.mapView = mapView
        self.mapSize = mapSize
        super.init(frame: .zero)
        clipsToBounds = true
        isUserInteractionEnabled = false
        scaler.bounds = CGRect(origin: .zero, size: mapSize)
        addSubview(scaler)
        mapView.frame = CGRect(origin: .zero, size: mapSize)
        scaler.addSubview(mapView)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard mapSize.width > 0, mapSize.height > 0 else { return }
        let scale = min(bounds.width / mapSize.width, bounds.height / mapSize.height)
        scaler.bounds = CGRect(origin: .zero, size: mapSize)
        scaler.center = CGPoint(x: bounds.midX, y: bounds.midY)
        scaler.transform = scale > 0 ? CGAffineTransform(scaleX: scale, y: scale) : .identity
        mapView.frame = CGRect(origin: .zero, size: mapSize)
    }
}

// MARK: - Photos

/// Saving videos to the photo library (add-only access: Runna.io can't see the library).
enum VideoLibrary {
    /// Asks for permission the first time; whether videos can be saved.
    static func requestAccess() async -> Bool {
        switch PHPhotoLibrary.authorizationStatus(for: .addOnly) {
        case .authorized, .limited:
            return true
        case .notDetermined:
            let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
            return status == .authorized || status == .limited
        default:
            return false
        }
    }

    /// Adds the video to Photos; whether it worked.
    static func save(_ url: URL) async -> Bool {
        do {
            try await PHPhotoLibrary.shared().performChanges {
                _ = PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
            }
            return true
        } catch {
            return false
        }
    }
}
