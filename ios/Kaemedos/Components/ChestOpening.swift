import CoreHaptics
import SwiftUI
import UIKit

/// A chest opening, drawn with the chest's own illustration, so the chest that opens is exactly the
/// one in the picture. The artwork is cut into layers (lid, body, padlock, the inside of the chest
/// and of the lid; see scripts/maintenance/split-chests.py) and those layers are what moves: the
/// chest drops in, the lid strains against the padlock, the shackle pops, the padlock falls to the
/// floor and the lid swings open on its hinge; light pours out of the chest.
///
/// It goes from less to more with the rarity: common has a warm glow; rare leaks light through the
/// seam before it opens; epic charges longer, with a purple light and a shockwave; legendary
/// levitates while it charges and slams down, then bursts open in a flash with two shockwaves.
/// Light, rays, particles, shake and haptics (Core Haptics rumbles on the premium ones) all grow
/// with the rarity.
///
/// Tapping skips to the open chest; with Reduce Motion the padlock fades and the lid just opens.
/// `onOpened` is called once, when the lid is open (or the animation was skipped).
struct ChestOpeningView: View {
    let rarity: String
    let onOpened: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var start: Date?
    /// Seconds added to the clock by a skip.
    @State private var jump: TimeInterval = 0
    @State private var finished = false
    @State private var haptics = ChestHaptics()
    @State private var events: Task<Void, Never>?

    var body: some View {
        let script = ChestScript(tier: ChestTier(rarity), calm: reduceMotion)
        GeometryReader { proxy in
            TimelineView(.animation) { context in
                ChestStage(
                    art: ChestArt(rarity),
                    tier: script.tier,
                    script: script,
                    time: elapsed(at: context.date),
                    size: proxy.size
                )
            }
        }
        .background(ChestStage.background)
        .contentShape(Rectangle())
        .onTapGesture { skip(script) }
        .onAppear { begin(script) }
        .onDisappear {
            events?.cancel()
            haptics.stopRumble()
        }
        .accessibilityElement()
        .accessibilityLabel("Abriendo el cofre \(Rarity.label(rarity).lowercased())")
        .accessibilityAction(named: "Abrir ya") { skip(script) }
    }

    /// The colour of the light that comes out of the chest.
    static func lightColor(_ rarity: String) -> Color {
        ChestTier(rarity).light
    }

    /// Decodes the layers ahead of time (in the background) so the first opening doesn't stutter.
    static func prewarm() {
        DispatchQueue.global(qos: .utility).async {
            for rarity in ["common", "rare", "epic", "legendary"] {
                for layer in ChestArt(rarity).layerNames {
                    _ = UIImage(named: layer)?.preparingForDisplay()
                }
            }
        }
    }

    private func elapsed(at date: Date) -> Double {
        guard let start else { return 0 }
        return max(0, date.timeIntervalSince(start)) + jump
    }

    private func begin(_ script: ChestScript) {
        guard start == nil else { return }
        start = Date()
        haptics.prepare()
        let haptics = haptics
        let cues = script.cues(haptics)
        events = Task { @MainActor in
            let began = Date()
            for cue in cues {
                let wait = cue.time - Date().timeIntervalSince(began)
                if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
                if Task.isCancelled { return }
                cue.action()
            }
            if Task.isCancelled { return }
            finish()
        }
    }

    /// Jumps to the open chest.
    private func skip(_ script: ChestScript) {
        guard let start, !finished else { return }
        events?.cancel()
        haptics.stopRumble()
        let now = Date().timeIntervalSince(start) + jump
        if now < script.done { jump += script.done - now }
        if script.tier.level >= 1 { haptics.success() }
        finish()
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        onOpened()
    }
}

// MARK: - Tiers

/// How big the opening of each rarity is.
private struct ChestTier {
    /// 0 common · 1 rare · 2 epic · 3 legendary
    let level: Int
    let light: Color
    let mote: Color
    let spark: Color
    let beamOpacity: Double
    let motes: Int
    let sparks: Int
    /// How far the lid lifts on each knock against the padlock (radians).
    let knocks: [Double]
    /// Seconds of charging (trembling, light leaking from the seam) before the padlock gives way.
    let charge: Double
    let seamGlow: Double
    let levitates: Bool
    let shockwaves: Int
    let flash: Bool
    /// Shake of the whole scene on the burst, in pixels of the artwork.
    let shake: Double
    /// Core Haptics rumble strength while charging and after the burst (0: none).
    let rumble: Float

    init(_ rarity: String) {
        switch rarity {
        case "rare":
            level = 1
            light = Color(red: 0.72, green: 0.86, blue: 1)
            mote = Color(red: 0.8, green: 0.9, blue: 1)
            spark = Color(red: 0.85, green: 0.93, blue: 1)
            beamOpacity = 0.85; motes = 14; sparks = 36
            knocks = [0.06, 0.09, 0.065]; charge = 0.35; seamGlow = 0.55
            levitates = false; shockwaves = 0; flash = false
            shake = 3; rumble = 0.35
        case "epic":
            level = 2
            light = Color(red: 0.82, green: 0.56, blue: 1)
            mote = Color(red: 0.86, green: 0.66, blue: 1)
            spark = Color(red: 1, green: 0.84, blue: 0.45)
            beamOpacity = 1; motes = 20; sparks = 56
            knocks = [0.07, 0.1, 0.08, 0.12]; charge = 0.7; seamGlow = 0.85
            levitates = false; shockwaves = 1; flash = false
            shake = 7; rumble = 0.65
        case "legendary":
            level = 3
            light = Color(red: 0.45, green: 0.78, blue: 1)
            mote = Color(red: 0.6, green: 0.85, blue: 1)
            spark = Color(red: 0.8, green: 0.95, blue: 1)
            beamOpacity = 1; motes = 30; sparks = 84
            knocks = [0.08, 0.11, 0.09, 0.14]; charge = 1.1; seamGlow = 1
            levitates = true; shockwaves = 2; flash = true
            shake = 12; rumble = 1
        default:
            level = 0
            light = Color(red: 1, green: 0.76, blue: 0.42)
            mote = Color(red: 1, green: 0.82, blue: 0.5)
            spark = Color(red: 1, green: 0.82, blue: 0.5)
            beamOpacity = 0.75; motes = 10; sparks = 24
            knocks = [0.06, 0.085, 0.05]; charge = 0; seamGlow = 0
            levitates = false; shockwaves = 0; flash = false
            shake = 0; rumble = 0
        }
    }
}

