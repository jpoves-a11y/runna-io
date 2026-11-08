import SwiftUI
import UIKit
import MapKit

// MARK: - Who ran

/// The runner of a replay, for their flag: their photo (or initial) on their territory colour.
struct ReplayRunner: Equatable {
    var name: String
    /// data-URL or http image (see AvatarView)
    var avatar: String?
    /// hex
    var color: String

    init(name: String, avatar: String?, color: String) {
        self.name = name
        self.avatar = avatar
        self.color = color
    }

    init(user: AppUser) {
        self.init(name: user.name, avatar: user.avatar, color: user.color)
    }

    init(user: UserRef) {
        self.init(name: user.name, avatar: user.avatar, color: user.color)
    }

    /// The profile photo, decoded or downloaded (cached like AvatarView's); nil shows the initial.
    func loadPhoto() async -> UIImage? {
        if let image = AvatarImageCache.image(for: avatar) { return image }
        if let avatar, avatar.hasPrefix("http"), let url = URL(string: avatar) {
            return await RemoteImageCache.shared.image(for: url)
        }
        return nil
    }
}

// MARK: - The flag

/// The runner's flag: a metal pole with a gold finial, and a cloth in the runner's colour with their
/// photo (or initial) in a white ring. It isn't a view: the line's own renderer draws it at the end of
/// the line, in the same pass as the line (ReplayTrailRenderer), so it can't lag behind it, drift from
/// it or jump onto buildings and trees. It's painted on the ground stretched away from the camera, as
/// much as the camera's tilt shortens it, so from the camera it stands up (FlagPose).
///
/// The cloth behaves like one, seen from the replay's camera:
/// - It streams away from where the runner is going (the wind of running), and swings round through
///   turns: its direction follows the run's on a damped spring, with a little overshoot.
/// - It's drawn in perspective: to the left or right of the pole as it points, shorter and slanting
///   when it points towards or away from the camera (never quite edge-on, so the photo shows).
/// - It ripples with waves that run from the pole to its free edge, out of the cloth's plane, the
///   folds catching the light: stronger and faster while running, a slow breeze and a bit of droop
///   once planted at the finish.
/// - It looks like fabric: a fine weave, a satin sheen, a hem stitched round its edges and a sleeve
///   round the pole; printed on both sides, so the photo always reads the right way round.
/// Everything advances with the time it's given (`update`): the screen's in the app, the video's when
/// exporting, so the video is the same however fast it's made.
@MainActor
final class RunnerFlag {
    static let clothLength = FlagSize.clothLength
    static let clothHeight = FlagSize.clothHeight
    static let poleHeight = FlagSize.poleHeight
    static let hoistDrop = FlagSize.hoistDrop
    static let sleeve = FlagSize.sleeve
    static let strips = FlagSize.strips

    private let runner: ReplayRunner
    private var photo: UIImage?
    /// The cloth laid out for each side of the pole (hoist at the pole, the photo reading normally)
    private var clothRight: CGImage?
    private var clothLeft: CGImage?

    // Motion state
    /// Where the cloth streams to (degrees from north), and how fast that turns (degrees per second)
    private var yaw: Double?
    private var yawSpeed: Double = 0
    /// Phase of the ripples (radians) and the wind (0 calm ... 1 running)
    private var phase: Double = 0
    private var wind: Double = 0
    /// Which side of the pole the cloth is on (+1 right, -1 left), kept while it points at the camera
    private var side: CGFloat = 1
    /// The cloth's top edge (points from the foot of the pole) and the light on each strip
    private var edge: [CGPoint] = []
    private var shades: [CGFloat] = []

    init(runner: ReplayRunner) {
        self.runner = runner
        paintCloth()
        layoutCloth(relativeYaw: 90, depthFactor: 0.64)
    }

    /// The runner's photo arrived: the cloth is painted again with it.
    func setPhoto(_ image: UIImage?) {
        guard let image, image !== photo else { return }
        photo = image
        paintCloth()
    }

