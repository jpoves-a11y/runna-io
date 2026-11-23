import SwiftUI
import MapKit
import AVFoundation
import Photos
import UserNotifications
import os

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
    /// KM2 isn't in front (the iPhone was locked, another app opened): the map can't draw, so the
    /// video waits and goes on from the same frame once KM2 is back
    var isPaused = false
}

/// Makes the share video without recording the screen. The replay (the same animation as on screen:
/// `ReplayDirector` and `ReplayScene`) is computed frame by frame at a fixed 30 fps on a map of its
/// own (Mapbox), shown behind the progress screen because the map only draws on screen:
/// 1. First every view the replay goes through is loaded (as before playing it in the app).
/// 2. Then each frame is set up and waits until Mapbox has drawn it completely (map tiles, 3D
///    terrain, the line, the flag at its end); it's then copied, and the titles and figures go on
///    top and it's encoded off the main thread while Mapbox already draws the next frame.
/// However fast or slow the iPhone and the network are, the video comes out the same: no dropped
/// frames, no half-loaded areas, the line's end exactly under the runner. Everything moves with the
/// video's own clock, so pausing it (KM2 in the background) changes nothing either.
@MainActor
final class RouteVideoRenderer: NSObject {
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
        /// When it was run (the sun's light, the weather) and what it adds (km paces, altitude)
        let activity: ReplayActivity?
        let extras: ReplayExtras
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
    let mapView: ReplayMapView
    let mapSize: CGSize

    private let job: Job
    private let timeline: RouteReplayTimeline
    private let scene: ReplayScene
    private var director: ReplayDirector
    private let loadState = MapLoadState()
    /// The screen's fastest refresh (120 Hz on ProMotion iPhones): each frame waits a couple of
    /// refreshes for the map, so the faster they come, the sooner the video is done
    private let clock = FrameClock(rate: FrameClock.screenRate)
    private var flagAlpha: CGFloat = 0
    private var overlayCache: (key: String, image: CGImage)?

    init(job: Job, screenScale: CGFloat) {
        self.job = job
        let timeline = RouteReplayTimeline(plan: job.plan, mode: job.mode, speed: job.speed)
        self.timeline = timeline
        scene = ReplayScene(timeline: timeline, color: job.color, runner: job.runner)
        director = ReplayDirector(timeline: timeline)
        let scale = max(1, screenScale)
        let size = CGSize(width: job.format.videoSize.width / scale, height: job.format.videoSize.height / scale)
        mapSize = size
        mapView = ReplayScene.makeMapView(frame: CGRect(origin: .zero, size: size))
        super.init()
        mapView.isUserInteractionEnabled = false
        // Mapbox draws as fast as the clock asks for frames
        let rate = Float(clock.rate)
        mapView.preferredFrameRateRange = CAFrameRateRange(minimum: min(60, rate), maximum: rate, preferred: rate)
        loadState.attach(to: mapView)
        scene.setExtras(job.extras)
        // The boxes the titles draw at the bottom: the weather on the glass goes round them
        scene.setGlassBoxes(RouteShareOverlay(
            options: job.options,
            fraction: 0,
            isFinished: false,
            distance: job.distance,
            duration: job.duration,
            elevation: job.extras.elevation,
            weatherCredit: job.extras.hasWeather
        ).boxLayout)
        scene.install(on: mapView, satellite: job.satellite, mode: job.mode, dark: job.colorScheme == .dark, activity: job.activity)
        scene.setCamera(timeline.overviewCamera)
    }

    /// The runner's photo for the flag (set before rendering).
    func setRunnerPhoto(_ photo: UIImage?) {
        scene.runnerFlag.setPhoto(photo)
    }

    /// Seconds of video.
    var duration: Double { timeline.total + Self.tail }

