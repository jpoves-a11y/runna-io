import MetalKit
import UIKit

// MARK: - Rain and snow on the screen's glass

/// Rain or snow on the glass of the screen, as in Apple's Weather app (the map's own rain and snow
/// aren't used). Rain: drops land on the glass and stay a few
/// seconds before they dry. Each one is a little lens: it shows the map behind it upside down and
/// smaller, from a picture of the map taken a couple of times a second. Each is lit from above, with
/// a bright crescent at the bottom, a highlight at the top and a darker rim. Fine droplets mist the
/// glass between them. The big drops slide down after a moment, in fits and starts. They pick up the
/// drops in their way and leave a wet trail and a line of tiny droplets behind.
///
/// Snow: flakes fall at three depths, the far ones small and sharp, the near ones big and out of
/// focus, each at its own speed, swaying and drifting a little with the wind. Some near ones settle
/// on the glass as a crisp crystal, then melt into a droplet that dries. The edges of the glass frost
/// over, more the harder it snows.
///
/// It moves only with `step(dt:)`, so the video draws it frame by frame just as the replay does, and
/// it's seeded: the same rain or snow every time. It's a subview of the map, so the video captures it.
final class WetGlassView: UIView {
    /// What falls: rain, snow or nothing (what's on the glass dries, the frost clears)
    private(set) var kind: ReplayWeatherHour.Kind = .dry
    /// How hard: 0 ... 1 a downpour or a blizzard
    private(set) var level: Double = 0
    /// The map's own drawing, the view the drops refract: Mapbox's Metal view, beside this one in the
    /// map view
    private var backdropSource: UIView? {
        superview?.subviews.first { $0 is MTKView }
    }

    private var drops: [GlassDrop] = []
    private var flakes: [SnowFlake] = []
    /// The flakes falling beyond the glass (under the frost and the drops on it)
    private let fallingLayer = CALayer()
    /// The frost on the glass's edges while it snows, and how much shows
    private let frostLayer = CAGradientLayer()
    private var frost: Float = 0
    /// Wet trails of drops gone off the bottom, drying
    private var dryingTrails: [(layer: CALayer, opacity: Float)] = []
    private var random = SeededRandom(seed: 0x5EED_D20B)
    /// Drops due (fractions carry over between frames)
    private var due = 0.0
    /// The picture of the map the lenses show, and where this view's corner is in it (points)
    private var backdrop: CGImage?
    private var backdropOrigin = CGPoint.zero
    private var backdropSize = CGSize.zero
    private var sinceBackdrop = Double.infinity

