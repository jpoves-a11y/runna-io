import MetalKit
import UIKit

// MARK: - Rain, snow and fog on the screen's glass

/// A box drawn over the glass (the video's counters, its altitude profile): water doesn't land on
/// it. It runs round it.
struct GlassShelf: Equatable {
    var rect: CGRect
    var cornerRadius: CGFloat
}

/// Rain, snow or fog seen through the glass of the screen, as in Apple's Weather app (the map's own
/// rain and snow aren't used).
///
/// Rain: fine streaks fall beyond the glass at three depths, slanted by a wind that gusts, under a
/// dull sky. Drops land on the glass and stay a few seconds before they dry. Each one is a little
/// lens: it shows the map behind it upside down and smaller, from a picture of the map taken a
/// couple of times a second, lit from above. Fine droplets mist the glass between them. The big
/// drops slide down after a moment, in fits and starts, wandering; they pick up the drops in their
/// way and leave a wet, winding trail and a line of tiny droplets behind.
///
/// The boxes over the glass (`shelves`) stand out of it: no water lands on them. Drops bead on
/// their top edge, the rain splashes there, and what slides onto a box runs along its top edge to
/// the nearest corner, round it, down its side and drips off below.
///
/// Snow: flakes fall at three depths, the far ones small and sharp, the near ones big and out of
/// focus, each at its own speed, swaying, in a wind that comes and goes. Some near ones settle on
/// the glass as a crisp crystal, then melt into a droplet that dries. The edges of the glass frost
/// over and snow piles up on top of the boxes.
///
/// Fog: soft banks of cloud drift along the edges of the glass and a pale haze closes in from
/// them; the middle stays clear.
///
/// It moves only with `step(dt:)`, so the video draws it frame by frame just as the replay does, and
/// it's seeded: the same weather every time. It's a subview of the map, so the video captures it.
final class WetGlassView: UIView {
    /// What falls: rain, snow or nothing (what's on the glass dries, the frost clears)
    private(set) var kind: ReplayWeatherHour.Kind = .dry
    /// How hard: 0 ... 1 a downpour or a blizzard
    private(set) var level: Double = 0
    /// How thick the fog is: 0 none ... 1 dense
    private(set) var fog: Double = 0
    /// The view the drops refract when the map isn't Mapbox's (the weather preview)
    weak var backdropView: UIView?
    /// The map's own drawing, the view the drops refract: Mapbox's Metal view, beside this one in the
    /// map view
    private var backdropSource: UIView? {
        superview?.subviews.first { $0 is MTKView } ?? backdropView
    }