    // While making the video
    /// Whether KM2 is in front (the map only draws then)
    private var watch: ForegroundWatch?
    /// The file the frames go into now; nil while none is open (paused, say)
    private var segment: VideoSegment?
    private var segmentCount = 0
    /// Files already closed, in order: the video is them one after another
    private var finishedSegments: [URL] = []
    /// The frame getting its titles and being encoded, while the map draws the next one
    private var encoding: Task<Void, Error>?
    /// The open file being closed, because KM2 stopped being in front
    private var closing: Task<Void, Error>?
    private let videoID = UUID().uuidString
    private var pauseStarted: Double?
    /// Seconds paused so far
    private var pausedTotal: Double = 0
    private var timings = RenderTimings()

    /// Makes the video and returns its file (in the temporary folder). Throws CancellationError
    /// when the task is cancelled. Locking the iPhone or leaving KM2 pauses it (iOS doesn't let the
    /// map draw in the background): what's made so far is closed into a file of its own, and on
    /// coming back it goes on from the same frame into another; at the end they're joined without
    /// encoding them again, so the video comes out exactly as without the pause.
    func render() async throws -> URL {
        UIApplication.shared.isIdleTimerDisabled = true
        defer { UIApplication.shared.isIdleTimerDisabled = false }

        let watch = ForegroundWatch()
        self.watch = watch
        watch.onResignActive = { [weak self] in self?.paused() }
        watch.onBackground = { [weak self] in self?.notifyPaused() }
        watch.onActive = { [weak self] in self?.resumed() }
        defer {
            watch.stop()
            self.watch = nil
            self.progress.isPaused = false
            Self.removePausedNotice()
        }

        // 1. Every view of the replay loaded first, then its start again and the first view
        let preloadBegan = CACurrentMediaTime()
        let cameras = ReplayDirector.preloadCameras(for: timeline)
        let warm = ReplayDirector.startCameras(for: timeline)
        let progress = self.progress
        let loaded = await loadState.preload(cameras, warm: warm, on: mapView, scene: scene, rate: clock.rate, onProgress: { fraction in
            progress.fraction = fraction * Self.loadingShare
        })
        try Task.checkCancellation()
        guard loaded else { throw CancellationError() }
        progress.isLoadingMap = false
        let preloadSeconds = CACurrentMediaTime() - preloadBegan

        // 2. The video's files (one, unless KM2 stopped being in front on the way)
        var completed = false
        defer {
            if !completed {
                closing?.cancel()
                closing = nil
                encoding = nil
                segment?.cancel()
                segment = nil
                for url in finishedSegments {
                    try? FileManager.default.removeItem(at: url)
                }
                finishedSegments = []
            }
        }

        // 3. The frames
        clock.start()
        defer { clock.stop() }
        let step = 1 / Double(Self.framesPerSecond)
        let frames = Int((duration / step).rounded(.up))
        let framesBegan = CACurrentMediaTime()
        pausedTotal = 0
        var started = framesBegan
        var pausedBeforeStart: Double = 0
        /// Frames in a row that didn't load with Mapbox reporting errors (no network)
        var failing = 0
        var index = 0
        /// The frame the map is set up for, and its titles
        var applied = -1
        var overlay: CGImage?
        /// Back from a pause: Mapbox may have let go of some of what it had loaded
        var resuming = false

        while index < frames {
            try Task.checkCancellation()
            if applied != index {
                let elapsed = Double(index) * step
                let dt = index == 0 ? 0 : step
                let frame = director.frame(at: elapsed, dt: dt)
                apply(frame, elapsed: elapsed, dt: dt)
                // The flag at the end of the line, moving with the video's clock
                scene.updateFlag(
                    streamBearing: frame.isFinished || frame.run >= timeline.plan.length ? nil : timeline.plan.windBearing(at: frame.run),
                    moving: frame.showsRunner,
                    dt: dt
                )
                // The titles are made while Mapbox draws the map
                let overlayBegan = CACurrentMediaTime()
                let overlaySignpost = RenderTimings.signposter.beginInterval("Títulos")
                overlay = autoreleasepool { overlayImage(for: frame, elapsed: elapsed) }
                RenderTimings.signposter.endInterval("Títulos", overlaySignpost)
                timings.add(.overlay, since: overlayBegan)
                applied = index
            }
            let interruptions = watch.interruptions

            // Up to 3 s for Mapbox to draw it completely, every tile in full detail (5 s the first
            // one, and the first after a pause); only when it can't load at all (several frames in a
            // row with errors: no network) it stops waiting, so the video can't stall
            let errorsBefore = loadState.errors
            let settleBegan = CACurrentMediaTime()
            let settleSignpost = RenderTimings.signposter.beginInterval("Espera al mapa")
            let settled = await loadState.settle(
                clock: clock,
                maxSeconds: failing >= 5 ? 0.15 : (index == 0 || resuming ? 5 : 3),
                minRefreshes: 2
            )
            RenderTimings.signposter.endInterval("Espera al mapa", settleSignpost)
            try Task.checkCancellation()
            if watch.interruptions != interruptions || !watch.isActive {
                // KM2 stopped being in front while it was drawn: this frame again once it's back
                try await waitToResume()
                resuming = true
                continue
            }
            timings.add(.settle, since: settleBegan)
            failing = !settled && loadState.errors > errorsBefore ? failing + 1 : 0

            let segment = try openSegment(at: index)
            let buffer = try segment.makeBuffer()

            // The map as it's on screen now (it has settled: no need to make the screen update
            // first); one that didn't come out (blank) is waited for and drawn again, forcing it
            let snapshotBegan = CACurrentMediaTime()
            let snapshotSignpost = RenderTimings.signposter.beginInterval("Copia del mapa")
            var drew = autoreleasepool { snapshotMap(into: buffer, forcingUpdate: !settled) }
            RenderTimings.signposter.endInterval("Copia del mapa", snapshotSignpost)
            timings.add(.snapshot, since: snapshotBegan)
            var retries = 0
            while !drew && retries < 3 && watch.interruptions == interruptions {
                retries += 1
                _ = await loadState.settle(clock: clock, maxSeconds: 0.5)
                try Task.checkCancellation()
                drew = autoreleasepool { snapshotMap(into: buffer, forcingUpdate: true) }
            }

            // The frame before goes into the file first (one at a time, in order)
            let waitBegan = CACurrentMediaTime()
            try await encoding?.value
            timings.add(.encoderWait, since: waitBegan)
            try Task.checkCancellation()
            if watch.interruptions != interruptions || !watch.isActive {
                try await waitToResume()
                resuming = true
                continue
            }
            guard drew else { throw RenderError.capture }

            // Its titles and encoding off the main thread, while Mapbox draws the next frame
            let time = CMTime(value: CMTimeValue(index - segment.firstFrame), timescale: Self.framesPerSecond)
            let titles = overlay
            encoding = Task { [weak self] in
                let spent = try await segment.encode(buffer, overlay: titles, at: time)
                self?.timings.add(.blend, spent.blend)
                self?.timings.add(.encode, spent.append)
            }
            resuming = false

            progress.fraction = Self.loadingShare + (1 - Self.loadingShare) * Double(index + 1) / Double(frames)
            if index == 0 {
                started = CACurrentMediaTime()
                pausedBeforeStart = pausedTotal
            } else if index >= 15 {
                let working = CACurrentMediaTime() - started - (pausedTotal - pausedBeforeStart)
                let perFrame = working / Double(index)
                progress.remaining = perFrame * Double(frames - index - 1)
            }
            index += 1
        }

        // The last file closed (after its last frame), then the video as one file. Kept running a
        // while if KM2 goes to the background right now.
        let token = BackgroundTaskToken()
        token.begin("km2-video")
        defer { token.end() }
        closeSegment()
        if let closing {
            try await closing.value
            self.closing = nil
        }
        try Task.checkCancellation()
        let url = try await joinedVideo()
        completed = true
        timings.report(frames: frames, seconds: CACurrentMediaTime() - framesBegan - pausedTotal, preload: preloadSeconds)
        return url
    }