    /// The drop's shading image: its circle fills the image but for this margin on each side (as a
    /// fraction of the drop's diameter), where its shadow on the glass goes
    private static let shadeMargin: CGFloat = 0.12
    private static let shade: CGImage? = makeShade()
    /// A falling flake far away (a small sharp dot), one near (a big soft disc, out of focus) and one
    /// settled on the glass (a crisp six-armed crystal)
    private static let farFlake: CGImage? = makeFlake(core: 1, edge: 0.85, at: 0.45)
    private static let nearFlake: CGImage? = makeFlake(core: 0.6, edge: 0.48, at: 0.62)
    private static let crystal: CGImage? = makeCrystal()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isOpaque = false
        backgroundColor = .clear
        clipsToBounds = true
        layer.addSublayer(fallingLayer)
        frostLayer.type = .radial
        frostLayer.startPoint = CGPoint(x: 0.5, y: 0.5)
        frostLayer.endPoint = CGPoint(x: 1, y: 1)
        frostLayer.colors = [
            UIColor.white.withAlphaComponent(0).cgColor,
            UIColor.white.withAlphaComponent(0).cgColor,
            UIColor.white.withAlphaComponent(0.22).cgColor,
            UIColor.white.withAlphaComponent(0.45).cgColor,
        ]
        frostLayer.locations = [0, 0.55, 0.85, 1]
        frostLayer.opacity = 0
        layer.addSublayer(frostLayer)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fallingLayer.frame = bounds
        frostLayer.frame = bounds
        CATransaction.commit()
    }

    /// Rain or snow from now on, as hard as `level` (0...1); nothing: what's on the glass dries.
    func setWeather(_ kind: ReplayWeatherHour.Kind, level: Double) {
        let level = min(1, max(0, level))
        self.kind = level > 0 ? kind : .dry
        self.level = self.kind == .dry ? 0 : level
    }

    /// Dry glass, and the same rain or snow from the start next time.
    func reset() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for drop in drops {
            drop.remove()
        }
        for trail in dryingTrails {
            trail.layer.removeFromSuperlayer()
        }
        for flake in flakes {
            flake.layer.removeFromSuperlayer()
        }
        frostLayer.opacity = 0
        CATransaction.commit()
        drops = []
        dryingTrails = []
        flakes = []
        frost = 0
        random = SeededRandom(seed: 0x5EED_D20B)
        due = 0
        kind = .dry
        level = 0
        backdrop = nil
        sinceBackdrop = .infinity
    }

    /// Moves the rain or snow on by `dt` seconds: new drops land, the old ones dry, the big ones
    /// slide; flakes fall, settle and melt; the frost comes and goes.
    func step(dt rawDt: Double) {
        let dt = min(0.1, max(0, rawDt))
        guard kind != .dry || !drops.isEmpty || !dryingTrails.isEmpty || !flakes.isEmpty || frost > 0 else { return }
        guard bounds.width > 1, bounds.height > 1 else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }

        sinceBackdrop += dt
        if sinceBackdrop >= 0.4, kind == .rain || drops.contains(where: { $0.lens != nil }) {
            refreshBackdrop()
        }

        stepSnow(dt: dt)

        if kind == .rain {
            due += dt * (5 + 27 * level)
            let most = Int(40 + 110 * level)
            while due >= 1 {
                due -= 1
                if drops.count < most {
                    land()
                }
            }
        }

        var gone: [Int] = []
        for index in drops.indices {
            let drop = drops[index]
            drop.age += dt
            if drop.isSliding {
                slide(drop, dt: dt)
            } else if let after = drop.slidesAfter, drop.age >= after {
                drop.isSliding = true
                drop.slidesAfter = nil
                // It lasts while it slides (until it's off the glass or too small to go on)
                drop.life = .infinity
                drop.trailTop = drop.center.y
                drop.lastDroplet = drop.center.y
            }
            if drop.isGone(in: bounds) {
                gone.append(index)
            } else {
                drop.update(lensRect: lensRect(for: drop))
            }
        }
        // Drops a sliding one has picked up go too
        for index in drops.indices where drops[index].isAbsorbed && !gone.contains(index) {
            gone.append(index)
        }
        for index in gone.sorted(by: >) {
            let drop = drops.remove(at: index)
            if let trail = drop.trail, !drop.isAbsorbed {
                trail.removeFromSuperlayer()
                layer.insertSublayer(trail, at: 0)
                dryingTrails.append((trail, trail.opacity))
                drop.trail = nil
            }
            drop.remove()
        }

        // Trails left behind dry up in a second and a half
        for index in dryingTrails.indices.reversed() {
            let opacity = dryingTrails[index].opacity - Float(dt / 1.5)
            if opacity <= 0 {
                dryingTrails[index].layer.removeFromSuperlayer()
                dryingTrails.remove(at: index)
            } else {
                dryingTrails[index].opacity = opacity
                dryingTrails[index].layer.opacity = opacity
            }
        }
    }

    // MARK: Drops

    /// A new drop lands somewhere on the glass: mostly fine droplets and small drops, now and then a
    /// big one (more of them the harder it rains), a big one sometimes sliding down after a moment.
    private func land() {
        let mist = random.unit() < 0.42
        let radius: CGFloat
        if mist {
            radius = CGFloat(random.range(0.7, 1.7))
        } else {
            radius = CGFloat(2.2 + pow(random.unit(), 2.2) * (5.5 + 5 * level))
        }
        let center = CGPoint(x: random.range(0, Double(bounds.width)), y: random.range(-0.04, 1) * Double(bounds.height))
        let life = mist ? random.range(2, 5) : random.range(3.5, 8) * (0.8 + Double(radius) / 20)
        var slidesAfter: Double?
        if radius > 5, random.unit() < 0.45 + 0.3 * level {
            slidesAfter = random.range(0.4, 3)
        }
        let drop = GlassDrop(
            center: center,
            radius: radius,
            life: life,
            slidesAfter: slidesAfter,
            squash: CGSize(width: random.range(0.93, 1.05), height: random.range(0.96, 1.1)),
            phase: random.range(0, 2 * .pi),
            pace: random.range(0.75, 1.3),
            hasLens: radius >= 2.4,
            shade: Self.shade,
            shadeMargin: Self.shadeMargin
        )
        drop.lens?.contents = backdrop
        layer.addSublayer(drop.layer)
        drops.append(drop)
        drop.update(lensRect: lensRect(for: drop))
    }

    /// A big drop slides down, in fits and starts, wandering a little sideways; it picks up the
    /// drops it runs into, leaves tiny droplets and a wet trail behind, and stops once it's small.
    private func slide(_ drop: GlassDrop, dt: Double) {
        drop.phase += dt * 7 * drop.pace
        let top = 60 + 18 * Double(drop.radius)
        let surge = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(drop.phase), 2)
        drop.speed = CGFloat(top * surge * drop.pace)
        drop.center.y += drop.speed * CGFloat(dt)
        drop.center.x += CGFloat(sin(drop.phase * 0.43) * 7 * dt)

        // The drops it runs into join it
        for other in drops where other !== drop && !other.isSliding && !other.isAbsorbed {
            let dx = other.center.x - drop.center.x
            let dy = other.center.y - drop.center.y
            let reach = (drop.radius + other.radius) * 0.8
            if dx * dx + dy * dy < reach * reach {
                other.isAbsorbed = true
                drop.radius = min(12, (drop.radius * drop.radius + other.radius * other.radius * 0.6).squareRoot())
            }
        }

        // Tiny droplets behind it, every drop's length, and a little water lost each time
        if drop.center.y - drop.lastDroplet > drop.radius * 2.2 {
            drop.lastDroplet = drop.center.y
            let size = drop.radius * CGFloat(random.range(0.16, 0.3))
            if size >= 0.6, random.unit() < 0.7 {
                let droplet = GlassDrop(
                    center: CGPoint(x: drop.center.x + CGFloat(random.range(-0.25, 0.25)) * drop.radius, y: drop.center.y - drop.radius * 1.25),
                    radius: size,
                    life: random.range(1.5, 3.5),
                    slidesAfter: nil,
                    squash: CGSize(width: 1, height: 1),
                    phase: 0,
                    pace: 1,
                    hasLens: false,
                    shade: Self.shade,
                    shadeMargin: Self.shadeMargin
                )
                droplet.age = 0.1
                layer.addSublayer(droplet.layer)
                drops.append(droplet)
                droplet.update(lensRect: nil)
            }
            drop.radius *= 0.985
        }
        if drop.radius < 3.4 {
            // Too small to slide on: it stays and dries
            drop.isSliding = false
            drop.life = drop.age + 1.5
        }
        drop.updateTrail()
        if drop.trail == nil {
            let trail = CAGradientLayer()
            trail.startPoint = CGPoint(x: 0, y: 0.5)
            trail.endPoint = CGPoint(x: 1, y: 0.5)
            trail.colors = [
                UIColor.white.withAlphaComponent(0).cgColor,
                UIColor.white.withAlphaComponent(0.1).cgColor,
                UIColor.white.withAlphaComponent(0.16).cgColor,
                UIColor.white.withAlphaComponent(0.1).cgColor,
                UIColor.white.withAlphaComponent(0).cgColor,
            ]
            trail.opacity = 1
            layer.insertSublayer(trail, below: drop.layer)
            drop.trail = trail
            drop.updateTrail()
        }
    }

    /// Where in the picture of the map a drop's lens looks: the area around it 2.4 times its size,
    /// shown smaller and upside down (the lens is turned round), as through a drop of water.
    private func lensRect(for drop: GlassDrop) -> CGRect? {
        guard drop.lens != nil, backdrop != nil, backdropSize.width > 0, backdropSize.height > 0 else { return nil }
        let size = drop.radius * 2 * 2.4
        let x = drop.center.x + backdropOrigin.x - size / 2
        let y = drop.center.y + backdropOrigin.y - size / 2
        return CGRect(
            x: x / backdropSize.width,
            y: y / backdropSize.height,
            width: size / backdropSize.width,
            height: size / backdropSize.height
        )
    }

    /// A new picture of the map behind the glass, small (the drops show it blurred anyway); every lens
    /// shows it. The map as last drawn on screen, without the drops or the flag.
    private func refreshBackdrop() {
        sinceBackdrop = 0
        guard let source = backdropSource, source.window != nil, source.bounds.width > 1, source.bounds.height > 1 else { return }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 0.45
        format.opaque = true
        let image = UIGraphicsImageRenderer(bounds: source.bounds, format: format).image { _ in
            _ = source.drawHierarchy(in: source.bounds, afterScreenUpdates: false)
        }
        guard let picture = image.cgImage else { return }
        backdrop = picture
        backdropSize = source.bounds.size
        let corner = source.convert(bounds.origin, from: self)
        backdropOrigin = CGPoint(x: corner.x - source.bounds.minX, y: corner.y - source.bounds.minY)
        for drop in drops {
            drop.lens?.contents = picture
        }
    }

    // MARK: Snow

    /// The snow: flakes keep coming in at the top (all over the glass at once when it starts
    /// snowing, fading in), fall, sway and drift, and wrap round the sides; near ones may settle on
    /// the glass and melt. The frost on the edges follows how hard it snows, slowly.
    private func stepSnow(dt: Double) {
        let wanted = kind == .snow ? Int(30 + 130 * level) : 0
        if flakes.isEmpty, wanted > 0 {
            for _ in 0..<wanted {
                addFlake(atY: CGFloat(random.range(-0.05, 1)) * bounds.height)
            }
        }
        var added = 0
        while flakes.count < wanted, added < 6 {
            addFlake(atY: nil)
            added += 1
        }

        let wind = 9.0
        var gone: [Int] = []
        for index in flakes.indices {
            let flake = flakes[index]
            flake.age += dt
            if flake.isSettled {
                flake.settledFor += dt
                if !flake.isMelting, flake.settledFor >= flake.meltsAfter {
                    melt(flake)
                }
                if flake.isMelting, flake.settledFor >= flake.meltsAfter + SnowFlake.meltTime {
                    gone.append(index)
                    continue
                }
            } else {
                flake.phase += dt * flake.swayRate
                flake.center.y += flake.speed * CGFloat(dt)
                let drift = wind * (0.4 + flake.depth) + cos(flake.phase) * Double(flake.sway) * flake.swayRate
                flake.center.x += CGFloat(drift * dt)
                let span = bounds.width + 2 * flake.size
                if flake.center.x > bounds.maxX + flake.size {
                    flake.center.x -= span
                } else if flake.center.x < bounds.minX - flake.size {
                    flake.center.x += span
                }
                if let settlesAt = flake.settlesAt, flake.center.y >= settlesAt {
                    settle(flake)
                }
                if flake.center.y - flake.size > bounds.maxY {
                    gone.append(index)
                    continue
                }
            }
            flake.update()
        }
        for index in gone.sorted(by: >) {
            flakes.remove(at: index).layer.removeFromSuperlayer()
        }

        // The frost: in a second and a half or so to as much as it snows
        let target: Float = kind == .snow ? Float(0.25 + 0.45 * level) : 0
        if frost != target {
            frost += (target - frost) * min(1, Float(dt / 1.5))
            if abs(frost - target) < 0.005 {
                frost = target
            }
            frostLayer.opacity = frost
        }
    }

    /// A new flake, at `y` (nil: just above the glass): far ones (most) small and slow, near ones big,
    /// soft and fast; about a third of the near ones settle on the glass somewhere down it.
    private func addFlake(atY y: CGFloat?) {
        let tier = random.unit()
        let depth: Double
        let size: CGFloat
        let speed: Double
        let opacity: Double
        let sway: Double
        if tier < 0.55 {
            depth = random.range(0, 0.4)
            size = CGFloat(random.range(1.4, 2.6))
            speed = random.range(16, 26)
            opacity = random.range(0.6, 0.8)
            sway = random.range(3, 6)
        } else if tier < 0.85 {
            depth = random.range(0.4, 0.75)
            size = CGFloat(random.range(2.6, 4.5))
            speed = random.range(32, 50)
            opacity = random.range(0.85, 0.95)
            sway = random.range(6, 10)
        } else {
            depth = random.range(0.75, 1)
            size = CGFloat(random.range(7, 13))
            speed = random.range(70, 105)
            opacity = random.range(0.4, 0.6)
            sway = random.range(10, 18)
        }
        let near = depth >= 0.75
        var settlesAt: CGFloat?
        if near, random.unit() < 0.32 {
            settlesAt = CGFloat(random.range(0.12, 0.92)) * bounds.height
        }
        let x = CGFloat(random.range(-20, Double(bounds.width) + 20))
        let startY = y ?? -size - CGFloat(random.range(0, 30))
        let flake = SnowFlake(
            center: CGPoint(x: x, y: startY),
            size: size,
            depth: depth,
            speed: CGFloat(speed * (1 + 0.3 * level)),
            opacity: Float(opacity),
            sway: CGFloat(sway),
            swayRate: random.range(0.5, 1.3),
            phase: random.range(0, 2 * .pi),
            settlesAt: settlesAt.flatMap { $0 > startY ? $0 : nil },
            meltsAfter: random.range(0.9, 2.2),
            image: near ? Self.nearFlake : Self.farFlake
        )
        fallingLayer.addSublayer(flake.layer)
        flakes.append(flake)
        flake.update()
    }

    /// A near flake reaches the glass and stays there, in focus: a small crisp crystal on the glass.
    private func settle(_ flake: SnowFlake) {
        flake.isSettled = true
        flake.layer.removeFromSuperlayer()
        layer.addSublayer(flake.layer)
        flake.layer.contents = Self.crystal
        flake.settle()
    }

    /// The settled flake melts: it fades and shrinks into a droplet that then dries like the rain's.
    private func melt(_ flake: SnowFlake) {
        flake.isMelting = true
        let radius = max(1.2, flake.size * 0.32)
        let drop = GlassDrop(
            center: flake.center,
            radius: radius,
            life: random.range(1.6, 3.2),
            slidesAfter: nil,
            squash: CGSize(width: random.range(0.94, 1.04), height: random.range(0.98, 1.08)),
            phase: 0,
            pace: 1,
            hasLens: radius >= 2.4,
            shade: Self.shade,
            shadeMargin: Self.shadeMargin
        )
        if drop.lens != nil, backdrop == nil {
            refreshBackdrop()
        }
        drop.lens?.contents = backdrop
        drop.age = 0.05
        layer.insertSublayer(drop.layer, below: flake.layer)
        drops.append(drop)
        drop.update(lensRect: lensRect(for: drop))
    }

    // MARK: The drop's light

    /// A drop of water on glass, lit from above: its shadow on the glass just below it, a darker rim
    /// and top edge, a bright crescent at the bottom (the light it gathers), a soft glassy body and a
    /// sharp highlight at the top left. Over the lens, which shows the map.
    private static func makeShade() -> CGImage? {
        let pixels: CGFloat = 144
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: CGSize(width: pixels, height: pixels), format: format).image { context in
            let cg = context.cgContext
            let space = CGColorSpaceCreateDeviceRGB()
            let radius = pixels / (2 + 4 * shadeMargin)
            let center = CGPoint(x: pixels / 2, y: pixels / 2)
            let circle = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
            func gradient(_ stops: [(CGFloat, UIColor)]) -> CGGradient? {
                CGGradient(colorsSpace: space, colors: stops.map { $0.1.cgColor } as CFArray, locations: stops.map { $0.0 })
            }

            // Its shadow on the glass, just below it (outside the drop only)
            cg.saveGState()
            cg.addRect(CGRect(x: 0, y: 0, width: pixels, height: pixels))
            cg.addEllipse(in: circle)
            cg.clip(using: .evenOdd)
            if let shadow = gradient([(0, UIColor.black.withAlphaComponent(0.28)), (1, UIColor.black.withAlphaComponent(0))]) {
                let shadowCenter = CGPoint(x: center.x, y: center.y + radius * 0.12)
                cg.drawRadialGradient(shadow, startCenter: shadowCenter, startRadius: radius * 0.95, endCenter: shadowCenter, endRadius: radius * 1.22, options: [])
            }
            cg.restoreGState()

            cg.saveGState()
            cg.addEllipse(in: circle)
            cg.clip()
            // A soft glassy body, darker towards the rim
            if let body = gradient([
                (0, UIColor.white.withAlphaComponent(0.07)),
                (0.6, UIColor.white.withAlphaComponent(0)),
                (0.86, UIColor.black.withAlphaComponent(0.14)),
                (1, UIColor.black.withAlphaComponent(0.4)),
            ]) {
                cg.drawRadialGradient(body, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
            }
            // The top edge in shadow: the drop less what an offset circle covers
            cg.saveGState()
            cg.addRect(circle)
            cg.addEllipse(in: circle.offsetBy(dx: 0, dy: radius * 0.24).insetBy(dx: radius * 0.02, dy: radius * 0.02))
            cg.clip(using: .evenOdd)
            if let top = gradient([(0, UIColor.black.withAlphaComponent(0.32)), (1, UIColor.black.withAlphaComponent(0))]) {
                cg.drawLinearGradient(top, start: CGPoint(x: center.x, y: circle.minY), end: CGPoint(x: center.x, y: center.y), options: [])
            }
            cg.restoreGState()
            // The bright crescent at the bottom
            cg.saveGState()
            cg.addRect(circle)
            cg.addEllipse(in: circle.offsetBy(dx: 0, dy: -radius * 0.2).insetBy(dx: radius * 0.04, dy: radius * 0.04))
            cg.clip(using: .evenOdd)
            if let bottom = gradient([(0, UIColor.white.withAlphaComponent(0)), (1, UIColor.white.withAlphaComponent(0.62))]) {
                cg.drawLinearGradient(bottom, start: CGPoint(x: center.x, y: center.y + radius * 0.25), end: CGPoint(x: center.x, y: circle.maxY), options: [])
            }
            cg.restoreGState()
            // The highlight at the top left, and its faint reflection at the bottom right
            cg.saveGState()
            cg.translateBy(x: center.x - radius * 0.36, y: center.y - radius * 0.44)
            cg.rotate(by: -0.6)
            cg.scaleBy(x: 1, y: 0.58)
            if let highlight = gradient([(0, UIColor.white.withAlphaComponent(0.95)), (0.45, UIColor.white.withAlphaComponent(0.5)), (1, UIColor.white.withAlphaComponent(0))]) {
                cg.drawRadialGradient(highlight, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: radius * 0.26, options: [])
            }
            cg.restoreGState()
            if let glint = gradient([(0, UIColor.white.withAlphaComponent(0.5)), (1, UIColor.white.withAlphaComponent(0))]) {
                let point = CGPoint(x: center.x + radius * 0.34, y: center.y + radius * 0.5)
                cg.drawRadialGradient(glint, startCenter: point, startRadius: 0, endCenter: point, endRadius: radius * 0.1, options: [])
            }
            cg.restoreGState()

            // A fine edge
            cg.setStrokeColor(UIColor.black.withAlphaComponent(0.22).cgColor)
            cg.setLineWidth(1.5)
            cg.strokeEllipse(in: circle.insetBy(dx: 0.75, dy: 0.75))
        }
        return image.cgImage
    }

    // MARK: The snow's look

    /// A round flake: white, `core` opaque in the middle, `edge` at `at` of its radius, gone at the rim.
    private static func makeFlake(core: CGFloat, edge: CGFloat, at location: CGFloat) -> CGImage? {
        let pixels: CGFloat = 64
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: CGSize(width: pixels, height: pixels), format: format).image { context in
            let colors = [
                UIColor.white.withAlphaComponent(core).cgColor,
                UIColor.white.withAlphaComponent(edge).cgColor,
                UIColor.white.withAlphaComponent(0).cgColor,
            ] as CFArray
            let locations: [CGFloat] = [0, location, 1]
            guard let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: locations) else { return }
            let center = CGPoint(x: pixels / 2, y: pixels / 2)
            context.cgContext.drawRadialGradient(gradient, startCenter: center, startRadius: 0, endCenter: center, endRadius: pixels / 2, options: [])
        }
        return image.cgImage
    }

    /// A snow crystal on the glass: six arms with little branches, a bright middle and a faint glow.
    private static func makeCrystal() -> CGImage? {
        let pixels: CGFloat = 96
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: CGSize(width: pixels, height: pixels), format: format).image { context in
            let cg = context.cgContext
            let center = CGPoint(x: pixels / 2, y: pixels / 2)
            let radius = pixels * 0.42
            let glowColors = [UIColor.white.withAlphaComponent(0.35).cgColor, UIColor.white.withAlphaComponent(0).cgColor] as CFArray
            let glowLocations: [CGFloat] = [0, 1]
            if let glow = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: glowColors, locations: glowLocations) {
                cg.drawRadialGradient(glow, startCenter: center, startRadius: 0, endCenter: center, endRadius: pixels / 2, options: [])
            }
            cg.setStrokeColor(UIColor.white.withAlphaComponent(0.95).cgColor)
            cg.setLineCap(.round)
            cg.setShadow(offset: .zero, blur: 3, color: UIColor.black.withAlphaComponent(0.25).cgColor)
            for arm in 0..<6 {
                cg.saveGState()
                cg.translateBy(x: center.x, y: center.y)
                cg.rotate(by: CGFloat(arm) * .pi / 3)
                cg.setLineWidth(pixels * 0.045)
                cg.move(to: .zero)
                cg.addLine(to: CGPoint(x: 0, y: -radius))
                cg.strokePath()
                cg.setLineWidth(pixels * 0.032)
                let branches: [(along: CGFloat, length: CGFloat)] = [(0.45, 0.22), (0.72, 0.15)]
                for (along, length) in branches {
                    let base = CGPoint(x: 0, y: -radius * along)
                    for side: CGFloat in [-1, 1] {
                        cg.move(to: base)
                        cg.addLine(to: CGPoint(x: side * radius * length, y: base.y - radius * length))
                    }
                }
                cg.strokePath()
                cg.restoreGState()
            }
            cg.setFillColor(UIColor.white.cgColor)
            cg.fillEllipse(in: CGRect(x: center.x - pixels * 0.06, y: center.y - pixels * 0.06, width: pixels * 0.12, height: pixels * 0.12))
        }
        return image.cgImage
    }
}