    /// The flag as it is now, for the line's renderer, at `alpha`.
    func drawing(alpha: CGFloat) -> FlagDrawing {
        FlagDrawing(cloth: side > 0 ? clothRight : clothLeft, side: side, edge: edge, shades: shades, alpha: alpha)
    }

    /// Advances the flag by `dt` seconds and lays it out for the camera.
    /// - Parameters:
    ///   - streamBearing: where the cloth is blown to (degrees from north: opposite to the runner's
    ///     way); nil keeps its direction (planted at the finish).
    ///   - moving: running (strong wind) or not (a breeze).
    ///   - cameraHeading / cameraPitch: degrees, of the map's camera.
    func update(streamBearing: Double?, moving: Bool, cameraHeading: Double, cameraPitch: Double, dt: Double) {
        let step = min(0.1, max(0, dt))
        let target = streamBearing ?? yaw ?? cameraHeading + 90
        var current = yaw ?? target
        // Damped spring towards the wind's direction: it follows turns with a little swing
        let error = ReplayCamera.shortestTurn(from: current, to: target)
        let stiffness = 30.0
        let damping = 6.5
        yawSpeed += (stiffness * error - damping * yawSpeed) * step
        current += yawSpeed * step
        yaw = current
        // Wind and ripples (the phase advances, so a change of speed never jumps)
        wind += ((moving ? 1 : 0) - wind) * (1 - exp(-step / 0.6))
        phase += 2 * .pi * (0.9 + 0.9 * wind) * step

        // Seen from the camera: a direction pointing away from it shows going up the screen,
        // shortened by the camera's tilt (a near-flat map keeps a hint of depth)
        let pitch = cameraPitch * .pi / 180
        let depthFactor = cameraPitch > 20 ? cos(pitch) : 0.35
        layoutCloth(relativeYaw: current - cameraHeading, depthFactor: depthFactor)
    }

    /// Lays the cloth out pointing `relativeYaw` degrees from the camera's direction.
    private func layoutCloth(relativeYaw: Double, depthFactor: Double) {
        let angle = relativeYaw * .pi / 180
        let across = sin(angle)
        // Side of the pole, kept while the cloth points at (or away from) the camera
        if across > 0.12 { side = 1 } else if across < -0.12 { side = -1 }
        // Along the cloth on screen (never quite edge-on), and across it (where ripples push it)
        let along = CGVector(dx: side * CGFloat(max(abs(across), 0.35)), dy: CGFloat(-cos(angle) * depthFactor))
        let normal = CGVector(dx: CGFloat(cos(angle)), dy: CGFloat(sin(angle) * depthFactor))
        let amplitude = 1.6 + 2.8 * wind
        let sag = 1.2 + 3.5 * (1 - wind)

        let count = Self.strips
        let length = Self.clothLength
        let stripWidth = length / CGFloat(count)
        let top = CGPoint(x: 0, y: -Self.poleHeight + Self.hoistDrop)
        var points: [CGPoint] = []
        var ripple: [CGFloat] = []
        points.reserveCapacity(count + 1)
        ripple.reserveCapacity(count + 1)
        for index in 0...count {
            let u = Double(index) / Double(count)
            let w = CGFloat(amplitude * pow(u, 1.2) * (sin(2 * .pi * 1.1 * u - phase) + 0.3 * sin(2 * .pi * 2.4 * u - 1.6 * phase + 1.3)))
            ripple.append(w)
            let distance = CGFloat(u) * length
            points.append(CGPoint(
                x: top.x + distance * along.dx + w * normal.dx,
                y: top.y + distance * along.dy + w * normal.dy + CGFloat(sag * u * u)
            ))
        }
        // Folds catch the light on one side and fall into shadow on the other
        var light: [CGFloat] = []
        light.reserveCapacity(count)
        for index in 0..<count {
            let slope = (ripple[index + 1] - ripple[index]) / stripWidth * side
            light.append(slope < 0 ? min(0.42, -slope * 0.5) : -min(0.4, slope * 0.45))
        }
        edge = points
        shades = light
    }