    private var drops: [GlassDrop] = []
    private var flakes: [SnowFlake] = []
    private var streaks: [RainStreak] = []
    private var puffs: [FogPuff] = []
    private var splashes: [(layer: CALayer, age: Double)] = []
    /// The dull sky of rain or snow, over the whole map
    private let veilLayer = CAGradientLayer()
    private var veil: Float = 0
    private var veilKind: ReplayWeatherHour.Kind = .dry
    /// The fog: a pale haze over everything, thicker towards the edges, and the banks of cloud
    private let hazeLayer = CALayer()
    private let fogEdgeLayer = CAGradientLayer()
    private let fogLayer = CALayer()
    private var fogAmount: Float = 0
    /// The rain and the flakes falling beyond the glass (under what's on it)
    private let fallingLayer = CALayer()
    private var rainAmount: Float = 0
    /// What's on the glass: drops, their trails, settled flakes
    private let glassLayer = CALayer()
    /// The frost on the glass's edges while it snows, and how much shows
    private let frostLayer = CAGradientLayer()
    private var frost: Float = 0
    /// The boxes over the glass, as given and as they are for this size
    private var shelfLayout: ((CGSize) -> [GlassShelf])?
    private var shelves: [GlassShelf] = []
    private var shelvesSize = CGSize.zero
    /// Snow piled on each box, and how high (points)
    private var snowCaps: [CAShapeLayer] = []
    private var snowDepth: CGFloat = 0
    private var snowDrawn: CGFloat = -1
    /// Wet trails of drops gone off the bottom, drying
    private var dryingTrails: [(layer: CALayer, opacity: Float)] = []
    private var random = SeededRandom(seed: 0x5EED_D20B)
    /// Drops and splashes due (fractions carry over between frames)
    private var due = 0.0
    private var splashesDue = 0.0
    /// Seconds stepped (the wind's gusts follow it)
    private var time = 0.0
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
    /// A streak of rain (bright at its head, fading up its tail), a bank of fog and a splash
    private static let streak: CGImage? = makeStreak()
    private static let puff: CGImage? = makePuff()
    private static let splash: CGImage? = makeSplash()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isOpaque = false
        backgroundColor = .clear
        clipsToBounds = true
        veilLayer.startPoint = CGPoint(x: 0.5, y: 0)
        veilLayer.endPoint = CGPoint(x: 0.5, y: 1)
        veilLayer.opacity = 0
        layer.addSublayer(veilLayer)
        hazeLayer.backgroundColor = UIColor(red: 0.93, green: 0.95, blue: 0.97, alpha: 1).cgColor
        hazeLayer.opacity = 0
        layer.addSublayer(hazeLayer)
        layer.addSublayer(fallingLayer)
        let pale = UIColor(red: 0.95, green: 0.96, blue: 0.98, alpha: 1)
        fogEdgeLayer.type = .radial
        fogEdgeLayer.startPoint = CGPoint(x: 0.5, y: 0.5)
        fogEdgeLayer.endPoint = CGPoint(x: 1, y: 1)
        fogEdgeLayer.colors = [
            pale.withAlphaComponent(0).cgColor,
            pale.withAlphaComponent(0.04).cgColor,
            pale.withAlphaComponent(0.34).cgColor,
            pale.withAlphaComponent(0.62).cgColor,
        ]
        fogEdgeLayer.locations = [0, 0.42, 0.78, 1]
        fogEdgeLayer.opacity = 0
        layer.addSublayer(fogEdgeLayer)
        layer.addSublayer(fogLayer)
        layer.addSublayer(glassLayer)
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
        for sublayer in [veilLayer, hazeLayer, fallingLayer, fogEdgeLayer, fogLayer, glassLayer, frostLayer] {
            sublayer.frame = bounds
        }
        CATransaction.commit()
    }

    /// Rain or snow from now on, as hard as `level` (0...1), and fog as thick as `fog` (0...1);
    /// nothing: what's on the glass dries and the fog lifts.
    func setWeather(_ kind: ReplayWeatherHour.Kind, level: Double, fog: Double = 0) {
        let level = min(1, max(0, level))
        self.kind = level > 0 ? kind : .dry
        self.level = self.kind == .dry ? 0 : level
        self.fog = min(1, max(0, fog))
    }

    /// The boxes drawn over the glass, for a glass of a given size (nil: none).
    func setShelves(_ layout: ((CGSize) -> [GlassShelf])?) {
        shelfLayout = layout
        shelvesSize = .zero
    }

    /// Clear glass, and the same weather from the start next time.
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
        for streak in streaks {
            streak.layer.removeFromSuperlayer()
        }
        for puff in puffs {
            puff.layer.removeFromSuperlayer()
        }
        for splash in splashes {
            splash.layer.removeFromSuperlayer()
        }
        for cap in snowCaps {
            cap.removeFromSuperlayer()
        }
        frostLayer.opacity = 0
        veilLayer.opacity = 0
        hazeLayer.opacity = 0
        fogEdgeLayer.opacity = 0
        CATransaction.commit()
        drops = []
        dryingTrails = []
        flakes = []
        streaks = []
        puffs = []
        splashes = []
        snowCaps = []
        snowDepth = 0
        snowDrawn = -1
        frost = 0
        veil = 0
        veilKind = .dry
        fogAmount = 0
        rainAmount = 0
        random = SeededRandom(seed: 0x5EED_D20B)
        due = 0
        splashesDue = 0
        time = 0
        kind = .dry
        level = 0
        fog = 0
        backdrop = nil
        sinceBackdrop = .infinity
    }

    /// Whether anything shows or is still clearing.
    private var isActive: Bool {
        if kind != .dry || fog > 0 { return true }
        if !drops.isEmpty || !dryingTrails.isEmpty || !flakes.isEmpty { return true }
        if !streaks.isEmpty || !splashes.isEmpty { return true }
        if frost > 0 || veil > 0 || fogAmount > 0 { return true }
        return snowDepth > 0
    }

    /// Moves the weather on by `dt` seconds: the rain falls, new drops land, the old ones dry, the
    /// big ones slide and run round the boxes; flakes fall, settle and melt; the fog drifts.
    func step(dt rawDt: Double) {
        let dt = min(0.1, max(0, rawDt))
        guard isActive else { return }
        guard bounds.width > 1, bounds.height > 1 else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }

        time += dt
        if shelvesSize != bounds.size {
            shelvesSize = bounds.size
            shelves = shelfLayout?(bounds.size) ?? []
            snowDrawn = -1
        }

        sinceBackdrop += dt
        if sinceBackdrop >= 0.4, kind == .rain || drops.contains(where: { $0.lens != nil }) {
            refreshBackdrop()
        }

        stepSky(dt: dt)
        stepFog(dt: dt)
        stepRain(dt: dt)
        stepSnow(dt: dt)
        stepSplashes(dt: dt)

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
                if let shelf = drop.restsOn, shelves.indices.contains(shelf) {
                    // A bead on a box's top edge: it runs along the edge to the nearer corner
                    drop.ride = .top(shelf: shelf, direction: rideDirection(from: drop.center.x, on: shelves[shelf].rect))
                }
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
                glassLayer.insertSublayer(trail, at: 0)
                dryingTrails.append((layer: trail as CALayer, opacity: trail.opacity))
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

    // MARK: Sky and fog

    /// The dull light of rain (a cool grey, darker at the top) or snow (a cold pale one), coming and
    /// going in a second or so.
    private func stepSky(dt: Double) {
        if kind != .dry, kind != veilKind, veil < 0.02 {
            veilKind = kind
            let tint = kind == .rain
                ? UIColor(red: 0.07, green: 0.11, blue: 0.17, alpha: 1)
                : UIColor(red: 0.86, green: 0.91, blue: 0.97, alpha: 1)
            let strength: [CGFloat] = kind == .rain ? [0.42, 0.2, 0.12] : [0.2, 0.08, 0.14]
            veilLayer.colors = strength.map { tint.withAlphaComponent($0).cgColor }
            veilLayer.locations = [0, 0.5, 1]
        }
        // Rain turning to snow (or back): the old sky goes first
        let target: Float = kind != .dry && kind == veilKind ? Float(0.45 + 0.55 * level) : 0
        veil = Self.approach(veil, target, dt: dt, time: 1.2)
        if veilLayer.opacity != veil {
            veilLayer.opacity = veil
        }
    }

    /// The fog: banks of cloud drifting along the edges, each breathing a little, and a haze that
    /// thickens from the edges in. It comes and lifts slowly.
    private func stepFog(dt: Double) {
        fogAmount = Self.approach(fogAmount, Float(fog), dt: dt, time: 2.5)
        let shown = fogAmount
        if hazeLayer.opacity != 0.1 * shown {
            hazeLayer.opacity = 0.1 * shown
            fogEdgeLayer.opacity = min(1, 0.35 + 0.65 * shown) * min(1, shown * 3)
        }
        if shown <= 0 {
            if !puffs.isEmpty {
                for puff in puffs {
                    puff.layer.removeFromSuperlayer()
                }
                puffs = []
            }
            return
        }
        if puffs.isEmpty {
            for index in 0..<14 {
                addPuff(index)
            }
        }
        for puff in puffs {
            puff.phase += dt * puff.breath
            puff.center.x += puff.speed * CGFloat(dt)
            let half = puff.size.width / 2
            if puff.center.x - half > bounds.maxX {
                puff.center.x = bounds.minX - half
            } else if puff.center.x + half < bounds.minX {
                puff.center.x = bounds.maxX + half
            }
            puff.layer.position = CGPoint(x: puff.center.x, y: puff.center.y + CGFloat(sin(puff.phase * 0.7)) * 5)
            puff.layer.opacity = puff.opacity * shown * Float(0.78 + 0.22 * sin(puff.phase))
        }
    }

    /// A bank of fog: wide and low, somewhere along the top or the bottom edge (most) or down a side,
    /// drifting slowly one way or the other.
    private func addPuff(_ index: Int) {
        let width = bounds.width * CGFloat(random.range(0.55, 1.05))
        let height = width * CGFloat(random.range(0.42, 0.62))
        let x = CGFloat(random.range(-0.1, 1.1)) * bounds.width
        let y: CGFloat
        switch index % 7 {
        case 0, 1, 2:
            y = bounds.minY + height * CGFloat(random.range(-0.12, 0.2))
        case 3, 4, 5:
            y = bounds.maxY - height * CGFloat(random.range(-0.12, 0.2))
        default:
            y = CGFloat(random.range(0.25, 0.75)) * bounds.height
        }
        // The ones across the middle keep to the sides, and stay faint
        let middle = index % 7 == 6
        let side: CGFloat = index % 2 == 0 ? bounds.minX : bounds.maxX
        let pace = CGFloat(random.range(3, 9))
        let way: CGFloat = random.unit() < 0.5 ? -1 : 1
        let strength = middle ? random.range(0.3, 0.42) : random.range(0.42, 0.7)
        let puff = FogPuff(
            center: CGPoint(x: middle ? side : x, y: y),
            size: CGSize(width: width, height: height),
            speed: middle ? 0 : pace * way,
            opacity: Float(strength),
            phase: random.range(0, 2 * .pi),
            breath: random.range(0.12, 0.3),
            image: Self.puff
        )
        fogLayer.addSublayer(puff.layer)
        puffs.append(puff)
    }

    // MARK: Rain beyond the glass

    /// The wind: mostly steady, with slow gusts (-1 ... 1 round its mean).
    private var gust: Double {
        0.6 * sin(time * 0.37) + 0.4 * sin(time * 1.13 + 1.7)
    }

    /// The rain falling beyond the glass: streaks at three depths (the far ones fine, short and
    /// faint, the near ones longer and faster), slanted by the wind. It starts and stops in a second.
    private func stepRain(dt: Double) {
        rainAmount = Self.approach(rainAmount, kind == .rain ? 1 : 0, dt: dt, time: 0.9)
        let wanted = kind == .rain ? Int(18 + 120 * level) : 0
        if streaks.isEmpty, wanted > 0 {
            for _ in 0..<wanted {
                addStreak(spread: true)
            }
        }
        var added = 0
        while streaks.count < wanted, added < 8 {
            addStreak(spread: false)
            added += 1
        }
        guard !streaks.isEmpty else { return }
        if rainAmount <= 0, wanted == 0 {
            for streak in streaks {
                streak.layer.removeFromSuperlayer()
            }
            streaks = []
            return
        }
        var gone: [Int] = []
        for index in streaks.indices {
            let streak = streaks[index]
            streak.head.x += streak.velocity.x * CGFloat(dt)
            streak.head.y += streak.velocity.y * CGFloat(dt)
            if streak.head.y - streak.length > bounds.maxY {
                if streaks.count - gone.count > wanted {
                    gone.append(index)
                    continue
                }
                place(streak, spread: false)
            }
            streak.layer.position = streak.head
            let opacity = streak.opacity * rainAmount
            if streak.layer.opacity != opacity {
                streak.layer.opacity = opacity
            }
        }
        for index in gone.reversed() {
            streaks.remove(at: index).layer.removeFromSuperlayer()
        }
    }

    private func addStreak(spread: Bool) {
        let streak = RainStreak(image: Self.streak)
        place(streak, spread: spread)
        streak.layer.opacity = 0
        fallingLayer.addSublayer(streak.layer)
        streaks.append(streak)
    }

    /// Puts a streak above the glass (`spread`: anywhere down it, as the rain starts) with a new
    /// depth, size, speed and slant.
    private func place(_ streak: RainStreak, spread: Bool) {
        let depth = random.unit()
        let near = depth * depth
        let length = CGFloat(16 + 46 * near) * CGFloat(0.8 + 0.5 * level)
        let width = CGFloat(0.6 + 1.1 * near)
        let speed = (620 + 820 * near) * (0.85 + 0.35 * level)
        let slant = 0.13 + 0.07 * gust + random.range(-0.02, 0.02)
        streak.length = length
        streak.opacity = Float((0.1 + 0.2 * near) * (0.75 + 0.45 * level))
        streak.velocity = CGPoint(x: CGFloat(sin(slant) * speed), y: CGFloat(cos(slant) * speed))
        // It leans, so it may come in from beyond the left edge
        let x = random.range(-0.2, 1.05) * Double(bounds.width)
        let y = spread ? random.range(0, 1.1) * Double(bounds.height) : -random.range(0, 0.25) * Double(bounds.height)
        streak.head = CGPoint(x: x, y: y)
        streak.layer.bounds = CGRect(x: 0, y: 0, width: width, height: length)
        streak.layer.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(-slant)))
        streak.layer.position = streak.head
    }

    /// The rain splashing on the boxes' top edges: a little crown of water that opens and is gone.
    private func stepSplashes(dt: Double) {
        if kind == .rain {
            for shelf in shelves {
                splashesDue += dt * (2 + 12 * level) * Double(shelf.rect.width / 320)
                while splashesDue >= 1 {
                    splashesDue -= 1
                    let splash = CALayer()
                    splash.contents = Self.splash
                    splash.contentsGravity = .resize
                    let size = CGFloat(random.range(5, 10))
                    splash.bounds = CGRect(x: 0, y: 0, width: size, height: size * 0.6)
                    splash.anchorPoint = CGPoint(x: 0.5, y: 1)
                    let reach = shelf.rect.width - 2 * shelf.cornerRadius
                    splash.position = CGPoint(x: shelf.rect.minX + shelf.cornerRadius + CGFloat(random.unit()) * reach, y: shelf.rect.minY)
                    splash.opacity = 0
                    glassLayer.addSublayer(splash)
                    splashes.append((layer: splash, age: 0))
                }
            }
        }
        for index in splashes.indices.reversed() {
            let age = splashes[index].age + dt
            let life = 0.26
            if age >= life {
                splashes[index].layer.removeFromSuperlayer()
                splashes.remove(at: index)
                continue
            }
            splashes[index].age = age
            let t = CGFloat(age / life)
            splashes[index].layer.setAffineTransform(CGAffineTransform(scaleX: 0.5 + 0.9 * t, y: 0.4 + 0.9 * t))
            splashes[index].layer.opacity = Float(0.6 * (1 - t) * min(1, t * 6))
        }
    }

    private static func approach(_ value: Float, _ target: Float, dt: Double, time: Double) -> Float {
        guard value != target else { return value }
        let next = value + (target - value) * min(1, Float(dt / time) * 2.2)
        return abs(next - target) < 0.004 ? target : next
    }

    // MARK: Drops

    /// The box a point is on, if any (with `margin` round it).
    private func shelfIndex(at point: CGPoint, margin: CGFloat) -> Int? {
        shelves.firstIndex { $0.rect.insetBy(dx: -margin, dy: -margin).contains(point) }
    }

    /// Which way a drop on a box's top edge runs: to the nearer corner (either, near the middle).
    private func rideDirection(from x: CGFloat, on rect: CGRect) -> CGFloat {
        let off = (x - rect.midX) / max(1, rect.width)
        if abs(off) < 0.08 {
            return random.unit() < 0.5 ? -1 : 1
        }
        return off < 0 ? -1 : 1
    }

    /// A new drop lands somewhere on the glass: mostly fine droplets and small drops, now and then a
    /// big one (more of them the harder it rains), a big one sometimes sliding down after a moment.
    /// None lands on a box: it beads on the box's top edge, or lands elsewhere.
    private func land() {
        let mist = random.unit() < 0.42
        let radius: CGFloat
        if mist {
            radius = CGFloat(random.range(0.7, 1.7))
        } else {
            radius = CGFloat(2.2 + pow(random.unit(), 2.2) * (5.5 + 5 * level))
        }
        var center = CGPoint(x: random.range(0, Double(bounds.width)), y: random.range(-0.04, 1) * Double(bounds.height))
        var restsOn: Int?
        if let shelf = shelfIndex(at: center, margin: radius) {
            if random.unit() < 0.7 {
                let rect = shelves[shelf].rect
                let inset = shelves[shelf].cornerRadius * 0.8
                center.x = min(max(center.x, rect.minX + inset), rect.maxX - inset)
                center.y = rect.minY - radius * GlassDrop.ledgeGap
                restsOn = shelf
            } else {
                var tries = 0
                repeat {
                    center = CGPoint(x: random.range(0, Double(bounds.width)), y: random.range(-0.04, 1) * Double(bounds.height))
                    tries += 1
                } while tries < 5 && shelfIndex(at: center, margin: radius) != nil
                if shelfIndex(at: center, margin: radius) != nil { return }
            }
        }
        let life = mist ? random.range(2, 5) : random.range(3.5, 8) * (0.8 + Double(radius) / 20)
        var slidesAfter: Double?
        if restsOn != nil {
            // On a ledge the water gathers and runs off sooner
            if radius > 2.4, random.unit() < 0.75 {
                slidesAfter = random.range(0.4, 2.6)
            }
        } else if radius > 5, random.unit() < 0.45 + 0.3 * level {
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
        drop.restsOn = restsOn
        drop.lens?.contents = backdrop
        glassLayer.addSublayer(drop.layer)
        drops.append(drop)
        drop.update(lensRect: lensRect(for: drop))
    }

    /// A big drop slides down, in fits and starts, wandering a little sideways; it picks up the
    /// drops it runs into, leaves tiny droplets and a wet trail behind, and stops once it's small.
    /// One that comes down onto a box runs round it (see `ride`).
    private func slide(_ drop: GlassDrop, dt: Double) {
        if let ride = drop.ride {
            self.ride(drop, ride, dt: dt)
        } else {
            drop.phase += dt * 7 * drop.pace
            let top = 60 + 18 * Double(drop.radius)
            let surge = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(drop.phase), 2)
            drop.speed = CGFloat(top * surge * drop.pace)
            let footBefore = drop.center.y + drop.radius * GlassDrop.ledgeGap
            drop.center.y += drop.speed * CGFloat(dt)
            drop.center.x += CGFloat(sin(drop.phase * 0.43) * 7 * dt)
            let foot = drop.center.y + drop.radius * GlassDrop.ledgeGap
            // Onto a box's top edge: it can't go through
            for (index, shelf) in shelves.enumerated() {
                let rect = shelf.rect
                guard footBefore <= rect.minY + 1, foot >= rect.minY,
                      drop.center.x > rect.minX - drop.radius * 0.2, drop.center.x < rect.maxX + drop.radius * 0.2 else { continue }
                let direction = rideDirection(from: drop.center.x, on: rect)
                let cornerX = direction > 0 ? rect.maxX - shelf.cornerRadius : rect.minX + shelf.cornerRadius
                if (drop.center.x - cornerX) * direction > 0 {
                    // Onto the rounded corner: from that point of it on
                    let reach = shelf.cornerRadius + drop.radius * GlassDrop.ledgeGap
                    let angle = asin(min(1, max(0, (drop.center.x - cornerX) * direction / max(1, reach))))
                    drop.ride = .corner(shelf: index, direction: direction, angle: angle)
                } else {
                    drop.ride = .top(shelf: index, direction: direction)
                }
                drop.center.y = rect.minY - drop.radius * GlassDrop.ledgeGap
                drop.speed = 0
                break
            }
        }

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
        if drop.ride == nil, drop.center.y - drop.lastDroplet > drop.radius * 2.2 {
            drop.lastDroplet = drop.center.y
            let size = drop.radius * CGFloat(random.range(0.16, 0.3))
            let place = CGPoint(x: drop.center.x + CGFloat(random.range(-0.25, 0.25)) * drop.radius, y: drop.center.y - drop.radius * 1.25)
            if size >= 0.6, random.unit() < 0.7, shelfIndex(at: place, margin: size) == nil {
                let droplet = GlassDrop(
                    center: place,
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
                glassLayer.addSublayer(droplet.layer)
                drops.append(droplet)
                droplet.update(lensRect: nil)
            }
            drop.radius *= 0.985
        }
        if drop.radius < 3.4, drop.ride == nil {
            // Too small to slide on: it stays and dries
            drop.isSliding = false
            drop.life = drop.age + 1.5
        }
        if drop.trail == nil {
            let trail = CAShapeLayer()
            trail.fillColor = nil
            trail.strokeColor = UIColor.white.withAlphaComponent(0.15).cgColor
            trail.lineCap = .round
            trail.lineJoin = .round
            trail.opacity = 1
            glassLayer.insertSublayer(trail, below: drop.layer)
            drop.trail = trail
            drop.trailPoints = [drop.center]
        }
        drop.updateTrail()
    }

    /// A drop on a box: along its top edge to the corner, round the corner, down the side, and off
    /// below, where it slides on down the glass.
    private func ride(_ drop: GlassDrop, _ ride: GlassDrop.Ride, dt: Double) {
        let index: Int
        switch ride {
        case .top(let shelf, _), .corner(let shelf, _, _), .side(let shelf, _):
            index = shelf
        }
        guard shelves.indices.contains(index) else {
            drop.ride = nil
            return
        }
        let rect = shelves[index].rect
        let corner = shelves[index].cornerRadius
        let gap = drop.radius * GlassDrop.ledgeGap
        drop.phase += dt * 5 * drop.pace
        let surge = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(drop.phase), 2)
        let radius = Double(drop.radius)
        switch ride {
        case .top(_, let direction):
            // Slowly: only the ledge's slight give and the water behind push it
            let speed = CGFloat((30 + 7 * radius) * surge * drop.pace)
            drop.speed = 0
            drop.center.x += direction * speed * CGFloat(dt)
            drop.center.y = rect.minY - gap
            let cornerX = direction > 0 ? rect.maxX - corner : rect.minX + corner
            if (drop.center.x - cornerX) * direction >= 0 {
                drop.ride = .corner(shelf: index, direction: direction, angle: 0)
            }
        case .corner(_, let direction, let angle):
            let speed = (46 + 11 * radius) * surge * drop.pace
            let reach = corner + gap
            let turned = angle + CGFloat(speed * dt) / max(1, reach)
            let cornerX = direction > 0 ? rect.maxX - corner : rect.minX + corner
            let cornerY = rect.minY + corner
            if turned >= .pi / 2 {
                drop.center = CGPoint(x: cornerX + direction * reach, y: cornerY)
                drop.ride = .side(shelf: index, direction: direction)
            } else {
                drop.center = CGPoint(x: cornerX + direction * reach * sin(turned), y: cornerY - reach * cos(turned))
                drop.ride = .corner(shelf: index, direction: direction, angle: turned)
            }
            drop.speed = CGFloat(speed) * sin(turned)
        case .side(_, let direction):
            let speed = CGFloat((58 + 17 * radius) * surge * drop.pace)
            drop.speed = speed
            drop.center.x = direction > 0 ? rect.maxX + gap : rect.minX - gap
            drop.center.y += speed * CGFloat(dt)
            if drop.center.y >= rect.maxY - corner * 0.4 {
                // Off the box: it drips on down the glass
                drop.ride = nil
                drop.lastDroplet = drop.center.y
            }
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
    /// snowing, fading in), fall, sway and drift with a wind that comes and goes, and wrap round the
    /// sides; near ones may settle on the glass and melt. The frost on the edges follows how hard it
    /// snows, slowly, and snow piles up on the boxes.
    private func stepSnow(dt: Double) {
        let wanted = kind == .snow ? Int(36 + 140 * level) : 0
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

        // A light wind that swings and gusts: now and then the snow blows across
        let wind = 10 + 16 * gust + 9 * sin(time * 0.19)
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
                    if shelfIndex(at: flake.center, margin: flake.size / 2) == nil {
                        settle(flake)
                    }
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

        // Snow on the boxes: it piles up over half a minute, and melts away faster
        let deepest = kind == .snow ? CGFloat(3.5 + 5 * level) : 0
        if snowDepth < deepest {
            snowDepth = min(deepest, snowDepth + CGFloat(dt) * deepest / 28)
        } else if snowDepth > deepest {
            snowDepth = max(deepest, snowDepth - CGFloat(dt) * 1.2)
        }
        drawSnowCaps()
    }

    /// The snow lying on each box's top edge: an uneven white drift, thinning out to the corners.
    private func drawSnowCaps() {
        guard abs(snowDepth - snowDrawn) > 0.15 || (snowDepth == 0 && snowDrawn != 0) else { return }
        snowDrawn = snowDepth
        while snowCaps.count > shelves.count {
            snowCaps.removeLast().removeFromSuperlayer()
        }
        while snowCaps.count < shelves.count {
            let cap = CAShapeLayer()
            cap.fillColor = UIColor(red: 0.97, green: 0.98, blue: 1, alpha: 0.96).cgColor
            cap.shadowColor = UIColor.black.cgColor
            cap.shadowOpacity = 0.18
            cap.shadowRadius = 1.5
            cap.shadowOffset = CGSize(width: 0, height: 1)
            glassLayer.addSublayer(cap)
            snowCaps.append(cap)
        }
        for (index, shelf) in shelves.enumerated() {
            let cap = snowCaps[index]
            guard snowDepth > 0.2 else {
                cap.path = nil
                continue
            }
            let left = shelf.rect.minX + shelf.cornerRadius * 0.45
            let right = shelf.rect.maxX - shelf.cornerRadius * 0.45
            let base = shelf.rect.minY + 0.5
            let path = CGMutablePath()
            path.move(to: CGPoint(x: left, y: base))
            let steps = max(8, Int((right - left) / 6))
            for step in 0...steps {
                let t = CGFloat(step) / CGFloat(steps)
                let x = left + (right - left) * t
                // Thinner at the ends, with soft humps along it (the same every time)
                let taper = min(1, min(t, 1 - t) * 7)
                let humps = 0.72 + 0.18 * sin(Double(x) * 0.071 + Double(index)) + 0.1 * sin(Double(x) * 0.19 + 2)
                path.addLine(to: CGPoint(x: x, y: base - snowDepth * taper.squareRoot() * CGFloat(humps)))
            }
            path.addLine(to: CGPoint(x: right, y: base))
            path.closeSubpath()
            cap.path = path
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
        glassLayer.addSublayer(flake.layer)
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
        glassLayer.insertSublayer(drop.layer, below: flake.layer)
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

    // MARK: The rain's and the fog's look

    /// A streak of rain: a fine white line, brightest at its head (the bottom) and fading up its tail.
    private static func makeStreak() -> CGImage? {
        let size = CGSize(width: 6, height: 96)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            let cg = context.cgContext
            let colors = [
                UIColor.white.withAlphaComponent(0).cgColor,
                UIColor.white.withAlphaComponent(0.35).cgColor,
                UIColor.white.withAlphaComponent(1).cgColor,
            ] as CFArray
            let locations: [CGFloat] = [0, 0.55, 1]
            guard let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: locations) else { return }
            // Soft sides, a rounded head
            cg.addPath(UIBezierPath(roundedRect: CGRect(x: 1, y: 0, width: 4, height: size.height), cornerRadius: 2).cgPath)
            cg.clip()
            cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: size.height), options: [])
        }
        return image.cgImage
    }

    /// A bank of fog: a soft pale cloud, densest a little below its middle, gone at its rim.
    private static func makePuff() -> CGImage? {
        let pixels: CGFloat = 160
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: CGSize(width: pixels, height: pixels), format: format).image { context in
            let cg = context.cgContext
            let pale = UIColor(red: 0.95, green: 0.96, blue: 0.98, alpha: 1)
            let colors = [
                pale.withAlphaComponent(0.6).cgColor,
                pale.withAlphaComponent(0.38).cgColor,
                pale.withAlphaComponent(0.12).cgColor,
                pale.withAlphaComponent(0).cgColor,
            ] as CFArray
            let locations: [CGFloat] = [0, 0.4, 0.75, 1]
            guard let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: locations) else { return }
            // Several lobes, so it isn't a plain disc
            let lobes: [(x: CGFloat, y: CGFloat, radius: CGFloat)] = [(0.5, 0.55, 0.45), (0.3, 0.5, 0.3), (0.7, 0.52, 0.3), (0.5, 0.38, 0.28)]
            for lobe in lobes {
                let center = CGPoint(x: pixels * lobe.x, y: pixels * lobe.y)
                cg.drawRadialGradient(gradient, startCenter: center, startRadius: 0, endCenter: center, endRadius: pixels * lobe.radius, options: [])
            }
        }
        return image.cgImage
    }

    /// A splash on a ledge: a little crown of water, two arcs thrown up and out and a few specks.
    private static func makeSplash() -> CGImage? {
        let size = CGSize(width: 60, height: 36)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            let cg = context.cgContext
            cg.setStrokeColor(UIColor.white.withAlphaComponent(0.9).cgColor)
            cg.setLineCap(.round)
            cg.setLineWidth(3)
            let foot = CGPoint(x: size.width / 2, y: size.height - 2)
            for side: CGFloat in [-1, 1] {
                cg.move(to: CGPoint(x: foot.x + side * 4, y: foot.y))
                cg.addQuadCurve(to: CGPoint(x: foot.x + side * 24, y: 8), control: CGPoint(x: foot.x + side * 9, y: 8))
            }
            cg.strokePath()
            cg.setFillColor(UIColor.white.withAlphaComponent(0.85).cgColor)
            for speck in [CGPoint(x: foot.x - 15, y: 4), CGPoint(x: foot.x + 12, y: 3), CGPoint(x: foot.x, y: 9)] {
                cg.fillEllipse(in: CGRect(x: speck.x - 2, y: speck.y - 2, width: 4, height: 4))
            }
        }
        return image.cgImage
    }
}

