import SwiftUI
import UIKit

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

/// The runner's flag: a pole planted at the end of the line with a cloth in the runner's colour and
/// their photo (or initial) in a white ring. A view on top of the map, so buildings and trees never
/// hide it; ReplayScene stands its pole's foot on the ground at the end of the line.
///
/// The cloth behaves like one, seen from the replay's camera:
/// - It streams away from where the runner is going (the wind of running), and swings round through
///   turns: its direction follows the run's on a damped spring, with a little overshoot.
/// - It's drawn in perspective: to the left or right of the pole as it points, shorter and slanting
///   when it points towards or away from the camera (never quite edge-on, so the photo shows).
/// - It ripples with waves that run from the pole to its free edge, out of the cloth's plane:
///   stronger and faster while running, a slow breeze and a bit of droop once planted at the finish.
/// - It's printed on both sides: the photo always reads the right way round.
/// Everything advances with the time it's given (`update`): the screen's in the app, the video's when
/// exporting, so the video is the same however fast it's made.
final class RunnerFlagView: UIView {
    private static let clothLength: CGFloat = 44
    private static let clothHeight: CGFloat = 28
    private static let poleHeight: CGFloat = 48
    private static let poleWidth: CGFloat = 2.5
    private static let strips = 32
    /// Pole in the middle, room for the cloth on either side
    private static let size = CGSize(width: 2 * (clothLength + 10), height: poleHeight + 6)

    private let pole = CAGradientLayer()
    private let knob = CAGradientLayer()
    private var stripLayers: [CALayer] = []
    private var shadeLayers: [CALayer] = []
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
    /// The side whose cloth the strips show
    private var contentsSide: CGFloat = 0

    init(runner: ReplayRunner) {
        self.runner = runner
        super.init(frame: CGRect(origin: .zero, size: Self.size))
        isUserInteractionEnabled = false
        alpha = 0
        // `center` is the foot of the pole
        layer.anchorPoint = CGPoint(x: 0.5, y: 1)
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.3
        layer.shadowRadius = 2
        layer.shadowOffset = CGSize(width: 0, height: 1)

        let stripWidth = Self.clothLength / CGFloat(Self.strips)
        for _ in 0..<Self.strips {
            let strip = CALayer()
            strip.anchorPoint = .zero
            strip.bounds = CGRect(x: 0, y: 0, width: stripWidth, height: Self.clothHeight)
            strip.contentsGravity = .resize
            strip.contentsScale = 3
            strip.edgeAntialiasingMask = []
            let shade = CALayer()
            shade.frame = strip.bounds
            shade.opacity = 0
            strip.addSublayer(shade)
            layer.addSublayer(strip)
            stripLayers.append(strip)
            shadeLayers.append(shade)
        }

        // The pole over the cloth's edge, so the cloth hangs from it
        let poleX = Self.size.width / 2
        let poleTop = Self.size.height - Self.poleHeight
        pole.frame = CGRect(x: poleX - Self.poleWidth / 2, y: poleTop, width: Self.poleWidth, height: Self.poleHeight)
        pole.colors = [UIColor(white: 0.97, alpha: 1).cgColor, UIColor(white: 0.7, alpha: 1).cgColor]
        pole.startPoint = CGPoint(x: 0, y: 0.5)
        pole.endPoint = CGPoint(x: 1, y: 0.5)
        pole.cornerRadius = Self.poleWidth / 2
        layer.addSublayer(pole)
        knob.frame = CGRect(x: poleX - 2.75, y: poleTop - 2.75, width: 5.5, height: 5.5)
        knob.cornerRadius = 2.75
        knob.colors = [UIColor.white.cgColor, UIColor(white: 0.76, alpha: 1).cgColor]
        knob.startPoint = CGPoint(x: 0.3, y: 0.2)
        knob.endPoint = CGPoint(x: 0.8, y: 1)
        layer.addSublayer(knob)

        paintCloth()
        layoutCloth(relativeYaw: 90, depthFactor: 0.64)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// The runner's photo arrived: the cloth is painted again with it.
    func setPhoto(_ image: UIImage?) {
        guard let image, image !== photo else { return }
        photo = image
        paintCloth()
    }

    /// Advances the flag by `dt` seconds and draws it for the camera.
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

    /// Places the strips for the cloth pointing `relativeYaw` degrees from the camera's direction.
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
        let top = CGPoint(x: Self.size.width / 2, y: Self.size.height - Self.poleHeight + 1)
        var points: [CGPoint] = []
        var ripple: [CGFloat] = []
        points.reserveCapacity(count + 1)
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

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if contentsSide != side {
            contentsSide = side
            let contents = side > 0 ? clothRight : clothLeft
            for strip in stripLayers {
                strip.contents = contents
            }
        }
        for index in 0..<count {
            // Left and right ends of this strip on screen, and its slice of the cloth (hoist at the pole)
            let near = points[index]
            let far = points[index + 1]
            let left = side > 0 ? near : far
            let right = side > 0 ? far : near
            let u0 = CGFloat(index) / CGFloat(count)
            let u1 = CGFloat(index + 1) / CGFloat(count)
            let slice = side > 0 ? CGRect(x: u0, y: 0, width: u1 - u0, height: 1) : CGRect(x: 1 - u1, y: 0, width: u1 - u0, height: 1)
            let width = max(0.25, right.x - left.x)
            let strip = stripLayers[index]
            strip.contentsRect = slice
            strip.position = left
            // Vertical edges, top edge from `left` to `right` (a hair wider, so no seam shows)
            strip.setAffineTransform(CGAffineTransform(a: (width + 0.3) / stripWidth, b: (right.y - left.y) / stripWidth, c: 0, d: 1, tx: 0, ty: 0))
            // Folds catch the light on one side and fall into shadow on the other
            let slope = (ripple[index + 1] - ripple[index]) / stripWidth * side
            let shade = shadeLayers[index]
            if slope < 0 {
                shade.backgroundColor = UIColor.white.cgColor
                shade.opacity = Float(min(0.4, -slope * 0.45))
            } else {
                shade.backgroundColor = UIColor.black.cgColor
                shade.opacity = Float(min(0.35, slope * 0.4))
            }
        }
        CATransaction.commit()
    }