    // MARK: Pausing

    /// KM2 stops being in front (locked, another app, Control Center): the open file is closed now,
    /// while the encoder can still finish it.
    private func paused() {
        progress.isPaused = true
        if pauseStarted == nil {
            pauseStarted = CACurrentMediaTime()
        }
        closeSegment()
    }

    private func resumed() {
        progress.isPaused = false
        if let pauseStarted {
            pausedTotal += CACurrentMediaTime() - pauseStarted
            self.pauseStarted = nil
        }
        Self.removePausedNotice()
    }

    /// Until KM2 is in front again and the file open before has been closed.
    private func waitToResume() async throws {
        await watch?.waitUntilActive()
        try Task.checkCancellation()
        if let current = closing {
            try await current.value
            if closing == current {
                closing = nil
            }
        }
        try Task.checkCancellation()
    }

    /// The file for the frame at `index`: the open one, or a new one starting there.
    private func openSegment(at index: Int) throws -> VideoSegment {
        if let segment { return segment }
        segmentCount += 1
        let name = segmentCount == 1 ? "km2-\(videoID).mp4" : "km2-\(videoID)-\(segmentCount).mp4"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        let segment = try VideoSegment(url: url, size: job.format.videoSize, framesPerSecond: Self.framesPerSecond, firstFrame: index)
        self.segment = segment
        return segment
    }