// MARK: - Artwork

/// The layers of a chest and where things are on them, in pixels of the 420 px artwork (the same
/// outlines split-chests.py cut them with).
private struct ChestArt {
    static let canvas: CGFloat = 420
    /// Where the chest stands.
    static let floor: CGFloat = 341
    /// Front-to-back depth of the chest, as the lid's front edge rises that much when upright.
    static let depth: CGFloat = 95

    let name: String
    /// Front-left, front-right and back-right corners of the top of the body.
    let frontLeft: CGPoint
    let frontRight: CGPoint
    let backRight: CGPoint
    /// Top of the lid.
    let lidTop: CGFloat
    /// The padlock (body and shackle).
    let lock: CGRect

    init(_ rarity: String) {
        switch rarity {
        case "rare":
            name = "chest_rare"
            frontLeft = CGPoint(x: 30, y: 171); frontRight = CGPoint(x: 304, y: 188); backRight = CGPoint(x: 391, y: 162)
            lidTop = 79; lock = CGRect(x: 107, y: 186, width: 99, height: 126)
        case "epic":
            name = "chest_epic"
            frontLeft = CGPoint(x: 30, y: 172); frontRight = CGPoint(x: 306, y: 190); backRight = CGPoint(x: 392, y: 166)
            lidTop = 79; lock = CGRect(x: 111, y: 188, width: 97, height: 128)
        case "legendary":
            name = "chest_legendary"
            frontLeft = CGPoint(x: 34, y: 179); frontRight = CGPoint(x: 308, y: 194); backRight = CGPoint(x: 392, y: 171)
            lidTop = 76; lock = CGRect(x: 114, y: 192, width: 97, height: 126)
        default:
            name = "chest_common"
            frontLeft = CGPoint(x: 32, y: 172); frontRight = CGPoint(x: 306, y: 190); backRight = CGPoint(x: 392, y: 165)
            lidTop = 77; lock = CGRect(x: 111, y: 189, width: 97, height: 126)
        }
    }

    var lid: String { name + "_lid" }
    var under: String { name + "_under" }
    var base: String { name + "_base" }
    var inside: String { name + "_inside" }
    var padlock: String { name + "_lock" }
    var layerNames: [String] { [lid, under, base, inside, padlock] }

    /// From the front edge of the top to the back edge.
    var depthVector: CGVector { CGVector(dx: backRight.x - frontRight.x, dy: backRight.y - frontRight.y) }
    var backLeft: CGPoint { CGPoint(x: frontLeft.x + depthVector.dx, y: frontLeft.y + depthVector.dy) }
    var opening: [CGPoint] { [frontLeft, frontRight, backRight, backLeft] }
    var openingCenter: CGPoint {
        CGPoint(
            x: (frontLeft.x + frontRight.x) / 2 + depthVector.dx / 2,
            y: (frontLeft.y + frontRight.y) / 2 + depthVector.dy / 2
        )
    }

    /// How the lid is drawn when open by `angle` radians around its hinge at the back.
    ///
    /// The front edge rises and goes back, the top of the dome swings back towards the hinge; once
    /// they cross, the dome is seen edge-on and from then on it's the inside of the lid that shows
    /// (its own layer, upside down, pinned to the hinge).
    func lidPose(_ angle: Double) -> LidPose {
        let c = CGFloat(cos(angle)), s = CGFloat(sin(angle))
        let bottom = frontRight.y
        let hinge = bottom + depthVector.dy
        let front = bottom - Self.depth * s + depthVector.dy * (1 - c)
        let top = hinge - (hinge - lidTop) * c
        let height = bottom - lidTop
        let shift = depthVector.dx * (1 - c) * 0.8
        if front >= top {
            return LidPose(showsInside: false, scaleY: (front - top) / height, offset: CGSize(width: shift, height: top - lidTop), anchorY: lidTop)
        }
        return LidPose(showsInside: true, scaleY: (top - front) / height, offset: CGSize(width: shift, height: front - lidTop), anchorY: lidTop)
    }
}

/// A lid layer squashed vertically around `anchorY` and then moved by `offset` (artwork pixels).
private struct LidPose {
    let showsInside: Bool
    let scaleY: CGFloat
    let offset: CGSize
    let anchorY: CGFloat
}

// MARK: - Timing

private enum Ease {
    static func linear(_ t: Double) -> Double { t }
    static func inQuad(_ t: Double) -> Double { t * t }
    static func outQuad(_ t: Double) -> Double { 1 - (1 - t) * (1 - t) }
    static func outCubic(_ t: Double) -> Double { 1 - pow(1 - t, 3) }
    static func inOut(_ t: Double) -> Double { t * t * (3 - 2 * t) }
}

/// A value that goes through steps one after another.
private struct Track {
    private struct Step {
        let start: Double
        let duration: Double
        let target: Double
        let ease: (Double) -> Double
    }

    private let initial: Double
    private var steps: [Step] = []
    private var cursor: Double = 0

    init(_ initial: Double) { self.initial = initial }

    /// The next step starts no earlier than `time`.
    mutating func wait(until time: Double) {
        cursor = max(cursor, time)
    }

    mutating func go(to target: Double, over duration: Double, _ ease: @escaping (Double) -> Double = Ease.inOut) {
        steps.append(Step(start: cursor, duration: duration, target: target, ease: ease))
        cursor += duration
    }

