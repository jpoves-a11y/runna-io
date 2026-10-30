import AVFoundation
import MapKit
import UIKit

/// Cinematic 2D video of a run, generated off screen (no screen recording): 1080×1920, 30 fps.
/// Opening card → the camera follows the route as it's drawn on a dark map, with distance and time
/// counting → the camera pulls back, the conquered territory fills in and the figures appear
/// (territory, steals, place in the week) → closing card with the Runna.io mark.
enum ShareVideoRenderer {
    static let width = 1080
    static let height = 1920
    static let fps: Int32 = 30

    /// Timeline in seconds at 1× (the drawing part is divided by the speed).
    struct Timeline {
        var intro = 1.4
        var draw: Double
        var pullBack = 1.3
        var reveal = 2.6
        var outro = 1.8

        init(distanceMeters: Double, speed: Double) {
            draw = min(max(distanceMeters / 1000 * 0.9 + 4, 5), 10) / max(speed, 0.25)
        }

        var total: Double { intro + draw + pullBack + reveal + outro }
        var frameCount: Int { Int((total * Double(ShareVideoRenderer.fps)).rounded()) }
    }

    /// What the frames show, read from the share context before rendering in the background.
    struct Script {
        let run: ShareRun
        let newArea: Double
        let victims: [String]
        let rank: Int?
        let players: Int
        let castles: Int
    }