    /// Closes the open file once the frame being encoded is in it (`closing` until it's done).
    private func closeSegment() {
        guard let segment else { return }
        self.segment = nil
        let last = encoding
        encoding = nil
        let earlier = closing
        // The encoder finishes the file even if KM2 goes to the background meanwhile
        let token = BackgroundTaskToken()
        token.begin("km2-video-segment")
        closing = Task { [weak self] in
            defer { token.end() }
            do {
                try await earlier?.value
                try await last?.value
                let frames = try await segment.finish()
                try Task.checkCancellation()
                guard frames > 0 else { return }
                if let self {
                    self.finishedSegments.append(segment.url)
                } else {
                    segment.cancel()
                }
            } catch {
                segment.cancel()
                throw error
            }
        }
    }

    /// The files as one video: the only one as it is; several joined without encoding them again.
    private func joinedVideo() async throws -> URL {
        let parts = finishedSegments
        guard let first = parts.first else { throw RenderError.writer("vacío") }
        if parts.count == 1 { return first }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("km2-\(UUID().uuidString).mp4")
        let interruptions = watch?.interruptions ?? 0
        do {
            try await Self.join(parts, into: url)
        } catch {
            // Cut short by going to the background: again once KM2 is back
            try? FileManager.default.removeItem(at: url)
            guard let watch, watch.interruptions != interruptions || !watch.isActive else { throw error }
            await watch.waitUntilActive()
            try Task.checkCancellation()
            try await Self.join(parts, into: url)
        }
        for part in parts {
            try? FileManager.default.removeItem(at: part)
        }
        finishedSegments = []
        return url
    }

