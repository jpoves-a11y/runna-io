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

// MARK: - Where the ground is

/// How far MapKit's placement of the runner is from `convert`'s projection of it, without the lifts
/// of the 3D model. `convert` puts a coordinate at sea level: in 3D the ground is higher, so it's off
/// by an offset that changes smoothly with the terrain. MapKit puts annotations on the terrain, as
/// the line, but in cities with a 3D satellite model it puts them on that model: on trees and roofs,
/// up on screen by a few metres, in jumps from one frame to the next. The offset follows the
/// terrain smoothly, and a sudden jump up is taken as the model and held off until the runner is
/// back on the ground (at most 2 s). Tuned on the jumps measured in a Turin video.
struct RunnerGroundOffset {
    private(set) var value: CGPoint?
    private var last: CGPoint?
    private var lifted = false
    private var liftedSince: CFTimeInterval = 0
    private var time: CFTimeInterval = 0

    /// `offset` measured at `now`. `detectsLifts`: while the runner runs (otherwise it's just followed).
    mutating func update(_ offset: CGPoint, at now: CFTimeInterval, detectsLifts: Bool) {
        defer {
            self.last = offset
            self.time = now
        }
        guard detectsLifts, let current = value, let last,
              abs(offset.x - current.x) < 150, abs(offset.y - current.y) < 150 else {
            value = offset
            lifted = false
            return
        }
        let dt = min(0.1, max(0, now - time))
        var next = current
        next.x += (offset.x - current.x) * CGFloat(1 - exp(-dt / 0.15))
        if lifted {
            if offset.y >= current.y - 2 {
                // Back on the ground
                lifted = false
                next.y = offset.y
            } else if now - liftedSince > 2 {
                lifted = false
            }
        } else if offset.y - last.y < -max(3, CGFloat(60 * dt)) {
            // Up at once: a tree or a roof of the 3D model under the runner, not the ground
            lifted = true
            liftedSince = now
        } else {
            next.y += (offset.y - current.y) * CGFloat(1 - exp(-dt / 0.08))
        }
        value = next
    }
}

// MARK: - The flag

/// The runner's flag: a pole planted at the end of the line with a cloth in the runner's colour and
/// their photo (or initial) in a white ring, waving. It's a view on top of the map, so buildings and
/// trees never hide it; ReplayScene puts the pole's foot on the ground at the end of the line.
///
/// The cloth waves like fabric: it's cut into thin vertical strips that follow two travelling waves
/// (bigger towards the free edge, still at the pole), each narrowed by its slope (the cloth looks
/// shorter where it folds) and shaded light or dark by it (folds catch the light). Everything is set
/// for a given time (`wave(at:)`), the screen's in the app and the video's when exporting.
final class RunnerFlagView: UIView {
    private static let poleHeight: CGFloat = 46
    private static let poleWidth: CGFloat = 2.5
    private static let clothSize = CGSize(width: 42, height: 28)
    private static let strips = 32
    /// Pole at the left edge (its centre), cloth from its right side, under the knob
    private static let poleX: CGFloat = 4.5
    private static let clothTop: CGFloat = 6
    private static let size = CGSize(width: 56, height: 54)

    private let pole = CAGradientLayer()
    private let knob = CAGradientLayer()
    private var stripLayers: [CALayer] = []
    private var shadeLayers: [CALayer] = []
    private let runner: ReplayRunner
    private var photo: UIImage?