    /// Paints the cloth for each side of the pole.
    private func paintCloth() {
        clothRight = Self.clothImage(runner: runner, photo: photo, hoistOnLeft: true).cgImage
        clothLeft = Self.clothImage(runner: runner, photo: photo, hoistOnLeft: false).cgImage
    }

    /// The cloth flat, as fabric: the runner's colour (lighter at the top) with a satin sheen and a
    /// fine weave, a sleeve round the pole, a darker hem stitched round the other edges, and their
    /// photo or initial in a white ring a little towards the hoist, where the cloth moves least.
    private static func clothImage(runner: ReplayRunner, photo: UIImage?, hoistOnLeft: Bool) -> UIImage {
        let size = CGSize(width: clothLength, height: clothHeight)
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = 3
        format.opaque = true
        let base = UIColor(Color(hex: runner.color))
        let space = CGColorSpaceCreateDeviceRGB()
        /// x measured from the hoist (the pole's side of the cloth)
        func hoistX(_ fromHoist: CGFloat) -> CGFloat { hoistOnLeft ? fromHoist : size.width - fromHoist }
        func rect(fromHoist start: CGFloat, width: CGFloat, y: CGFloat, height: CGFloat) -> CGRect {
            CGRect(x: hoistOnLeft ? start : size.width - start - width, y: y, width: width, height: height)
        }

        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            let cg = context.cgContext
            let bounds = CGRect(origin: .zero, size: size)

            // Colour, lighter at the top
            if let gradient = CGGradient(colorsSpace: space, colors: [shade(base, by: 1.12).cgColor, shade(base, by: 0.82).cgColor] as CFArray, locations: [0, 1]) {
                cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: size.height), options: [])
            } else {
                base.setFill()
                cg.fill(bounds)
            }

            // Satin sheen: a soft diagonal band of light from the hoist's top, and a fainter one further on
            let light = UIColor.white
            if let sheen = CGGradient(colorsSpace: space, colors: [
                light.withAlphaComponent(0).cgColor,
                light.withAlphaComponent(0.16).cgColor,
                light.withAlphaComponent(0).cgColor,
                light.withAlphaComponent(0.06).cgColor,
                light.withAlphaComponent(0).cgColor,
            ] as CFArray, locations: [0.1, 0.32, 0.55, 0.85, 1]) {
                cg.drawLinearGradient(sheen, start: CGPoint(x: hoistX(0), y: 0), end: CGPoint(x: hoistX(size.width * 0.75), y: size.height * 1.1), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            }

            // Weave: a darker thread every point across, a lighter one along (one pixel each)
            let thread: CGFloat = 1 / 3
            cg.setFillColor(UIColor.black.withAlphaComponent(0.07).cgColor)
            for y in stride(from: CGFloat(0), to: size.height, by: 1) {
                cg.fill(CGRect(x: 0, y: y, width: size.width, height: thread))
            }
            cg.setFillColor(UIColor.white.withAlphaComponent(0.045).cgColor)
            for x in stride(from: CGFloat(0), to: size.width, by: 1) {
                cg.fill(CGRect(x: x, y: 0, width: thread, height: size.height))
            }

            // Sleeve round the pole: round, so dark at both edges and lit in the middle
            let sleeve = Self.sleeve
            let sleeveRect = rect(fromHoist: 0, width: sleeve, y: 0, height: size.height)
            if let round = CGGradient(colorsSpace: space, colors: [
                UIColor.black.withAlphaComponent(0.36).cgColor,
                UIColor.black.withAlphaComponent(0.06).cgColor,
                UIColor.black.withAlphaComponent(0.3).cgColor,
            ] as CFArray, locations: [0, 0.5, 1]) {
                cg.saveGState()
                cg.clip(to: sleeveRect)
                cg.drawLinearGradient(round, start: CGPoint(x: sleeveRect.minX, y: 0), end: CGPoint(x: sleeveRect.maxX, y: 0), options: [])
                cg.restoreGState()
            }

            // Hem: a darker band along the top, the bottom and the free edge
            let hem: CGFloat = 1.2
            cg.setFillColor(UIColor.black.withAlphaComponent(0.2).cgColor)
            cg.fill(rect(fromHoist: sleeve, width: size.width - sleeve, y: 0, height: hem))
            cg.fill(rect(fromHoist: sleeve, width: size.width - sleeve, y: size.height - hem, height: hem))
            cg.fill(rect(fromHoist: size.width - hem, width: hem, y: hem, height: size.height - 2 * hem))

            // Stitching: inside the hem, and the seam of the sleeve
            let inset: CGFloat = 2.2
            let seam = sleeve + 0.6
            cg.setStrokeColor(UIColor.white.withAlphaComponent(0.5).cgColor)
            cg.setLineWidth(0.5)
            cg.setLineCap(.butt)
            cg.setLineDash(phase: 0, lengths: [1.4, 1.1])
            cg.move(to: CGPoint(x: hoistX(seam + 1), y: inset))
            cg.addLine(to: CGPoint(x: hoistX(size.width - inset), y: inset))
            cg.addLine(to: CGPoint(x: hoistX(size.width - inset), y: size.height - inset))
            cg.addLine(to: CGPoint(x: hoistX(seam + 1), y: size.height - inset))
            cg.strokePath()
            cg.setLineDash(phase: 0, lengths: [1.2, 1])
            cg.move(to: CGPoint(x: hoistX(seam), y: 1))
            cg.addLine(to: CGPoint(x: hoistX(seam), y: size.height - 1))
            cg.strokePath()
            cg.setLineDash(phase: 0, lengths: [])

            // The photo (or initial) in a white ring, lifted off the cloth by a soft shadow
            let diameter: CGFloat = 20
            let ring = diameter + 3.4
            let center = CGPoint(x: hoistX(sleeve + 0.45 * (size.width - sleeve)), y: size.height / 2)
            let ringRect = CGRect(x: center.x - ring / 2, y: center.y - ring / 2, width: ring, height: ring)
            cg.saveGState()
            cg.setShadow(offset: CGSize(width: 0, height: 0.6), blur: 2.4, color: UIColor.black.withAlphaComponent(0.35).cgColor)
            cg.setFillColor(UIColor.white.cgColor)
            cg.fillEllipse(in: ringRect)
            cg.restoreGState()
            cg.setStrokeColor(shade(base, by: 0.65).withAlphaComponent(0.6).cgColor)
            cg.setLineWidth(0.5)
            cg.strokeEllipse(in: ringRect.insetBy(dx: 0.25, dy: 0.25))
            let circle = CGRect(x: center.x - diameter / 2, y: center.y - diameter / 2, width: diameter, height: diameter)
            if let photo {
                cg.saveGState()
                cg.addEllipse(in: circle)
                cg.clip()
                let scale = max(diameter / max(1, photo.size.width), diameter / max(1, photo.size.height))
                let drawn = CGSize(width: photo.size.width * scale, height: photo.size.height * scale)
                photo.draw(in: CGRect(x: center.x - drawn.width / 2, y: center.y - drawn.height / 2, width: drawn.width, height: drawn.height))
                cg.restoreGState()
            } else {
                cg.saveGState()
                cg.addEllipse(in: circle)
                cg.clip()
                if let disc = CGGradient(colorsSpace: space, colors: [shade(base, by: 0.95).cgColor, shade(base, by: 0.7).cgColor] as CFArray, locations: [0, 1]) {
                    cg.drawRadialGradient(disc, startCenter: CGPoint(x: center.x - 3, y: center.y - 4), startRadius: 0, endCenter: center, endRadius: diameter / 2, options: [.drawsAfterEndLocation])
                }
                cg.restoreGState()
                let initial = String(runner.name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased()
                var font = UIFont.systemFont(ofSize: 12, weight: .heavy)
                if let rounded = font.fontDescriptor.withDesign(.rounded) {
                    font = UIFont(descriptor: rounded, size: 12)
                }
                let attributes: [NSAttributedString.Key: Any] = [
                    .font: font,
                    .foregroundColor: UIColor.white,
                ]
                let text = initial as NSString
                let textSize = text.size(withAttributes: attributes)
                text.draw(at: CGPoint(x: center.x - textSize.width / 2, y: center.y - textSize.height / 2), withAttributes: attributes)
            }
        }
    }

    private static func shade(_ color: UIColor, by factor: CGFloat) -> UIColor {
        var hue: CGFloat = 0
        var saturation: CGFloat = 0
        var brightness: CGFloat = 0
        var alpha: CGFloat = 0
        guard color.getHue(&hue, saturation: &saturation, brightness: &brightness, alpha: &alpha) else { return color }
        return UIColor(hue: hue, saturation: saturation, brightness: min(1, brightness * factor), alpha: alpha)
    }
}