    @MainActor
    static func render(context: ShareContext, speed: Double, progress: @escaping @MainActor (Double) -> Void) async throws -> URL {
        let run = context.run
        let script = Script(
            run: run,
            newArea: context.newArea,
            victims: context.victims.map(\.userName),
            rank: context.weekRank,
            players: context.weekPlayers,
            castles: context.castlesBuilt
        )
        // The whole route framed in the upper 70 % (room for the figures); 4.5x so the close-up
        // (2.3x zoom) is still sharp at 1080 px
        let points = CGSize(width: CGFloat(width) / 2, height: CGFloat(height) / 2)
        guard let snapshot = await ShareMapRenderer.snapshot(run, size: points, scale: 4.5, bottomInset: 0.3) else {
            throw RenderError.map
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("Runna-\(Int(Date().timeIntervalSince1970)).mp4")
        try? FileManager.default.removeItem(at: url)
        let timeline = Timeline(distanceMeters: run.distance, speed: speed)
        let logo = UIImage(named: "RunnaMark")

        try await Task.detached(priority: .userInitiated) {
            try await ShareVideoRenderer.write(to: url, timeline: timeline) { frame, cg in
                ShareVideoRenderer.drawFrame(frame, timeline: timeline, script: script, snapshot: snapshot, logo: logo, in: cg)
            } progress: { value in
                await progress(value)
            }
        }.value
        return url
    }

    enum RenderError: LocalizedError {
        case map, writer
        var errorDescription: String? {
            switch self {
            case .map: return "no se ha podido cargar el mapa"
            case .writer: return "no se ha podido escribir el vídeo"
            }
        }
    }

    // MARK: Writing

    private static func write(to url: URL, timeline: Timeline,
                              draw: (Int, CGContext) -> Void,
                              progress: (Double) async -> Void) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 12_000_000],
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
        ])
        guard writer.canAdd(input) else { throw RenderError.writer }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? RenderError.writer }
        writer.startSession(atSourceTime: .zero)

        let frames = timeline.frameCount
        for frame in 0..<frames {
            try Task.checkCancellation()
            while !input.isReadyForMoreMediaData {
                try await Task.sleep(nanoseconds: 5_000_000)
            }
            guard let pool = adaptor.pixelBufferPool else { throw RenderError.writer }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
            guard let buffer else { throw RenderError.writer }
            CVPixelBufferLockBaseAddress(buffer, [])
            if let cg = CGContext(
                data: CVPixelBufferGetBaseAddress(buffer),
                width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
            ) {
                // UIKit coordinates (origin top left)
                cg.translateBy(x: 0, y: CGFloat(height))
                cg.scaleBy(x: 1, y: -1)
                UIGraphicsPushContext(cg)
                draw(frame, cg)
                UIGraphicsPopContext()
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            if !adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: fps)) {
                throw writer.error ?? RenderError.writer
            }
            if frame % 6 == 0 { await progress(Double(frame) / Double(frames)) }
        }
        input.markAsFinished()
        await writer.finishWriting()
        if writer.status != .completed { throw writer.error ?? RenderError.writer }
        await progress(1)
    }

    // MARK: Frames

    private static let canvas = CGSize(width: width, height: height)

    private static func drawFrame(_ frame: Int, timeline: Timeline, script: Script,
                                  snapshot: MKMapSnapshotter.Snapshot, logo: UIImage?, in cg: CGContext) {
        let t = Double(frame) / Double(fps)
        let drawStart = timeline.intro
        let pullStart = drawStart + timeline.draw
        let revealStart = pullStart + timeline.pullBack
        let outroStart = revealStart + timeline.reveal

        let routeProgress = ease(clamp((t - drawStart) / timeline.draw))
        let pull = ease(clamp((t - pullStart) / timeline.pullBack))
        let territoryAlpha = CGFloat(clamp((t - revealStart) / 0.8))

        // Camera: close behind the head while drawing, then back to the whole route
        let image = snapshot.image
        let imageSize = image.size // points of the snapshot (the full frame)
        let zoom = 2.3 - 1.3 * pull
        let cropSize = CGSize(width: imageSize.width / zoom, height: imageSize.height / zoom)
        let route = ShareGeometry.thinned(script.run.coordinates, maxPoints: 800)
        let projected = route.map { snapshot.point(for: $0) }
        let head = ShareMapRenderer.prefix(projected, progress: routeProgress).last ?? CGPoint(x: imageSize.width / 2, y: imageSize.height / 2)
        let fullCenter = CGPoint(x: imageSize.width / 2, y: imageSize.height / 2)
        // The runner sits a bit below the middle (more road ahead)
        let followCenter = CGPoint(x: head.x, y: head.y - cropSize.height * 0.08)
        var center = CGPoint(
            x: followCenter.x + (fullCenter.x - followCenter.x) * pull,
            y: followCenter.y + (fullCenter.y - followCenter.y) * pull
        )
        center.x = min(max(center.x, cropSize.width / 2), imageSize.width - cropSize.width / 2)
        center.y = min(max(center.y, cropSize.height / 2), imageSize.height - cropSize.height / 2)
        let crop = CGRect(x: center.x - cropSize.width / 2, y: center.y - cropSize.height / 2, width: cropSize.width, height: cropSize.height)
        let factor = canvas.width / crop.width
        let toCanvas = { (p: CGPoint) in CGPoint(x: (p.x - crop.minX) * factor, y: (p.y - crop.minY) * factor) }

        // Map: only the visible part of the big snapshot, drawn through UIKit (not upside down)
        let pixels = CGRect(x: crop.minX * image.scale, y: crop.minY * image.scale,
                            width: crop.width * image.scale, height: crop.height * image.scale).integral
        if let visible = image.cgImage?.cropping(to: pixels) {
            UIImage(cgImage: visible).draw(in: CGRect(origin: .zero, size: canvas))
        }
        ShareMapRenderer.draw(
            script.run, on: cg,
            project: { toCanvas(snapshot.point(for: $0)) },
            progress: max(routeProgress, 0.001),
            territoryAlpha: territoryAlpha,
            lineScale: 2.4
        )
        // Runner
        if t >= drawStart && t < pullStart + 0.3 {
            let p = toCanvas(head)
            let dot = CGRect(x: p.x - 22, y: p.y - 22, width: 44, height: 44)
            cg.setFillColor(UIColor.white.cgColor)
            cg.fillEllipse(in: dot)
            cg.setFillColor(script.run.uiColor.cgColor)
            cg.fillEllipse(in: dot.insetBy(dx: 8, dy: 8))
        }

        // Bottom shade for the text
        drawGradient(cg, from: canvas.height * 0.55, to: canvas.height, alpha: 0.85)
        drawWordmark(logo, at: CGPoint(x: 64, y: 96), size: 44, alpha: 1)

        // Counters while running
        if t < revealStart {
            let alpha = CGFloat(clamp((t - drawStart) / 0.4))
            let meters = script.run.distance * routeProgress
            let seconds = Int(Double(script.run.duration) * routeProgress)
            drawText(Format.distance(meters), size: 120, weight: .bold, condensed: true, alpha: alpha, at: CGPoint(x: 64, y: canvas.height - 330))
            drawText(Format.duration(seconds), size: 64, weight: .semibold, condensed: true, alpha: alpha * 0.8, at: CGPoint(x: 64, y: canvas.height - 190))
        } else {
            drawReveal(script, since: t - revealStart)
        }

        // Opening and closing cards
        if t < drawStart {
            let alpha = CGFloat(1 - clamp((t - (drawStart - 0.5)) / 0.5))
            drawCard(script.run, alpha: alpha, logo: logo, closing: false)
        }
        if t >= outroStart {
            drawCard(script.run, alpha: CGFloat(clamp((t - outroStart) / 0.5)), logo: logo, closing: true)
        }
    }

    /// The figures, one line after another.
    private static func drawReveal(_ script: Script, since: Double) {
        var lines: [(String, UIColor, CGFloat)] = []
        var stats = [Format.distance(script.run.distance), Format.duration(script.run.duration)]
        if let pace = script.run.paceText { stats.append("\(pace) /km") }
        lines.append((stats.joined(separator: "  ·  "), .white, 54))
        if script.newArea > 0 {
            lines.append(("+\(Format.area(script.newArea)) conquistados", script.run.uiColor, 64))
        }
        if !script.victims.isEmpty {
            lines.append(("Robado a \(ShareStyle.names(script.victims))", UIColor(red: 1, green: 0.42, blue: 0.35, alpha: 1), 48))
        }
        if script.castles > 0 {
            lines.append((script.castles == 1 ? "+1 castillo" : "+\(script.castles) castillos", .white, 44))
        }
        if let rank = script.rank, script.players > 1 {
            lines.append(("\(rank).º de \(script.players) esta semana", UIColor(red: 1, green: 0.78, blue: 0.2, alpha: 1), 48))
        }
        var y = canvas.height - 120 - CGFloat(lines.count) * 88
        for (index, line) in lines.enumerated() {
            let appear = clamp((since - Double(index) * 0.3) / 0.45)
            drawText(line.0, size: line.2, weight: .bold, condensed: true, color: line.1,
                     alpha: CGFloat(appear), at: CGPoint(x: 64, y: y + CGFloat(1 - appear) * 30))
            y += 88
        }
    }

    /// Full-screen card: the run at the start, the Runna.io mark at the end.
    private static func drawCard(_ run: ShareRun, alpha: CGFloat, logo: UIImage?, closing: Bool) {
        guard alpha > 0, let cg = UIGraphicsGetCurrentContext() else { return }
        cg.saveGState()
        cg.setAlpha(alpha)
        let colors = [run.uiColor.withAlphaComponent(0.85).cgColor, UIColor(red: 0.043, green: 0.051, blue: 0.063, alpha: 1).cgColor]
        if let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors as CFArray, locations: [0, 0.55]) {
            cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: canvas.height), options: [.drawsAfterEndLocation])
        }
        if closing {
            logo?.draw(in: CGRect(x: canvas.width / 2 - 130, y: canvas.height / 2 - 260, width: 260, height: 260).insetBy(dx: 0, dy: 0))
            drawText("Runna.io", size: 96, weight: .bold, condensed: true, at: CGPoint(x: 0, y: canvas.height / 2 + 40), centered: true)
            drawText("Conquista tu ciudad corriendo", size: 44, weight: .medium, alpha: 0.75, at: CGPoint(x: 0, y: canvas.height / 2 + 170), centered: true)
        } else {
            drawText(run.name, size: 76, weight: .bold, at: CGPoint(x: 0, y: canvas.height / 2 - 200), centered: true)
            if let date = run.date {
                drawText(ShareStyle.day(date), size: 44, weight: .medium, alpha: 0.7, at: CGPoint(x: 0, y: canvas.height / 2 - 90), centered: true)
            }
            drawText(Format.distance(run.distance), size: 150, weight: .bold, condensed: true, color: run.uiColor, at: CGPoint(x: 0, y: canvas.height / 2 + 10), centered: true)
            drawWordmark(logo, at: CGPoint(x: canvas.width / 2 - 130, y: canvas.height - 220), size: 52, alpha: 1)
        }
        cg.restoreGState()
    }

    // MARK: Drawing helpers

    private static func drawWordmark(_ logo: UIImage?, at origin: CGPoint, size: CGFloat, alpha: CGFloat) {
        let logoRect = CGRect(x: origin.x, y: origin.y, width: size * 1.35, height: size * 1.35)
        if let logo {
            let clip = UIBezierPath(roundedRect: logoRect, cornerRadius: size * 0.32)
            UIGraphicsGetCurrentContext()?.saveGState()
            clip.addClip()
            logo.draw(in: logoRect, blendMode: .normal, alpha: alpha)
            UIGraphicsGetCurrentContext()?.restoreGState()
        }
        drawText("Runna.io", size: size, weight: .semibold, condensed: true, alpha: alpha * 0.92,
                 at: CGPoint(x: logoRect.maxX + size * 0.4, y: origin.y + (logoRect.height - size * 1.2) / 2))
    }

    private static func drawText(_ text: String, size: CGFloat, weight: UIFont.Weight, condensed: Bool = false,
                                 color: UIColor = .white, alpha: CGFloat = 1, at point: CGPoint, centered: Bool = false) {
        guard alpha > 0.01 else { return }
        let font = condensed
            ? UIFont.systemFont(ofSize: size, weight: weight, width: .condensed)
            : UIFont.systemFont(ofSize: size, weight: weight)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = centered ? .center : .left
        paragraph.lineBreakMode = .byTruncatingTail
        let shadow = NSShadow()
        shadow.shadowColor = UIColor.black.withAlphaComponent(0.45)
        shadow.shadowBlurRadius = 8
        shadow.shadowOffset = CGSize(width: 0, height: 2)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: color.withAlphaComponent(alpha),
            .paragraphStyle: paragraph,
            .shadow: shadow,
        ]
        let width = centered ? canvas.width : canvas.width - point.x - 48
        (text as NSString).draw(in: CGRect(x: centered ? 0 : point.x, y: point.y, width: width, height: size * 1.4), withAttributes: attributes)
    }

    private static func drawGradient(_ cg: CGContext, from top: CGFloat, to bottom: CGFloat, alpha: CGFloat) {
        let colors = [UIColor.black.withAlphaComponent(0).cgColor, UIColor.black.withAlphaComponent(alpha).cgColor]
        guard let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors as CFArray, locations: [0, 1]) else { return }
        cg.drawLinearGradient(gradient, start: CGPoint(x: 0, y: top), end: CGPoint(x: 0, y: bottom), options: [.drawsAfterEndLocation])
    }

    static func clamp(_ value: Double) -> Double { min(max(value, 0), 1) }

    /// Smooth start and end.
    static func ease(_ t: Double) -> Double { t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2 }
}