// MARK: - A drop

/// One drop on the glass: its lens (the map behind it) and its light, its place and size, how long it
/// has been there and lasts, and whether it slides.
private final class GlassDrop {
    let layer = CALayer()
    let lens: CALayer?
    let shadeLayer = CALayer()
    var center: CGPoint
    var radius: CGFloat
    var age = 0.0
    var life: Double
    var slidesAfter: Double?
    var isSliding = false
    var isAbsorbed = false
    var speed: CGFloat = 0
    var phase: Double
    let pace: Double
    let squash: CGSize
    private let shadeMargin: CGFloat
    /// Where the wet trail starts, where the last droplet was left, and the trail
    var trailTop: CGFloat = 0
    var lastDroplet: CGFloat = 0
    var trail: CALayer?

    init(center: CGPoint, radius: CGFloat, life: Double, slidesAfter: Double?, squash: CGSize, phase: Double, pace: Double, hasLens: Bool, shade: CGImage?, shadeMargin: CGFloat) {
        self.center = center
        self.radius = radius
        self.life = life
        self.slidesAfter = slidesAfter
        self.squash = squash
        self.phase = phase
        self.pace = pace
        self.shadeMargin = shadeMargin
        lens = hasLens ? CALayer() : nil
        if let lens {
            // Upside down, as a drop of water shows what's behind it
            lens.setAffineTransform(CGAffineTransform(rotationAngle: .pi))
            lens.masksToBounds = true
            lens.contentsGravity = .resize
            lens.minificationFilter = .linear
            lens.magnificationFilter = .linear
            layer.addSublayer(lens)
        }
        shadeLayer.contents = shade
        shadeLayer.contentsGravity = .resize
        // Mipmapped: the image is much bigger than most drops
        shadeLayer.minificationFilter = .trilinear
        layer.addSublayer(shadeLayer)
        layer.opacity = 0
    }