// MARK: - Drawing the flag at the end of the line

/// The flag's sizes (points, as seen on screen), readable from MapKit's drawing threads.
enum FlagSize {
    static let clothLength: CGFloat = 46
    static let clothHeight: CGFloat = 30
    static let poleHeight: CGFloat = 50
    static let poleWidth: CGFloat = 3
    static let finialSize: CGFloat = 7
    /// Where the cloth hangs from, below the top of the pole
    static let hoistDrop: CGFloat = 2.5
    /// Width of the sleeve the cloth wraps the pole with
    static let sleeve: CGFloat = 4
    static let strips = 32
}

/// The runner's flag at one moment, for the line's renderer (it draws on MapKit's drawing threads,
/// so it's immutable). In the flag's own space: points, x to the right, y down, the foot of the pole
/// at the origin.
struct FlagDrawing: @unchecked Sendable {
    let cloth: CGImage?
    let side: CGFloat
    /// The cloth's top edge, hoist first
    let edge: [CGPoint]
    /// Light (+) or shadow (−) on each strip
    let shades: [CGFloat]
    let alpha: CGFloat

    /// Everything it can cover, in its own space
    static let extent = CGRect(
        x: -(FlagSize.clothLength + 12),
        y: -(FlagSize.poleHeight + FlagSize.clothLength + 8),
        width: 2 * (FlagSize.clothLength + 12),
        height: FlagSize.poleHeight + 2 * FlagSize.clothLength + 30
    )