// MARK: - A drop

/// One drop on the glass: its lens (the map behind it) and its light, its place and size, how long it
/// has been there and lasts, and whether it slides (down the glass, or round a box).
private final class GlassDrop {
    /// On a box: along its top edge, round its corner (how far round, 0 ... π/2), down its side.
    /// `direction`: -1 to the left corner, 1 to the right one.
    enum Ride: Equatable {
        case top(shelf: Int, direction: CGFloat)
        case corner(shelf: Int, direction: CGFloat, angle: CGFloat)
        case side(shelf: Int, direction: CGFloat)
    }

    /// How far a drop's middle stays from the edge it sits on or runs along, in radii: it just
    /// overlaps the edge, as water clinging to it (the box is drawn over the glass, so what's
    /// under the box doesn't show)
    static let ledgeGap: CGFloat = 0.85

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
    /// The box whose top edge it beads on, and where it is on a box while it runs round it
    var restsOn: Int?
    var ride: Ride?
    /// Where the wet trail starts, where the last droplet was left, the trail and the way it came
    var trailTop: CGFloat = 0
    var lastDroplet: CGFloat = 0
    var trail: CAShapeLayer?
    var trailPoints: [CGPoint] = []

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
        if restsOn != nil, !isSliding {
            // A bead on a ledge: a little wider than tall
            squashX = 1.08
            squashY = 0.94
        }
        if isSliding {
            if case .top? = ride {
                // Running along a ledge: drawn out sideways
                squashX = 1.14
                squashY = 0.9
            } else {
                // Stretched down as it runs, more the faster
                squashX = 0.9
                squashY = 1.1 + min(0.2, speed / 900)
            }
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

    /// The wet trail along the way it came, winding as it wandered, up to just behind it.
    func updateTrail() {
        guard let trail else { return }
        if let last = trailPoints.last {
            let dx = center.x - last.x
            let dy = center.y - last.y
            if dx * dx + dy * dy >= 6 {
                trailPoints.append(center)
                // Long enough: the oldest stretch has dried
                if trailPoints.count > 260 {
                    trailPoints.removeFirst(trailPoints.count - 260)
                }
            }
        } else {
            trailPoints = [center]
        }
        guard trailPoints.count >= 2 else { return }
        let path = CGMutablePath()
        path.addLines(between: trailPoints)
        path.addLine(to: center)
        trail.path = path
        trail.lineWidth = max(1.2, radius * 1.05)
    }

    func remove() {
        layer.removeFromSuperlayer()
        trail?.removeFromSuperlayer()
    }
}

/// One streak of rain falling beyond the glass: where its head is, how fast it falls and which way.
private final class RainStreak {
    let layer = CALayer()
    var head = CGPoint.zero
    var velocity = CGPoint.zero
    var length: CGFloat = 0
    var opacity: Float = 0

    init(image: CGImage?) {
        layer.contents = image
        layer.contentsGravity = .resize
        // Its head is where it is; the tail trails behind
        layer.anchorPoint = CGPoint(x: 0.5, y: 1)
    }
}

/// One bank of fog drifting along an edge.
private final class FogPuff {
    let layer = CALayer()
    var center: CGPoint
    let size: CGSize
    let speed: CGFloat
    let opacity: Float
    var phase: Double
    let breath: Double

    init(center: CGPoint, size: CGSize, speed: CGFloat, opacity: Float, phase: Double, breath: Double, image: CGImage?) {
        self.center = center
        self.size = size
        self.speed = speed
        self.opacity = opacity
        self.phase = phase
        self.breath = breath
        layer.contents = image
        layer.contentsGravity = .resize
        layer.bounds = CGRect(origin: .zero, size: size)
        layer.position = center
        layer.opacity = 0
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