    func value(at time: Double) -> Double {
        var current = initial
        for step in steps {
            if time <= step.start { return current }
            let progress = step.duration > 0 ? min(1, (time - step.start) / step.duration) : 1
            if progress < 1 { return current + (step.target - current) * step.ease(progress) }
            current = step.target
        }
        return current
    }
}

/// When something happens (haptics), in seconds from the start.
private struct ChestCue {
    let time: Double
    let action: @MainActor () -> Void
}

/// The whole opening of a rarity, as values over time.
private struct ChestScript {
    let tier: ChestTier
    let calm: Bool

    // Moments
    var landing: Double = 0.37
    var knockTimes: [Double] = []
    var chargeStart: Double = 0
    var unlock: Double = 0
    var fall: Double = 0
    var open: Double = 0
    var hitStop: Double = 0
    var done: Double = 0

    // Chest
    var drop = Track(-330)
    var fade = Track(0)
    var squash = Track(1)
    var levitate = Track(0)
    var zoom = Track(0.88)
    var lift = Track(0)
    // Lid and padlock
    var lid = Track(0)
    var swing = Track(0)
    var pop = Track(0)
    var lockFall = Track(0)
    var lockBounce = Track(0)
    var lockOpacity = Track(1)
    // Light
    var seamFade = Track(1)
    var light = Track(0)
    var rays = Track(0)
    var flash = Track(0)
    var rings: [Track] = []

    init(tier: ChestTier, calm: Bool) {
        self.tier = tier
        self.calm = calm
        if calm { buildCalm() } else { build() }
    }

    private mutating func build() {
        // 1. Drop in and land
        drop.wait(until: 0.05)
        drop.go(to: 0, over: 0.32, Ease.inQuad)
        drop.go(to: -9, over: 0.08, Ease.outQuad)
        drop.go(to: 0, over: 0.08, Ease.inQuad)
        fade.wait(until: 0.05)
        fade.go(to: 1, over: 0.12, Ease.linear)
        squash.wait(until: landing)
        squash.go(to: 0.93, over: 0.06, Ease.outQuad)
        squash.go(to: 1.03, over: 0.1, Ease.inOut)
        squash.go(to: 1, over: 0.1, Ease.inOut)

        // Timeline, stretched by the knocks and the charge of each rarity
        let strain = 0.65
        let knockGap = 0.25
        let knocksEnd = strain + Double(tier.knocks.count - 1) * knockGap + 0.15
        chargeStart = knocksEnd + 0.05
        unlock = chargeStart + tier.charge + 0.1
        fall = unlock + 0.12
        open = unlock + 0.27
        let swingOpen = 0.42 - 0.045 * Double(tier.level)
        hitStop = open + swingOpen + 0.3
        done = open + (tier.level >= 3 ? 1.15 : 0.95)

        // 2. The lid strains against the padlock, which swings on the hasp
        for (index, angle) in tier.knocks.enumerated() {
            let time = strain + Double(index) * knockGap
            knockTimes.append(time)
            lid.wait(until: time)
            lid.go(to: angle, over: 0.07, Ease.outQuad)
            lid.go(to: 0, over: 0.08, Ease.inQuad)
        }
        let swingAmount = 1 + 0.25 * Double(tier.level)
        swing.wait(until: strain + 0.08)
        for angle in [0.22, -0.17, 0.12, -0.08, 0.04, 0] {
            swing.go(to: angle * swingAmount, over: 0.11)
        }

        // 3. Charge (rare and up): the legendary chest rises and slams down when the lock gives way
        if tier.levitates {
            levitate.wait(until: chargeStart)
            levitate.go(to: 26, over: tier.charge * 0.85)
            levitate.wait(until: unlock - 0.1)
            levitate.go(to: 0, over: 0.1, Ease.inQuad)
        }

        // 4. The shackle pops and the padlock falls to the floor
        pop.wait(until: unlock)
        pop.go(to: 1, over: 0.07, Ease.outQuad)
        lockFall.wait(until: fall)
        lockFall.go(to: 1, over: 0.3, Ease.inQuad)
        lockBounce.wait(until: fall + 0.3)
        lockBounce.go(to: 1, over: 0.07, Ease.outQuad)
        lockBounce.go(to: 0, over: 0.07, Ease.inQuad)

        // 5. The lid swings open (faster the rarer), past upright, hits its stop and settles
        lid.wait(until: open)
        // In one go: a lid seen edge-on reads as a lid that vanished, so it doesn't linger there
        lid.go(to: 1.95, over: swingOpen + 0.3, Ease.outQuad)
        lid.go(to: 1.72, over: 0.12, Ease.outQuad)
        lid.go(to: 1.82, over: 0.15, Ease.inQuad)
        squash.wait(until: hitStop)
        squash.go(to: 0.985, over: 0.06, Ease.outQuad)
        squash.go(to: 1, over: 0.14)

        // 6. Light pours out
        seamFade.wait(until: open + 0.15)
        seamFade.go(to: 0, over: 0.4)
        light.wait(until: open + 0.05)
        if tier.flash {
            light.go(to: 2.2, over: 0.15, Ease.outCubic)
            light.go(to: 1, over: 0.8, Ease.outCubic)
        } else {
            light.go(to: 1, over: 0.7, Ease.outCubic)
        }
        rays.wait(until: open + 0.2)
        rays.go(to: tier.beamOpacity, over: 0.8, Ease.outQuad)
        if tier.flash {
            flash.wait(until: open + 0.02)
            flash.go(to: 1, over: 0.5, Ease.linear)
        }
        for index in 0..<tier.shockwaves {
            var ring = Track(0)
            ring.wait(until: open + 0.08 + 0.18 * Double(index))
            ring.go(to: 1, over: 0.75, Ease.linear)
            rings.append(ring)
        }

        // Slow push in, then the chest moves up to make room for what was inside
        zoom.go(to: 1, over: open + 0.3)
        lift.wait(until: open + 0.1)
        lift.go(to: 1, over: 1.3)
    }