    private static let space = CGColorSpaceCreateDeviceRGB()
    /// Brushed metal across the pole: dark at its edges, a highlight off-centre
    private static let metal = CGGradient(
        colorsSpace: space,
        colors: [0.45, 0.98, 0.82, 0.55, 0.38].map { CGColor(gray: $0, alpha: 1) } as CFArray,
        locations: [0, 0.3, 0.55, 0.8, 1]
    )
    /// A gold ball, lit from the upper left
    private static let gold = CGGradient(
        colorsSpace: space,
        colors: [
            CGColor(red: 1, green: 0.965, blue: 0.784, alpha: 1),
            CGColor(red: 0.949, green: 0.757, blue: 0.306, alpha: 1),
            CGColor(red: 0.69, green: 0.478, blue: 0.086, alpha: 1),
            CGColor(red: 0.431, green: 0.29, blue: 0.039, alpha: 1),
        ] as CFArray,
        locations: [0, 0.35, 0.8, 1]
    )

    /// Draws it in `context`, whose space is the flag's.
    func draw(in context: CGContext) {
        guard alpha > 0.01, edge.count > 1 else { return }
        let length = FlagSize.clothLength
        let height = FlagSize.clothHeight
        let count = edge.count - 1
        let stripWidth = length / CGFloat(count)
        context.saveGState()
        context.setAlpha(alpha)
        context.beginTransparencyLayer(auxiliaryInfo: nil)

        // The cloth, strip by strip: each one's top edge from one point of the edge to the next,
        // its slice of the cloth (hoist at the pole), its light
        if let cloth {
            for index in 0..<count {
                let near = edge[index]
                let far = edge[index + 1]
                let left = side > 0 ? near : far
                let right = side > 0 ? far : near
                let sliceStart = side > 0 ? CGFloat(index) / CGFloat(count) : 1 - CGFloat(index + 1) / CGFloat(count)
                let width = max(0.25, right.x - left.x)
                context.saveGState()
                context.concatenate(CGAffineTransform(a: (width + 0.3) / stripWidth, b: (right.y - left.y) / stripWidth, c: 0, d: 1, tx: left.x, ty: left.y))
                let strip = CGRect(x: 0, y: 0, width: stripWidth, height: height)
                context.clip(to: strip)
                // The image upright in this y-down space
                context.saveGState()
                context.translateBy(x: 0, y: height)
                context.scaleBy(x: 1, y: -1)
                context.draw(cloth, in: CGRect(x: -sliceStart * length, y: 0, width: length, height: height))
                context.restoreGState()
                let light = shades[index]
                if abs(light) > 0.005 {
                    context.setFillColor(gray: light > 0 ? 1 : 0, alpha: abs(light))
                    context.fill(strip)
                }
                context.restoreGState()
            }
        }

        // The pole, over the cloth's sleeve
        let poleWidth = FlagSize.poleWidth
        let poleHeight = FlagSize.poleHeight
        let pole = CGRect(x: -poleWidth / 2, y: -poleHeight, width: poleWidth, height: poleHeight)
        context.saveGState()
        context.addPath(CGPath(roundedRect: pole, cornerWidth: poleWidth / 2, cornerHeight: poleWidth / 2, transform: nil))
        context.clip()
        if let metal = Self.metal {
            context.drawLinearGradient(metal, start: CGPoint(x: pole.minX, y: 0), end: CGPoint(x: pole.maxX, y: 0), options: [])
        } else {
            context.setFillColor(gray: 0.8, alpha: 1)
            context.fill(pole)
        }
        context.restoreGState()
        context.setStrokeColor(gray: 0, alpha: 0.28)
        context.setLineWidth(0.4)
        context.addPath(CGPath(roundedRect: pole, cornerWidth: poleWidth / 2, cornerHeight: poleWidth / 2, transform: nil))
        context.strokePath()

        // The finial
        let size = FlagSize.finialSize
        let ball = CGRect(x: -size / 2, y: -poleHeight - size / 2, width: size, height: size)
        context.saveGState()
        context.addEllipse(in: ball)
        context.clip()
        if let gold = Self.gold {
            let center = CGPoint(x: ball.minX + 0.35 * size, y: ball.minY + 0.3 * size)
            context.drawRadialGradient(gold, startCenter: center, startRadius: 0, endCenter: center, endRadius: 0.65 * size * 1.2, options: [.drawsAfterEndLocation])
        }
        context.restoreGState()

        context.endTransparencyLayer()
        context.restoreGState()
    }
}