    /// Paints the cloth for each side of the pole.
    private func paintCloth() {
        clothRight = Self.clothImage(runner: runner, photo: photo, hoistOnLeft: true).cgImage
        clothLeft = Self.clothImage(runner: runner, photo: photo, hoistOnLeft: false).cgImage
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        contentsSide = side
        for strip in stripLayers {
            strip.contents = side > 0 ? clothRight : clothLeft
        }
        CATransaction.commit()
    }

    /// The cloth flat: the runner's colour (lighter at the top), their photo or initial in a white
    /// ring a little towards the hoist, where the cloth moves least.
    private static func clothImage(runner: ReplayRunner, photo: UIImage?, hoistOnLeft: Bool) -> UIImage {
        let size = CGSize(width: clothLength, height: clothHeight)
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = 3
        format.opaque = true
        let base = UIColor(Color(hex: runner.color))
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            let cg = context.cgContext
            let colors = [shade(base, by: 1.12).cgColor, shade(base, by: 0.84).cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: size.height), options: [])
            } else {
                base.setFill()
                cg.fill(CGRect(origin: .zero, size: size))
            }
            let diameter: CGFloat = 19
            let center = CGPoint(x: size.width * (hoistOnLeft ? 0.42 : 0.58), y: size.height / 2)
            let ring = diameter + 3.5
            UIColor.white.setFill()
            cg.fillEllipse(in: CGRect(x: center.x - ring / 2, y: center.y - ring / 2, width: ring, height: ring))
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
                shade(base, by: 0.8).setFill()
                cg.fillEllipse(in: circle)
                let initial = String(runner.name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased()
                let attributes: [NSAttributedString.Key: Any] = [
                    .font: UIFont.systemFont(ofSize: 11, weight: .bold),
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