    /// Reduce Motion: the chest is already in place; the padlock fades and the lid opens.
    private mutating func buildCalm() {
        drop = Track(0)
        fade = Track(1)
        zoom = Track(1)
        lockOpacity.wait(until: 0.2)
        lockOpacity.go(to: 0, over: 0.25, Ease.linear)
        lid.wait(until: 0.4)
        lid.go(to: 1.82, over: 0.8)
        light.wait(until: 0.5)
        light.go(to: 1, over: 0.6, Ease.outCubic)
        rays.wait(until: 0.6)
        rays.go(to: tier.beamOpacity, over: 0.6)
        lift.wait(until: 0.5)
        lift.go(to: 1, over: 0.8)
        open = 0.5
        unlock = 0.2
        fall = .infinity
        hitStop = .infinity
        landing = .infinity
        done = 1.3
    }

    /// Haptics, in time order; the last one is at `done`.
    @MainActor
    func cues(_ haptics: ChestHaptics) -> [ChestCue] {
        var cues: [ChestCue] = []
        let level = tier.level
        if calm {
            cues.append(ChestCue(time: done) { if level >= 1 { haptics.success() } })
            return cues
        }
        cues.append(ChestCue(time: landing) { haptics.impact(.medium, 0.9) })
        for (time, angle) in zip(knockTimes, tier.knocks) {
            cues.append(ChestCue(time: time + 0.15) { haptics.impact(.rigid, min(1, angle * 9)) })
        }
        if tier.charge > 0 {
            let duration = tier.charge, strength = tier.rumble
            cues.append(ChestCue(time: chargeStart) { haptics.rumble(duration: duration, from: 0.15, to: strength, sharpness: 0.3) })
        }
        if tier.levitates {
            cues.append(ChestCue(time: unlock) { haptics.impact(.heavy, 1) })
        }
        cues.append(ChestCue(time: unlock) { haptics.impact(.rigid, 1) })
        cues.append(ChestCue(time: fall + 0.3) { haptics.impact(.light, 0.8) })
        if level >= 2 {
            let strength = tier.rumble
            cues.append(ChestCue(time: open + 0.05) {
                haptics.impact(.heavy, 1)
                haptics.rumble(duration: 0.5 + 0.4 * Double(level - 2), from: strength, to: 0, sharpness: 0.5)
            })
        }
        for index in 1..<max(1, tier.shockwaves) {
            cues.append(ChestCue(time: open + 0.08 + 0.18 * Double(index)) { haptics.impact(.heavy, 0.8) })
        }
        cues.append(ChestCue(time: hitStop) { haptics.impact(.medium, 0.75) })
        cues.append(ChestCue(time: hitStop + 0.27) { haptics.impact(.light, 0.4) })
        if level >= 1 { cues.append(ChestCue(time: done) { haptics.success() }) }
        cues.sort { $0.time < $1.time }
        cues.append(ChestCue(time: done) {})
        return cues
    }

    // MARK: Values at a time

    /// The chest trembling while it charges (radians).
    func tremble(at time: Double) -> Double {
        guard !calm, tier.charge > 0, time > chargeStart, time < unlock else { return 0 }
        let progress = min(1, (time - chargeStart) / tier.charge)
        let amount = 0.003 + 0.004 * Double(tier.level) * progress
        return amount * sin((time - chargeStart) * 2 * .pi / 0.05)
    }

    /// The chest rocking on each knock (radians).
    func rock(at time: Double) -> Double {
        guard !calm else { return 0 }
        var total = 0.0
        for (index, start) in knockTimes.enumerated() {
            let lift = tier.knocks[index]
            let side: Double = index.isMultiple(of: 2) ? 1 : -1
            let amount = 0.018 * side * lift / 0.07
            let t = time - start
            if t > 0 && t < 0.07 {
                total += amount * Ease.outQuad(t / 0.07)
            } else if t >= 0.07 && t < 0.19 {
                total += amount * (1 - Ease.inOut((t - 0.07) / 0.12))
            }
        }
        return total + tremble(at: time)
    }

    /// Light leaking around the seam while it charges, 0...1.
    func seam(at time: Double) -> Double {
        guard !calm, tier.seamGlow > 0, time > chargeStart else { return 0 }
        let progress = min(1, (time - chargeStart) / max(0.01, tier.charge))
        return tier.seamGlow * progress * (0.75 + 0.25 * sin(time * 28)) * seamFade.value(at: time)
    }

    /// Camera shake that dies down, in artwork pixels.
    func shake(at time: Double) -> CGSize {
        guard !calm else { return .zero }
        var x = 0.0, y = 0.0
        func add(from start: Double, amount: Double, duration: Double) {
            let t = time - start
            guard amount > 0, t > 0, t < duration else { return }
            let decay = amount * (1 - t / duration)
            x += decay * sin(t * 97 + 1.3) * cos(t * 41)
            y += decay * sin(t * 83 + 0.4)
        }
        add(from: open + 0.04, amount: tier.shake, duration: 0.035 * Double(6 + 3 * tier.level))
        if tier.levitates { add(from: unlock, amount: 6, duration: 0.2) }
        return CGSize(width: x, height: y)
    }
}

// MARK: - Stage

/// Everything at one moment: the chest's layers, and the light and particles around it.
private struct ChestStage: View {
    static let background = Color(red: 0.06, green: 0.048, blue: 0.042)

    let art: ChestArt
    let tier: ChestTier
    let script: ChestScript
    let time: Double
    let size: CGSize