/// How the flag is painted on the ground at the end of the line so that, from the camera, it stands
/// up: the flag's x along the camera's right, its height (up the screen) stretched away from the
/// camera by as much as the camera's tilt shortens the ground. Scaled so a point of the flag is a
/// point on screen there.
struct FlagPose: Sendable {
    /// Of the camera, radians
    let heading: Double
    /// cos(pitch), kept above 0.3 so it never stretches out of all proportion
    let cosPitch: Double
    /// Map points per screen point at the end of the line
    let mapPointsPerPoint: Double

    /// From the flag's space to the map points around `foot` (in the renderer's drawing space, which
    /// is in map points, y south).
    func transform(foot: CGPoint) -> CGAffineTransform {
        let k = mapPointsPerPoint
        let stretch = k / cosPitch
        // Right: east cos(h), north −sin(h) → map (cos h, sin h). Up the screen (−y): away from the
        // camera, east sin(h), north cos(h) → map (sin h, −cos h)
        return CGAffineTransform(
            a: CGFloat(k * cos(heading)), b: CGFloat(k * sin(heading)),
            c: CGFloat(-stretch * sin(heading)), d: CGFloat(stretch * cos(heading)),
            tx: foot.x, ty: foot.y
        )
    }

    /// The map rect the flag can cover with its foot at `foot`.
    func mapRect(foot: MKMapPoint) -> MKMapRect {
        let rect = FlagDrawing.extent.applying(transform(foot: CGPoint(x: foot.x, y: foot.y)))
        return MKMapRect(x: Double(rect.minX), y: Double(rect.minY), width: Double(rect.width), height: Double(rect.height))
    }
}