    /// One video track after another into `url`, copying the encoded frames as they are.
    private static func join(_ parts: [URL], into url: URL) async throws {
        let composition = AVMutableComposition()
        guard let track = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw RenderError.writer("unir")
        }
        var cursor = CMTime.zero
        for part in parts {
            let asset = AVURLAsset(url: part)
            guard let source = try await asset.loadTracks(withMediaType: .video).first else { continue }
            let range = try await source.load(.timeRange)
            try track.insertTimeRange(range, of: source, at: cursor)
            cursor = CMTimeAdd(cursor, range.duration)
        }
        guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
            throw RenderError.writer("unir")
        }
        try? FileManager.default.removeItem(at: url)
        if #available(iOS 18, *) {
            try await export.export(to: url, as: .mp4)
        } else {
            export.outputURL = url
            export.outputFileType = .mp4
            await export.export()
            guard export.status == .completed else {
                throw RenderError.writer(export.error?.localizedDescription ?? "unir")
            }
        }
    }

    private static let pausedNoticeID = "km2-video-paused"

    /// In the background: a notification saying the video waits for KM2 (if notifications are allowed).
    private func notifyPaused() {
        let percent = Int(progress.fraction * 100)
        let token = BackgroundTaskToken()
        token.begin("km2-video-notice")
        Task {
            defer { token.end() }
            let center = UNUserNotificationCenter.current()
            let status = await center.notificationSettings().authorizationStatus
            guard status == .authorized || status == .provisional || status == .ephemeral,
                  UIApplication.shared.applicationState != .active else { return }
            let content = UNMutableNotificationContent()
            content.title = "Tu vídeo está en pausa"
            content.body = "Va por el \(percent) %. Abre KM2 para terminarlo."
            content.userInfo = ["type": AppRouter.videoRenderType]
            try? await center.add(UNNotificationRequest(identifier: Self.pausedNoticeID, content: content, trigger: nil))
        }
    }

    private static func removePausedNotice() {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [pausedNoticeID])
        center.removeDeliveredNotifications(withIdentifiers: [pausedNoticeID])
    }

    // MARK: Frames

    /// Sets the map up for `frame`: the runner's flag (fading in a quarter of a second of video, once
    /// they set off), camera and line.
    private func apply(_ frame: ReplayFrame, elapsed: Double, dt: Double) {
        let fade = CGFloat(dt / 0.25)
        flagAlpha = Self.approach(flagAlpha, frame.run > 0 ? 1 : 0, by: fade)
        scene.setFlagAlpha(flagAlpha, animated: false)
        scene.setCamera(frame.camera)
        scene.drawTrail(to: frame.trail)
        scene.updateSky(fraction: frame.run / timeline.plan.length)
        if frame.isRevealed {
            scene.addArea()
        }
    }

    private static func approach(_ value: CGFloat, _ target: CGFloat, by step: CGFloat) -> CGFloat {
        value < target ? min(target, value + step) : max(target, value - step)
    }

    /// Copies the map as Mapbox shows it now, with the flag and the rain or snow on it, into
    /// `buffer` (the titles go on later, off the main thread). False if it came out blank.
    /// `forcingUpdate`: the screen updates first (slower; for a frame that hasn't settled or came
    /// out blank).
    private func snapshotMap(into buffer: CVPixelBuffer, forcingUpdate: Bool) -> Bool {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let context = VideoSegment.context(for: buffer) else { return false }
        let rect = CGRect(x: 0, y: 0, width: context.width, height: context.height)
        // UIKit's origin is at the top left
        context.translateBy(x: 0, y: rect.height)
        context.scaleBy(x: 1, y: -1)
        UIGraphicsPushContext(context)
        defer { UIGraphicsPopContext() }
        context.setFillColor(UIColor.black.cgColor)
        context.fill(rect)
        _ = mapView.drawHierarchy(in: rect, afterScreenUpdates: forcingUpdate)
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
            endCardReveal: 1 - pow(1 - reveal, 3),
            elevation: job.extras.elevation,
            weatherCredit: job.extras.hasWeather,
            accent: Color(uiColor: job.color),
            raisedBoxes: job.extras.hasPrecipitation
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
}

// MARK: - The video's files

/// One file of the video (H.264, as before). Its frames get their titles and are encoded on a queue
/// of its own, one at a time and in order, while the map draws the next frame.
final class VideoSegment: @unchecked Sendable {
    let url: URL
    /// The frame of the whole video this file starts with
    let firstFrame: Int

    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private let framesPerSecond: Int32
    private let queue = DispatchQueue(label: "km2.video-segment", qos: .userInitiated)
    /// Frames in the file (on the queue)
    private var appended = 0