    var body: some View {
        let space = ChestSpace(art: art, script: script, time: time, size: size)
        ZStack {
            Canvas { context, _ in
                ChestLight.drawBehind(in: &context, space: space, art: art, tier: tier, script: script, time: time)
            }
            .allowsHitTesting(false)

            chest(space)
                .frame(width: space.side, height: space.side)
                .scaleEffect(x: 1, y: CGFloat(script.squash.value(at: time)), anchor: UnitPoint(x: 0.5, y: ChestArt.floor / ChestArt.canvas))
                .rotationEffect(.radians(script.rock(at: time)), anchor: UnitPoint(x: 0.5, y: ChestArt.floor / ChestArt.canvas))
                .scaleEffect(space.zoom)
                .position(space.center)
                .opacity(script.fade.value(at: time))

            Canvas { context, _ in
                ChestLight.drawFront(in: &context, space: space, art: art, tier: tier, script: script, time: time)
            }
            .allowsHitTesting(false)
        }
        .frame(width: size.width, height: size.height)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func chest(_ space: ChestSpace) -> some View {
        let k = space.side / ChestArt.canvas
        let pose = art.lidPose(script.lid.value(at: time))
        let light = min(1, script.light.value(at: time))
        ZStack {
            // The inside of the lid, once it stands open behind the chest
            if pose.showsInside {
                lidLayer(art.under, pose: pose, k: k)
                lidLayer(art.under, pose: pose, k: k)
                    .colorMultiply(tier.light)
                    .blendMode(.plusLighter)
                    .opacity(0.45 * light)
            }
            layer(art.inside)
            // Light filling the opening
            OpeningShape(points: art.opening)
                .fill(RadialGradient(
                    colors: [.white, tier.light, tier.light.opacity(0.35)],
                    center: UnitPoint(x: art.openingCenter.x / ChestArt.canvas, y: art.openingCenter.y / ChestArt.canvas),
                    startRadius: 0,
                    endRadius: 150 * k
                ))
                .blendMode(.plusLighter)
                .opacity(light)
            layer(art.base)
            if !pose.showsInside {
                lidLayer(art.lid, pose: pose, k: k)
            }
            // Light leaking around the seam while it charges
            OpeningShape(points: [art.frontLeft, art.frontRight, art.backRight], closed: false)
                .stroke(tier.light, style: StrokeStyle(lineWidth: 9 * k, lineCap: .round, lineJoin: .round))
                .blur(radius: 7 * k)
                .blendMode(.plusLighter)
                .opacity(script.seam(at: time))
            padlock(k: k)
        }
    }

    private func layer(_ name: String) -> some View {
        Image(name)
            .resizable()
            .interpolation(.high)
    }

    private func lidLayer(_ name: String, pose: LidPose, k: CGFloat) -> some View {
        layer(name)
            .scaleEffect(x: 1, y: max(0.001, pose.scaleY), anchor: UnitPoint(x: 0.5, y: pose.anchorY / ChestArt.canvas))
            .offset(x: pose.offset.width * k, y: pose.offset.height * k)
    }

    /// The padlock: it swings on the hasp, the shackle pops, it falls and lands lying on the floor.
    private func padlock(k: CGFloat) -> some View {
        let box = art.lock
        let fall = CGFloat(script.lockFall.value(at: time))
        let bounce = CGFloat(script.lockBounce.value(at: time))
        let pop = CGFloat(script.pop.value(at: time))
        let top = UnitPoint(x: box.midX / ChestArt.canvas, y: box.minY / ChestArt.canvas)
        let center = UnitPoint(x: box.midX / ChestArt.canvas, y: box.midY / ChestArt.canvas)
        let bottom = UnitPoint(x: box.midX / ChestArt.canvas, y: box.maxY / ChestArt.canvas)
        // Landing: its bottom on the floor in front of the chest, tilted, lying down (squashed)
        let drop = (ChestArt.floor + 32 - box.maxY) * fall - 6 * bounce - 3 * pop
        return layer(art.padlock)
            .rotationEffect(.radians(script.swing.value(at: time)), anchor: top)
            .rotationEffect(.radians(-0.45 * Double(fall)), anchor: center)
            .scaleEffect(x: 1, y: 1 - 0.3 * fall, anchor: bottom)
            .offset(x: -14 * fall * k, y: drop * k)
            .opacity(script.lockOpacity.value(at: time))
    }
}

/// Where the chest is on screen at a moment, to draw light and particles in artwork pixels.
private struct ChestSpace {
    let side: CGFloat
    let zoom: CGFloat
    let center: CGPoint

    init(art: ChestArt, script: ChestScript, time: Double, size: CGSize) {
        side = min(size.width * 0.92, size.height * 0.5, 460)
        zoom = CGFloat(script.zoom.value(at: time))
        let k = side / ChestArt.canvas * zoom
        let shake = script.shake(at: time)
        let lift = CGFloat(script.lift.value(at: time))
        let raised = CGFloat(script.drop.value(at: time) - script.levitate.value(at: time))
        center = CGPoint(
            x: size.width / 2 + shake.width * k,
            y: size.height * (0.45 - 0.08 * lift) + (raised + shake.height) * k
        )
    }

    /// Screen points per artwork pixel.
    var scale: CGFloat { side / ChestArt.canvas * zoom }

    /// An artwork point on screen.
    func point(_ p: CGPoint) -> CGPoint {
        CGPoint(x: center.x + (p.x - ChestArt.canvas / 2) * scale, y: center.y + (p.y - ChestArt.canvas / 2) * scale)
    }

    /// The floor under the chest on screen (it doesn't rise when the chest drops in or levitates).
    func floor(_ p: CGPoint, raised: CGFloat) -> CGPoint {
        let q = point(p)
        return CGPoint(x: q.x, y: q.y - raised * scale)
    }
}

/// A polygon in artwork pixels, drawn in a frame the size of the artwork.
private struct OpeningShape: Shape {
    let points: [CGPoint]
    var closed = true