    func isGone(in bounds: CGRect) -> Bool {
        isAbsorbed || age >= life || center.y - radius * 2 > bounds.maxY
    }

    /// Puts its layers where it is now: it lands with a little splash, slides stretched, dries away.
    func update(lensRect: CGRect?) {
        let landed = min(1, age / 0.09)
        let drying = max(0, min(1, (life - age) / 0.9))
        let size = radius * 2
        let bounds = CGRect(x: 0, y: 0, width: size, height: size)
        if layer.bounds != bounds {
            layer.bounds = bounds
            // Bounds and position, not frame: the lens is turned round
            lens?.bounds = bounds
            lens?.position = CGPoint(x: radius, y: radius)
            lens?.cornerRadius = radius
            shadeLayer.frame = bounds.insetBy(dx: -size * shadeMargin, dy: -size * shadeMargin)
        }
        layer.position = center
        var scale = CGFloat(0.55 + 0.45 * landed) * CGFloat(0.8 + 0.2 * drying)
        var squashX = squash.width
        var squashY = squash.height
        if isSliding {
            // Stretched down as it runs, more the faster
            squashX = 0.9
            squashY = 1.1 + min(0.2, speed / 900)
        }
        if age < 0.09 {
            // The splash: a little wider for a moment
            scale *= 1 + CGFloat(0.12 * (1 - landed))
        }
        layer.setAffineTransform(CGAffineTransform(scaleX: scale * squashX, y: scale * squashY))
        let opacity = Float(min(landed * 1.4, 1) * drying)
        if layer.opacity != opacity {
            layer.opacity = opacity
        }
        if let lens, let lensRect {
            lens.contentsRect = lensRect
        }
    }