    init(runner: ReplayRunner) {
        self.runner = runner
        super.init(frame: CGRect(origin: .zero, size: Self.size))
        isUserInteractionEnabled = false
        alpha = 0
        // `center` is the foot of the pole
        layer.anchorPoint = CGPoint(x: Self.poleX / Self.size.width, y: 1)
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.35
        layer.shadowRadius = 2
        layer.shadowOffset = CGSize(width: 0, height: 1)

        let poleTop = Self.size.height - Self.poleHeight
        pole.frame = CGRect(x: Self.poleX - Self.poleWidth / 2, y: poleTop, width: Self.poleWidth, height: Self.poleHeight)
        pole.colors = [UIColor(white: 0.97, alpha: 1).cgColor, UIColor(white: 0.72, alpha: 1).cgColor]
        pole.startPoint = CGPoint(x: 0, y: 0.5)
        pole.endPoint = CGPoint(x: 1, y: 0.5)
        pole.cornerRadius = Self.poleWidth / 2
        layer.addSublayer(pole)

        let clothImage = Self.clothImage(runner: runner, photo: nil)
        for index in 0..<Self.strips {
            let strip = CALayer()
            strip.contents = clothImage.cgImage
            strip.contentsScale = clothImage.scale
            strip.contentsGravity = .resize
            strip.contentsRect = CGRect(x: CGFloat(index) / CGFloat(Self.strips), y: 0, width: 1 / CGFloat(Self.strips), height: 1)
            strip.edgeAntialiasingMask = []
            let shade = CALayer()
            shade.opacity = 0
            strip.addSublayer(shade)
            layer.addSublayer(strip)
            stripLayers.append(strip)
            shadeLayers.append(shade)
        }

        knob.frame = CGRect(x: Self.poleX - 2.75, y: poleTop - 2.75, width: 5.5, height: 5.5)
        knob.cornerRadius = 2.75
        knob.colors = [UIColor.white.cgColor, UIColor(white: 0.78, alpha: 1).cgColor]
        knob.startPoint = CGPoint(x: 0.3, y: 0.2)
        knob.endPoint = CGPoint(x: 0.8, y: 1)
        layer.addSublayer(knob)

        wave(at: 0)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// The runner's photo arrived: the cloth is painted again with it.
    func setPhoto(_ image: UIImage?) {
        guard let image, image !== photo else { return }
        photo = image
        let clothImage = Self.clothImage(runner: runner, photo: image)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for strip in stripLayers {
            strip.contents = clothImage.cgImage
            strip.contentsScale = clothImage.scale
        }
        CATransaction.commit()
    }

    /// The cloth's shape and shading at `time` (seconds).
    func wave(at time: Double) {
        let count = Self.strips
        let stripWidth = Self.clothSize.width / CGFloat(count)
        let clothLeft = Self.poleX + Self.poleWidth / 2
        let clothTop = Self.size.height - Self.poleHeight + Self.clothTop
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        var x = clothLeft
        for index in 0..<count {
            let a = Self.height(at: Double(index) / Double(count), time: time)
            let b = Self.height(at: Double(index + 1) / Double(count), time: time)
            let slope = (b - a) / stripWidth
            // Narrower where it folds
            let width = stripWidth / (1 + slope * slope).squareRoot()
            let strip = stripLayers[index]
            // A hair wider than its share, so no seam shows between strips
            strip.frame = CGRect(x: x, y: clothTop + (a + b) / 2, width: width + 0.35, height: Self.clothSize.height)
            let shade = shadeLayers[index]
            shade.frame = strip.bounds
            if slope < 0 {
                shade.backgroundColor = UIColor.white.cgColor
                shade.opacity = Float(min(0.4, -slope * 0.45))
            } else {
                shade.backgroundColor = UIColor.black.cgColor
                shade.opacity = Float(min(0.35, slope * 0.4))
            }
            x += width
        }
        CATransaction.commit()
    }

    /// Vertical offset (points) of the cloth at `x` (0 at the pole, 1 at the free edge): two waves
    /// travelling away from the pole, still at the pole and widest at the edge, and a little sag.
    private static func height(at x: Double, time: Double) -> CGFloat {
        let amplitude = 3.0
        let frequency = 1.4
        let primary = sin(2 * .pi * (1.1 * x - frequency * time))
        let secondary = 0.3 * sin(2 * .pi * (2.4 * x - 1.6 * frequency * time) + 1.3)
        return CGFloat(amplitude * pow(x, 1.3) * (primary + secondary) + 1.5 * x * x)
    }

    /// The cloth flat: the runner's colour (lighter at the top), their photo or initial in a white
    /// ring a little towards the pole, where the cloth moves least.
    private static func clothImage(runner: ReplayRunner, photo: UIImage?) -> UIImage {
        let size = clothSize
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
            let center = CGPoint(x: size.width * 0.42, y: size.height / 2)
            let ring = diameter + 3.5
            UIColor.white.setFill()
            cg.fillEllipse(in: CGRect(x: center.x - ring / 2, y: center.y - ring / 2, width: ring, height: ring))
            let circle = CGRect(x: center.x - diameter / 2, y: center.y - diameter / 2, width: diameter, height: diameter)
            if let photo {
                cg.saveGState()
                cg.addEllipse(in: circle)
                cg.clip()
                // Aspect fill
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