    init(url: URL, size: CGSize, framesPerSecond: Int32, firstFrame: Int) throws {
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let compression: [String: Any] = [
            AVVideoAverageBitRateKey: 12_000_000,
            AVVideoExpectedSourceFrameRateKey: Int(framesPerSecond),
            AVVideoMaxKeyFrameIntervalKey: Int(framesPerSecond),
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        ]
        let colors: [String: Any] = [
            AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
            AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
            AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
        ]
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(size.width),
            AVVideoHeightKey: Int(size.height),
            AVVideoCompressionPropertiesKey: compression,
            AVVideoColorPropertiesKey: colors,
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: Int(size.width),
            kCVPixelBufferHeightKey as String: Int(size.height),
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
        ])
        guard writer.canAdd(input) else { throw RouteVideoRenderer.RenderError.writer("formato") }
        writer.add(input)
        guard writer.startWriting() else {
            throw RouteVideoRenderer.RenderError.writer(writer.error?.localizedDescription ?? "inicio")
        }
        writer.startSession(atSourceTime: .zero)
        self.url = url
        self.firstFrame = firstFrame
        self.writer = writer
        self.input = input
        self.adaptor = adaptor
        self.framesPerSecond = framesPerSecond
    }

    /// A frame to draw into.
    func makeBuffer() throws -> CVPixelBuffer {
        guard writer.status == .writing, let pool = adaptor.pixelBufferPool else {
            throw RouteVideoRenderer.RenderError.writer(writer.error?.localizedDescription ?? "escritura")
        }
        var buffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
        guard let buffer else { throw RouteVideoRenderer.RenderError.writer("memoria") }
        return buffer
    }

    /// Puts the titles over the map in `buffer` and adds it to the file at `time`, on the file's
    /// queue; the seconds each took.
    func encode(_ buffer: CVPixelBuffer, overlay: CGImage?, at time: CMTime) async throws -> (blend: Double, append: Double) {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    let spent = try RenderTimings.signposter.withIntervalSignpost("Títulos y codificación") {
                        try self.encodeNow(buffer, overlay: overlay, at: time)
                    }
                    continuation.resume(returning: spent)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func encodeNow(_ buffer: CVPixelBuffer, overlay: CGImage?, at time: CMTime) throws -> (blend: Double, append: Double) {
        let began = CACurrentMediaTime()
        if let overlay {
            Self.blend(overlay, into: buffer)
        }
        let blended = CACurrentMediaTime()
        var waits = 0
        while !input.isReadyForMoreMediaData {
            waits += 1
            guard waits < 1000, writer.status == .writing else {
                throw RouteVideoRenderer.RenderError.writer(writer.error?.localizedDescription ?? "codificador")
            }
            usleep(2000)
        }
        guard writer.status == .writing, adaptor.append(buffer, withPresentationTime: time) else {
            throw RouteVideoRenderer.RenderError.writer(writer.error?.localizedDescription ?? "escritura")
        }
        appended += 1
        return (blended - began, CACurrentMediaTime() - blended)
    }

    /// Closes the file once every frame sent is in it; how many there are (0: none, and no file).
    func finish() async throws -> Int {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                let frames = self.appended
                guard frames > 0 else {
                    if self.writer.status == .writing { self.writer.cancelWriting() }
                    try? FileManager.default.removeItem(at: self.url)
                    continuation.resume(returning: 0)
                    return
                }
                guard self.writer.status == .writing else {
                    continuation.resume(throwing: RouteVideoRenderer.RenderError.writer(self.writer.error?.localizedDescription ?? "cierre"))
                    return
                }
                self.input.markAsFinished()
                // Each frame lasts 1/30 s, the last one too
                self.writer.endSession(atSourceTime: CMTime(value: CMTimeValue(frames), timescale: self.framesPerSecond))
                self.writer.finishWriting {
                    if self.writer.status == .completed {
                        continuation.resume(returning: frames)
                    } else {
                        continuation.resume(throwing: RouteVideoRenderer.RenderError.writer(self.writer.error?.localizedDescription ?? "cierre"))
                    }
                }
            }
        }
    }

    /// Stops writing and deletes the file (after whatever the queue is doing).
    func cancel() {
        queue.async {
            if self.writer.status == .writing { self.writer.cancelWriting() }
            try? FileManager.default.removeItem(at: self.url)
        }
    }

    /// The titles over the map. Core Graphics' origin is at the bottom left, so the image comes out
    /// upright; the overlay has the video's pixel size, so it's laid on pixel for pixel.
    private static func blend(_ overlay: CGImage, into buffer: CVPixelBuffer) {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let context = Self.context(for: buffer) else { return }
        context.draw(overlay, in: CGRect(x: 0, y: 0, width: context.width, height: context.height))
    }

    /// A drawing context on a frame's pixels (locked by the caller).
    static func context(for buffer: CVPixelBuffer) -> CGContext? {
        CGContext(
            data: CVPixelBufferGetBaseAddress(buffer),
            width: CVPixelBufferGetWidth(buffer),
            height: CVPixelBufferGetHeight(buffer),
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        )
    }
}