    func path(in rect: CGRect) -> Path {
        let k = rect.width / ChestArt.canvas
        var path = Path()
        guard let first = points.first else { return path }
        path.move(to: CGPoint(x: first.x * k, y: first.y * k))
        for p in points.dropFirst() {
            path.addLine(to: CGPoint(x: p.x * k, y: p.y * k))
        }
        if closed { path.closeSubpath() }
        return path
    }
}

// MARK: - Light and particles

/// Deterministic pseudo-random value in 0..<1.
private func hash01(_ value: Double) -> Double {
    let x = sin(value * 12.9898 + 78.233) * 43758.5453
    return x - floor(x)
}

private enum ChestLight {
    /// Behind the chest: its shadow, the halo of light and the shockwaves on the floor.
    static func drawBehind(in context: inout GraphicsContext, space: ChestSpace, art: ChestArt, tier: ChestTier, script: ChestScript, time: Double) {
        let s = space.scale
        let raised = CGFloat(script.levitate.value(at: time) - script.drop.value(at: time))
        let floorCenter = space.floor(CGPoint(x: 212, y: ChestArt.floor - 4), raised: -raised)
        // Contact shadow: smaller and lighter while the chest is in the air
        let air = min(1, max(0, raised / 120))
        let shadowWidth = 380 * s * (1 - 0.3 * air)
        context.fill(
            Path(ellipseIn: CGRect(x: floorCenter.x - shadowWidth / 2, y: floorCenter.y - 24 * s, width: shadowWidth, height: 48 * s)),
            with: .radialGradient(
                Gradient(colors: [.black.opacity(0.55 * (1 - 0.6 * Double(air)) * script.fade.value(at: time)), .clear]),
                center: floorCenter, startRadius: 0, endRadius: shadowWidth / 2
            )
        )

        let light = script.light.value(at: time)
        var glow = context
        glow.blendMode = .plusLighter
        let center = space.point(art.openingCenter)
        if light > 0 {
            let radius = 300 * s
            glow.fill(
                Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)),
                with: .radialGradient(
                    Gradient(colors: [tier.light.opacity(0.32 * min(1, light)), tier.light.opacity(0.08 * min(1, light)), .clear]),
                    center: center, startRadius: 0, endRadius: radius
                )
            )
        }
        for ring in script.rings {
            let progress = ring.value(at: time)
            guard progress > 0, progress < 1 else { continue }
            let scale = CGFloat(0.4 + 3.6 * Ease.outCubic(progress))
            let opacity = progress < 0.2 ? 1 : 1 - (progress - 0.2) / 0.8
            let rx = 75 * scale * s, ry = rx * 0.28
            let ringCenter = space.floor(CGPoint(x: 212, y: ChestArt.floor - 6), raised: 0)
            var ringContext = glow
            ringContext.addFilter(.blur(radius: 4 * s))
            ringContext.stroke(
                Path(ellipseIn: CGRect(x: ringCenter.x - rx, y: ringCenter.y - ry, width: rx * 2, height: ry * 2)),
                with: .color(tier.light.opacity(opacity)),
                lineWidth: CGFloat(14 - 8 * progress) * s
            )
        }
    }

    /// In front: rays, flash, sparks, rising motes and dust.
    static func drawFront(in context: inout GraphicsContext, space: ChestSpace, art: ChestArt, tier: ChestTier, script: ChestScript, time: Double) {
        let s = space.scale
        let origin = art.openingCenter
        var glow = context
        glow.blendMode = .plusLighter

        // Rays fanning up out of the chest, slowly swaying
        let rays = script.rays.value(at: time)
        if rays > 0.01 {
            let count = 7 + 2 * tier.level
            let base = space.point(CGPoint(x: origin.x, y: origin.y + 6))
            var beams = glow
            beams.addFilter(.blur(radius: 3 * s))
            for index in 0..<count {
                let seed = Double(index)
                let spread = (seed / Double(count - 1) - 0.5) * 1.35
                let angle = -Double.pi / 2 + spread + 0.07 * sin(time * 0.8 + seed * 1.7)
                let reach = 210 + 70 * hash01(seed) + 40 * sin(time * 1.4 + seed * 2.3)
                let length = CGFloat(reach) * s * (0.85 + 0.15 * CGFloat(tier.level))
                let width = CGFloat(18 + 16 * hash01(seed + 9)) * s
                let flicker = 0.55 + 0.45 * (0.5 + 0.5 * sin(time * 2.1 + seed * 3.1))
                let tip = CGPoint(x: base.x + CGFloat(cos(angle)) * length, y: base.y + CGFloat(sin(angle)) * length)
                let normal = CGPoint(x: -CGFloat(sin(angle)), y: CGFloat(cos(angle)))
                var path = Path()
                path.move(to: CGPoint(x: base.x + normal.x * 3 * s, y: base.y + normal.y * 3 * s))
                path.addLine(to: CGPoint(x: tip.x + normal.x * width, y: tip.y + normal.y * width))
                path.addLine(to: CGPoint(x: tip.x - normal.x * width, y: tip.y - normal.y * width))
                path.addLine(to: CGPoint(x: base.x - normal.x * 3 * s, y: base.y - normal.y * 3 * s))
                path.closeSubpath()
                beams.fill(path, with: .linearGradient(
                    Gradient(colors: [tier.light.opacity(0.5 * rays * flicker), tier.light.opacity(0.12 * rays * flicker), .clear]),
                    startPoint: base, endPoint: tip
                ))
            }
            // A bright core over the opening
            let core = 90 * s
            glow.fill(
                Path(ellipseIn: CGRect(x: base.x - core * 1.6, y: base.y - core, width: core * 3.2, height: core * 2)),
                with: .radialGradient(
                    Gradient(colors: [Color.white.opacity(0.35 * rays), tier.light.opacity(0.25 * rays), .clear]),
                    center: base, startRadius: 0, endRadius: core * 1.6
                )
            )
        }

        // Flash (legendary)
        let flash = script.flash.value(at: time)
        if flash > 0, flash < 1 {
            let radius = CGFloat(20 + 300 * Ease.outCubic(flash)) * s
            let opacity = flash < 0.16 ? flash / 0.16 : 1 - Ease.outQuad((flash - 0.16) / 0.84)
            let center = space.point(CGPoint(x: origin.x, y: origin.y - 40))
            glow.fill(
                Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)),
                with: .radialGradient(
                    Gradient(colors: [Color(red: 0.92, green: 0.97, blue: 1).opacity(opacity), tier.light.opacity(0.5 * opacity), .clear]),
                    center: center, startRadius: 0, endRadius: radius
                )
            )
        }

        if !script.calm {
            drawSparks(in: &glow, space: space, art: art, tier: tier, since: time - (script.open + 0.22))
        }
        drawMotes(in: &glow, space: space, art: art, tier: tier, since: time - (script.open + 0.3), time: time)

        // Dust: when the chest lands, when the padlock lands and when the legendary slams down
        let raised = CGFloat(script.levitate.value(at: time))
        drawDust(in: &context, space: space, since: time - script.landing, from: 40, to: 390, amount: 1, raised: raised)
        let lockX = art.lock.midX - 14
        drawDust(in: &context, space: space, since: time - (script.fall + 0.3), from: lockX - 50, to: lockX + 50, amount: 0.4, raised: 0, y: ChestArt.floor + 30)
        if tier.levitates {
            drawDust(in: &context, space: space, since: time - script.unlock, from: 30, to: 400, amount: 1.3, raised: 0)
        }
    }

    private static func dot(_ context: inout GraphicsContext, at center: CGPoint, radius: CGFloat, color: Color, opacity: Double) {
        guard radius > 0.2, opacity > 0.01 else { return }
        let halo = radius * 2.6
        context.fill(
            Path(ellipseIn: CGRect(x: center.x - halo, y: center.y - halo, width: halo * 2, height: halo * 2)),
            with: .radialGradient(
                Gradient(colors: [Color.white.opacity(opacity), color.opacity(0.6 * opacity), .clear]),
                center: center, startRadius: 0, endRadius: halo
            )
        )
    }

    /// A burst of sparks shooting up out of the chest and falling back.
    private static func drawSparks(in context: inout GraphicsContext, space: ChestSpace, art: ChestArt, tier: ChestTier, since: Double) {
        guard since > 0, since < 2 else { return }
        let width = art.frontRight.x - art.frontLeft.x
        for index in 0..<tier.sparks {
            let seed = Double(index) + 0.5
            let delay = 0.08 * hash01(seed * 1.3)
            let age = since - delay
            let life = 0.7 + 0.6 * hash01(seed * 2.1)
            guard age > 0, age < life else { continue }
            let angle = -Double.pi / 2 + (hash01(seed * 3.7) - 0.5) * 1.9
            let speed = 180 + 260 * hash01(seed * 5.3)
            let start = CGPoint(
                x: art.openingCenter.x + CGFloat(hash01(seed * 7.9) - 0.5) * width * 0.6,
                y: art.openingCenter.y + 4
            )
            let x = start.x + CGFloat(cos(angle) * speed * age)
            let y = start.y + CGFloat(sin(angle) * speed * age + 0.5 * 520 * age * age)
            let fade = pow(1 - age / life, 1.5)
            let radius = CGFloat(1.6 + 1.8 * hash01(seed * 9.1)) * space.scale
            dot(&context, at: space.point(CGPoint(x: x, y: y)), radius: radius, color: tier.spark, opacity: fade)
        }
    }

    /// Specks of light rising out of the open chest, for as long as it's on screen.
    private static func drawMotes(in context: inout GraphicsContext, space: ChestSpace, art: ChestArt, tier: ChestTier, since: Double, time: Double) {
        guard since > 0 else { return }
        let width = art.frontRight.x - art.frontLeft.x
        for index in 0..<tier.motes {
            let seed = Double(index) + 0.25
            let period = 2.2 + 1.4 * hash01(seed * 1.7)
            let first = period * hash01(seed * 2.9)
            guard since > first else { continue }
            let cycleTime = (since - first) / period
            let life = cycleTime - floor(cycleTime)
            let cycle = floor(cycleTime)
            let startX = art.openingCenter.x + CGFloat(hash01(seed * 4.3 + cycle * 0.61) - 0.5) * width * 0.75
            let rise = 120 + 110 * hash01(seed * 6.1)
            let x = startX + CGFloat(10 * sin(time * 1.7 + seed * 2.3) * life)
            let y = art.openingCenter.y - CGFloat(rise * life)
            let fade = min(1, life / 0.15) * pow(1 - life, 1.3) * (0.7 + 0.3 * sin(time * 9 + seed * 3))
            let radius = CGFloat(1.4 + 1.4 * hash01(seed * 8.7)) * space.scale
            dot(&context, at: space.point(CGPoint(x: x, y: y)), radius: radius, color: tier.mote, opacity: fade)
        }
    }

    /// Soft puffs of dust along the floor, spreading out and fading.
    private static func drawDust(in context: inout GraphicsContext, space: ChestSpace, since: Double, from: CGFloat, to: CGFloat, amount: CGFloat, raised: CGFloat, y: CGFloat = ChestArt.floor) {
        guard since > 0, since < 1.1 else { return }
        let count = Int(10 * amount) + 2
        let progress = since / 1.1
        for index in 0..<count {
            let seed = Double(index) + 0.7 + Double(from)
            let u = CGFloat(index) / CGFloat(max(1, count - 1))
            let baseX = from + (to - from) * u
            let outward: CGFloat = u < 0.5 ? -1 : 1
            let x = baseX + outward * CGFloat(30 * Ease.outCubic(progress)) * (0.5 + abs(u - 0.5))
            let py = y - CGFloat(4 + 16 * hash01(seed) * Ease.outCubic(progress))
            let radius = CGFloat(8 + 20 * Ease.outCubic(progress)) * (0.7 + 0.6 * CGFloat(hash01(seed * 2.3))) * amount.squareRoot() * space.scale
            let opacity = 0.32 * (1 - progress) * min(1, since / 0.06)
            let center = space.floor(CGPoint(x: x, y: py), raised: -raised)
            context.fill(
                Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius * 0.7, width: radius * 2, height: radius * 1.4)),
                with: .radialGradient(
                    Gradient(colors: [Color(white: 0.78).opacity(opacity), .clear]),
                    center: center, startRadius: 0, endRadius: radius
                )
            )
        }
    }
}