    /// The wet trail from where it started sliding down to it.
    func updateTrail() {
        guard let trail else { return }
        let width = radius * 1.15
        let top = trailTop
        let bottom = center.y - radius * 0.6
        guard bottom > top else { return }
        trail.frame = CGRect(x: center.x - width / 2, y: top, width: width, height: bottom - top)
        trail.cornerRadius = width / 2
    }

    func remove() {
        layer.removeFromSuperlayer()
        trail?.removeFromSuperlayer()
    }
}

/// One snowflake: falling beyond the glass at its depth, or settled on it and melting.
private final class SnowFlake {
    /// How long a settled flake takes to melt away
    static let meltTime = 0.45

    let layer = CALayer()
    var center: CGPoint
    var size: CGFloat
    let depth: Double
    let speed: CGFloat
    let opacity: Float
    let sway: CGFloat
    let swayRate: Double
    var phase: Double
    /// Where it settles on the glass (nil: it falls past)
    let settlesAt: CGFloat?
    let meltsAfter: Double
    var age = 0.0
    var isSettled = false
    var isMelting = false
    var settledFor = 0.0

    init(center: CGPoint, size: CGFloat, depth: Double, speed: CGFloat, opacity: Float, sway: CGFloat, swayRate: Double, phase: Double, settlesAt: CGFloat?, meltsAfter: Double, image: CGImage?) {
        self.center = center
        self.size = size
        self.depth = depth
        self.speed = speed
        self.opacity = opacity
        self.sway = sway
        self.swayRate = swayRate
        self.phase = phase
        self.settlesAt = settlesAt
        self.meltsAfter = meltsAfter
        layer.contents = image
        layer.contentsGravity = .resize
        layer.minificationFilter = .trilinear
        layer.opacity = 0
    }