// MARK: - KM2 in front or not

/// Whether KM2 is in front, how many times it has stopped being, and a way to wait until it's back.
@MainActor
private final class ForegroundWatch {
    private(set) var isActive = UIApplication.shared.applicationState == .active
    /// Times KM2 has stopped being in front
    private(set) var interruptions = 0
    var onResignActive: (@MainActor () -> Void)?
    var onBackground: (@MainActor () -> Void)?
    var onActive: (@MainActor () -> Void)?

    private var observers: [NSObjectProtocol] = []
    private var waiting: [CheckedContinuation<Void, Never>] = []

    init() {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.isActive = false
                    self.interruptions += 1
                    self.onResignActive?()
                }
            },
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.onBackground?()
                }
            },
            center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.isActive = true
                    self.onActive?()
                    self.resumeWaiting()
                }
            },
        ]
    }

    func stop() {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
        observers = []
        onResignActive = nil
        onBackground = nil
        onActive = nil
        resumeWaiting()
    }

    /// Returns once KM2 is in front again (at once if it is), or the task is cancelled.
    func waitUntilActive() async {
        guard !isActive else { return }
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                if isActive || Task.isCancelled || observers.isEmpty {
                    continuation.resume()
                } else {
                    waiting.append(continuation)
                }
            }
        } onCancel: { [weak self] in
            Task { @MainActor in
                self?.resumeWaiting()
            }
        }
    }

    private func resumeWaiting() {
        let continuations = waiting
        waiting = []
        for continuation in continuations {
            continuation.resume()
        }
    }
}

// MARK: - Where the time goes

/// Where the time making a video goes, frame by frame, to see what to speed up: signposts in
/// Instruments (Points of Interest), and a summary in the console when it's done (debug builds).
private struct RenderTimings {
    static let signposter = OSSignposter(logHandle: OSLog(subsystem: Bundle.main.bundleIdentifier ?? "KM2", category: .pointsOfInterest))

    enum Phase: String, CaseIterable {
        case settle = "espera al mapa"
        case overlay = "títulos"
        case snapshot = "copia del mapa"
        case encoderWait = "espera al fotograma anterior"
        case blend = "mezcla de títulos"
        case encode = "codificación"
    }

    private var seconds: [Phase: Double] = [:]

    mutating func add(_ phase: Phase, _ value: Double) {
        seconds[phase, default: 0] += value
    }

    mutating func add(_ phase: Phase, since start: Double) {
        add(phase, CACurrentMediaTime() - start)
    }

    func report(frames: Int, seconds total: Double, preload: Double) {
        #if DEBUG
        guard frames > 0 else { return }
        let perFrame = Phase.allCases.map { phase in
            "\(phase.rawValue) \(String(format: "%.1f", (seconds[phase] ?? 0) * 1000 / Double(frames))) ms"
        }
        print("Vídeo: mapa cargado en \(String(format: "%.1f", preload)) s; \(frames) fotogramas en \(String(format: "%.1f", total)) s (\(String(format: "%.1f", total * 1000 / Double(frames))) ms cada uno). Por fotograma: \(perFrame.joined(separator: ", ")). La mezcla y la codificación van en paralelo con el mapa.")
        #endif
    }
}

// MARK: - The renderer's map on screen

/// Shows the renderer's map scaled down to fit, while it keeps drawing at its own size (the video's
/// pixels): the map only draws when it is on screen.
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
    private let mapView: ReplayMapView
    private let mapSize: CGSize

    init(mapView: ReplayMapView, mapSize: CGSize) {
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

/// Saving videos to the photo library (add-only access: KM2 can't see the library).
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