// MARK: - Haptics

/// Impacts with UIKit generators; continuous rumbles with Core Haptics where the phone supports them.
@MainActor
private final class ChestHaptics {
    enum Style { case light, medium, rigid, heavy }

    private let light = UIImpactFeedbackGenerator(style: .light)
    private let medium = UIImpactFeedbackGenerator(style: .medium)
    private let rigid = UIImpactFeedbackGenerator(style: .rigid)
    private let heavy = UIImpactFeedbackGenerator(style: .heavy)
    private let notification = UINotificationFeedbackGenerator()
    private var engine: CHHapticEngine?
    private var players: [CHHapticPatternPlayer] = []

    func prepare() {
        [light, medium, rigid, heavy].forEach { $0.prepare() }
        notification.prepare()
        guard engine == nil, CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
        engine = try? CHHapticEngine()
        engine?.isAutoShutdownEnabled = true
        try? engine?.start()
    }

    func impact(_ style: Style, _ intensity: Double) {
        let generator: UIImpactFeedbackGenerator
        switch style {
        case .light: generator = light
        case .medium: generator = medium
        case .rigid: generator = rigid
        case .heavy: generator = heavy
        }
        generator.impactOccurred(intensity: CGFloat(intensity))
    }

    func success() {
        notification.notificationOccurred(.success)
    }