    /// On the glass: smaller and crisp (the crystal), slightly turned.
    func settle() {
        size *= 0.8
        layer.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(phase.truncatingRemainder(dividingBy: .pi / 3))))
    }

    /// Puts its layer where it is now: it fades in as it comes (or as the snow starts), and fades and
    /// shrinks as it melts.
    func update() {
        let bounds = CGRect(x: 0, y: 0, width: size, height: size)
        if layer.bounds != bounds {
            layer.bounds = bounds
        }
        layer.position = center
        var alpha = opacity * Float(min(1, age / 0.6))
        if isSettled {
            alpha = 0.95
            if isMelting {
                let melted = min(1, max(0, (settledFor - meltsAfter) / Self.meltTime))
                alpha *= Float(1 - melted)
                let scale = CGFloat(1 - 0.5 * melted)
                let turn = CGFloat(phase.truncatingRemainder(dividingBy: .pi / 3))
                layer.setAffineTransform(CGAffineTransform(rotationAngle: turn).scaledBy(x: scale, y: scale))
            }
        }
        if layer.opacity != alpha {
            layer.opacity = alpha
        }
    }
}

/// SplitMix64: random numbers that are the same every time from the same seed.
private struct SeededRandom {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    /// 0..<1
    mutating func unit() -> Double {
        Double(next() >> 11) / Double(UInt64(1) << 53)
    }

    mutating func range(_ low: Double, _ high: Double) -> Double {
        low + (high - low) * unit()
    }
}