    /// A continuous vibration whose strength goes from `from` to `to` (0...1).
    func rumble(duration: TimeInterval, from: Float, to: Float, sharpness: Float) {
        guard let engine, duration > 0 else { return }
        let event = CHHapticEvent(
            eventType: .hapticContinuous,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: 1),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness)
            ],
            relativeTime: 0,
            duration: duration
        )
        let curve = CHHapticParameterCurve(
            parameterID: .hapticIntensityControl,
            controlPoints: [
                CHHapticParameterCurve.ControlPoint(relativeTime: 0, value: from),
                CHHapticParameterCurve.ControlPoint(relativeTime: duration, value: to)
            ],
            relativeTime: 0
        )
        do {
            try engine.start()
            let pattern = try CHHapticPattern(events: [event], parameterCurves: [curve])
            let player = try engine.makePlayer(with: pattern)
            try player.start(atTime: CHHapticTimeImmediate)
            players.append(player)
        } catch {
            // Haptics are a nicety
        }
    }

    func stopRumble() {
        for player in players {
            try? player.stop(atTime: CHHapticTimeImmediate)
        }
        players.removeAll()
    }
}

// MARK: - Test screen (Ajustes)

/// Settings → "Probar apertura de cofres": every chest; tap one to watch it open, as many times as
/// you like.
struct ChestOpeningTestView: View {
    private struct Run: Identifiable {
        let id = UUID()
        let rarity: String
    }

    private static let rarities = ["common", "rare", "epic", "legendary"]
    @State private var run: Run?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Spacing.l) {
                Text("Toca un cofre para ver cómo se abre. Cuanto más raro, más luz, partículas y vibración.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                LazyVGrid(columns: [GridItem(.flexible(), spacing: DS.Spacing.m), GridItem(.flexible(), spacing: DS.Spacing.m)], spacing: DS.Spacing.m) {
                    ForEach(Self.rarities, id: \.self) { rarity in
                        Button {
                            Haptics.tap()
                            withAnimation(.easeOut(duration: 0.25)) { run = Run(rarity: rarity) }
                        } label: {
                            VStack(spacing: DS.Spacing.s) {
                                ChestView(rarity: rarity, size: 80)
                                    .frame(height: 96)
                                RarityPill(rarity: rarity)
                            }
                            .frame(maxWidth: .infinity, minHeight: 160)
                            .card(padding: DS.Spacing.m)
                        }
                        .buttonStyle(.pressable)
                        .accessibilityLabel("Abrir cofre \(Rarity.label(rarity).lowercased())")
                    }
                }
            }
            .padding(.horizontal, DS.Spacing.screen)
            .padding(.vertical, DS.Spacing.l)
        }
        .screenBackground()
        .navigationTitle("Apertura de cofres")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { ChestOpeningView.prewarm() }
        .fullScreenCover(item: $run) { current in
            ChestOpeningTestPlayer(rarity: current.rarity) { run = nil }
        }
    }
}

private struct ChestOpeningTestPlayer: View {
    let rarity: String
    let onClose: () -> Void

    @State private var take = 0
    @State private var opened = false

    var body: some View {
        ZStack {
            ChestOpeningView(rarity: rarity) {
                withAnimation(.spring(response: 0.5, dampingFraction: 0.8)) { opened = true }
            }
            .id(take)
            .ignoresSafeArea()
        }
        .overlay(alignment: .topLeading) {
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.body.weight(.semibold))
                    .frame(width: 40, height: 40)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .accessibilityLabel("Cerrar")
            .padding(DS.Spacing.screen)
        }
        .overlay(alignment: .bottom) {
            VStack(spacing: DS.Spacing.m) {
                Text("Cofre \(Rarity.label(rarity).lowercased())")
                    .font(.headline)
                if opened {
                    Button("Repetir") {
                        opened = false
                        take += 1
                    }
                        .buttonStyle(PrimaryButtonStyle())
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                } else {
                    Text("Toca para saltar")
                        .font(Font.meta)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, DS.Spacing.screen)
            .padding(.bottom, DS.Spacing.xxl)
        }
        .environment(\.colorScheme, .dark)
    }
}

#Preview("Apertura de cofres") {
    NavigationStack { ChestOpeningTestView() }
}
