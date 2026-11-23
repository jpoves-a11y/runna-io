import CoreHaptics
import SceneKit
import SwiftUI
import UIKit

/// A chest opening in real 3D (SceneKit), for every rarity. The chest drops in, the lid strains
/// against the padlock, the padlock gives way and falls to the floor and the lid swings open on its
/// hinge; light pours out of the treasure inside.
///
/// The chest is the illustration itself: it's modelled in 3D seen from the angle the picture is
/// drawn from, with the picture painted onto it from there (see `ChestArt`), so at rest it looks
/// exactly like the picture and the lid, the padlock and the hasp move with their part of it.
///
/// It goes from less to more with the rarity: common has a warm glow; rare leaks light through the
/// seam before it opens; epic has a longer charge, a purple light, a second beam and a shockwave;
/// legendary levitates while it charges and slams down, then bursts open in a flash with
/// diamond-blue flames and two shockwaves. Light, beams, particles, camera shake and haptics (Core
/// Haptics rumbles on the premium ones) all grow with the rarity.
///
/// Tapping skips to the open chest; with Reduce Motion the lid just opens. `onOpened` is called
/// once, when the lid is open (or the animation was skipped).
struct ChestOpening3DView: View {
    let rarity: String
    let onOpened: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var director = ChestOpeningDirector()

    var body: some View {
        ChestSceneView(director: director, rarity: rarity, reduceMotion: reduceMotion, onOpened: onOpened)
            .contentShape(Rectangle())
            .onTapGesture { director.skip() }
            .accessibilityElement()
            .accessibilityLabel("Abriendo el cofre \(Rarity.label(rarity).lowercased())")
            .accessibilityAction(named: "Abrir ya") { director.skip() }
    }

    /// The colour of the light that comes out of the chest.
    static func lightColor(_ rarity: String) -> Color {
        Color(uiColor: ChestTier(rarity).lightColor)
    }

    /// Builds the textures ahead of time (in the background) so the first opening doesn't stutter.
    static func prewarm() {
        DispatchQueue.global(qos: .utility).async {
            _ = ChestTextures.shared
            for rarity in ["common", "rare", "epic", "legendary"] {
                for name in ChestArt.layers(rarity) {
                    _ = UIImage(named: name)?.preparingForDisplay()
                }
            }
        }
    }
}

private struct ChestSceneView: UIViewRepresentable {
    let director: ChestOpeningDirector
    let rarity: String
    let reduceMotion: Bool
    let onOpened: () -> Void

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView(frame: .zero)
        director.attach(to: view, rarity: rarity, reduceMotion: reduceMotion, onOpened: onOpened)
        return view
    }

    func updateUIView(_ uiView: SCNView, context: Context) {}

    static func dismantleUIView(_ uiView: SCNView, coordinator: ()) {
        uiView.isPlaying = false
        uiView.scene = nil
    }
}

// MARK: - Tiers

/// How each rarity looks and how big its opening is.
private struct ChestTier {
    enum Treasure { case coins, silverAndGold, gems, crystals }

    /// 0 common · 1 rare · 2 epic · 3 legendary
    let level: Int
    let treasure: Treasure

    // Effects
    let lightColor: UIColor
    let lightIntensity: CGFloat
    let beamOpacity: CGFloat
    let beamWidth: Float
    let moteColor: UIColor
    let moteRate: CGFloat
    let sparkColor: UIColor
    let sparkRate: CGFloat
    /// How far the lid lifts on each knock against the padlock (radians).
    let knocks: [CGFloat]
    /// Seconds of charging (trembling, light leaking from the seam) before the padlock gives way.
    let charge: TimeInterval
    let seamGlow: CGFloat
    let levitates: Bool
    let shockwaves: Int
    let flash: Bool
    let flames: Bool
    let shake: Float
    /// Core Haptics rumble strength while charging and after the burst (0: none).
    let rumble: Float

    init(_ rarity: String) {
        switch rarity {
        case "rare":
            level = 1
            treasure = .silverAndGold
            lightColor = UIColor(red: 0.72, green: 0.86, blue: 1, alpha: 1); lightIntensity = 1100
            beamOpacity = 0.9; beamWidth = 1.05
            moteColor = UIColor(red: 0.8, green: 0.9, blue: 1, alpha: 1); moteRate = 55
            sparkColor = UIColor(red: 0.85, green: 0.93, blue: 1, alpha: 1); sparkRate = 1700
            knocks = [0.06, 0.09, 0.065]; charge = 0.35; seamGlow = 0.55
            levitates = false; shockwaves = 0; flash = false; flames = false
            shake = 0.01; rumble = 0.35
        case "epic":
            level = 2
            treasure = .gems
            lightColor = UIColor(red: 0.82, green: 0.56, blue: 1, alpha: 1); lightIntensity = 1700
            beamOpacity = 1; beamWidth = 1.15
            moteColor = UIColor(red: 0.86, green: 0.66, blue: 1, alpha: 1); moteRate = 85
            sparkColor = UIColor(red: 1, green: 0.84, blue: 0.45, alpha: 1); sparkRate = 3200
            knocks = [0.07, 0.1, 0.08, 0.12]; charge = 0.7; seamGlow = 0.85
            levitates = false; shockwaves = 1; flash = false; flames = false
            shake = 0.025; rumble = 0.65
        case "legendary":
            level = 3
            treasure = .crystals
            lightColor = UIColor(red: 0.45, green: 0.78, blue: 1, alpha: 1); lightIntensity = 2600
            beamOpacity = 1; beamWidth = 1.3
            moteColor = UIColor(red: 0.6, green: 0.85, blue: 1, alpha: 1); moteRate = 130
            sparkColor = UIColor(red: 0.8, green: 0.95, blue: 1, alpha: 1); sparkRate = 5200
            knocks = [0.08, 0.11, 0.09, 0.14]; charge = 1.1; seamGlow = 1
            levitates = true; shockwaves = 2; flash = true; flames = true
            shake = 0.045; rumble = 1
        default:
            level = 0
            treasure = .coins
            lightColor = UIColor(red: 1, green: 0.76, blue: 0.42, alpha: 1); lightIntensity = 750
            beamOpacity = 0.8; beamWidth = 1
            moteColor = UIColor(red: 1, green: 0.82, blue: 0.5, alpha: 1); moteRate = 36
            sparkColor = UIColor(red: 1, green: 0.82, blue: 0.5, alpha: 1); sparkRate = 900
            knocks = [0.06, 0.085, 0.05]; charge = 0; seamGlow = 0
            levitates = false; shockwaves = 0; flash = false; flames = false
            shake = 0; rumble = 0
        }
    }
}

// MARK: - Dimensions

/// Chest size in scene units (≈ metres): width (x), base height (y), depth (z), wall thickness.
/// The proportions of the illustrations (see `ChestArt`).
private enum Dim {
    static let width: CGFloat = 1.0
    static let height: CGFloat = 0.46
    static let depth: CGFloat = 0.645
    static let plank: CGFloat = 0.045
    /// Lid angle once open (radians, around the back hinge).
    static let openAngle: Float = -1.92
    /// How far back the padlock lies tilted on the floor (radians; flat would be π/2).
    static let padlockTilt: Float = 1.25
    /// Light leaking around the seam: a glow this much wider than the chest on each side.
    static let seamMargin: CGFloat = 0.14
    /// Glow of the legendary crystals before and after charging.
    static let crystalGlowStart: CGFloat = 0.35
    static let crystalGlowEnd: CGFloat = 1.1
}

// MARK: - Director

/// Builds the scene and plays the opening. Scene actions run on SceneKit's render thread; every
/// callback hops to the main thread.
@MainActor
final class ChestOpeningDirector {
    private let scene = SCNScene()
    private let events = SCNNode()
    private let chestRoot = SCNNode()
    private let lidPivot = SCNNode()
    private let padlock = SCNNode()
    private let innerLight = SCNNode()
    private let seamLight = SCNNode()
    private let seam = SCNNode()
    private let glow = SCNNode()
    private let beam = SCNNode()
    private let motes = SCNNode()
    private let flashNode = SCNNode()
    private var rings: [SCNNode] = []
    /// The camera: the rig pans (it's the point in the middle of the view), the shake node shakes,
    /// the camera itself looks from the illustration's angle and zooms.
    private let cameraRig = SCNNode()
    private let cameraShake = SCNNode()
    private let cameraNode = SCNNode()
    /// Materials that glow brighter as the chest charges (the legendary crystals).
    private var glowing: [SCNMaterial] = []

    private var tier = ChestTier("common")
    private var art = ChestArt("common")
    private var built = false
    private var finished = false
    private var motesStarted = false
    private var calm = false
    private var onOpened: (() -> Void)?
    private let haptics = ChestHaptics()

    /// Half the width of the view, in scene units: it slowly closes in.
    private static let zoomStart: Double = 1.0
    private static let zoomMid: Double = 0.85
    private static let zoomEnd: Double = 0.8
    /// The middle of the view: once open, the chest moves up to make room for what was inside.
    private static let targetStart = SCNVector3(0, 0.22, 0)
    private static let targetEnd = SCNVector3(0, -0.2, 0)

    func attach(to view: SCNView, rarity: String, reduceMotion: Bool, onOpened: @escaping () -> Void) {
        self.onOpened = onOpened
        if !built {
            tier = ChestTier(rarity)
            art = ChestArt(rarity)
            build()
            built = true
        }
        view.scene = scene
        view.pointOfView = cameraNode
        view.backgroundColor = ChestScene.background
        view.antialiasingMode = .multisampling4X
        view.preferredFramesPerSecond = 60
        view.rendersContinuously = true
        view.isUserInteractionEnabled = false
        view.isPlaying = true
        haptics.prepare()
        // Upload geometry and textures to the GPU first, then start
        view.prepare([scene]) { @Sendable [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.calm = reduceMotion
                if reduceMotion { self.playCalm() } else { self.play() }
            }
        }
    }

    // MARK: Building

    private func build() {
        let textures = ChestTextures.shared
        scene.background.contents = ChestScene.background
        scene.lightingEnvironment.contents = textures.environment
        scene.lightingEnvironment.intensity = 0.9
        let root = scene.rootNode
        root.addChildNode(events)

        // A soft contact shadow on the floor
        let contact = SCNPlane(width: Dim.width + 0.45, height: Dim.depth + 0.4)
        contact.materials = [ChestScene.decal(textures.contactShadow, add: false)]
        let contactNode = SCNNode(geometry: contact)
        contactNode.eulerAngles.x = -.pi / 2
        contactNode.position.y = 0.002
        contactNode.renderingOrder = -1
        root.addChildNode(contactNode)

        // Shockwaves on the floor (epic and legendary)
        for _ in 0..<tier.shockwaves {
            let plane = SCNPlane(width: 1, height: 1)
            plane.materials = [ChestScene.decal(textures.ring, add: true, intensity: 1.6, tint: tier.lightColor)]
            let ring = SCNNode(geometry: plane)
            ring.eulerAngles.x = -.pi / 2
            ring.position.y = 0.01
            ring.opacity = 0
            ring.renderingOrder = 12
            root.addChildNode(ring)
            rings.append(ring)
        }

        ChestScene.addLights(to: root)

        // Camera: looking from the illustration's angle, without perspective (as it's drawn), so
        // the chest at rest is the picture. It never turns: it zooms, pans and shakes.
        let camera = SCNCamera()
        camera.usesOrthographicProjection = true
        camera.projectionDirection = .horizontal
        camera.orthographicScale = Self.zoomStart
        camera.zNear = 0.1
        camera.zFar = 20
        // No HDR: the picture keeps its colours
        camera.wantsHDR = false
        cameraNode.camera = camera
        let toViewer = ChestArt.toViewer
        cameraNode.simdPosition = toViewer * 8
        cameraNode.simdOrientation = simd_quatf(simd_float3x3(columns: (ChestArt.right, ChestArt.up, toViewer)))
        cameraRig.position = Self.targetStart
        cameraShake.addChildNode(cameraNode)
        cameraRig.addChildNode(cameraShake)
        root.addChildNode(cameraRig)

        // The chest
        root.addChildNode(chestRoot)
        var builder = ChestBuilder(tier: tier, art: art)
        builder.buildBase(into: chestRoot)
        builder.buildTreasure(into: chestRoot)
        lidPivot.position = SCNVector3(0, Float(Dim.height), -Float(Dim.depth / 2))
        chestRoot.addChildNode(lidPivot)
        builder.buildLid(into: lidPivot)
        padlock.position = art.padlockHang
        chestRoot.addChildNode(padlock)
        builder.buildPadlock(into: padlock)
        glowing = builder.glowing

        // Light from inside: an omni light, a glow over the treasure and a beam of light
        innerLight.light = ChestScene.omni(color: tier.lightColor, reach: 1.4 + 0.25 * CGFloat(tier.level))
        innerLight.position = SCNVector3(0, 0.36, 0)
        chestRoot.addChildNode(innerLight)

        let glowPlane = SCNPlane(width: Dim.width - 2 * Dim.plank - 0.04, height: Dim.depth - 2 * Dim.plank - 0.04)
        glowPlane.materials = [ChestScene.decal(textures.glow, add: true, intensity: 1.3, tint: tier.lightColor)]
        glow.geometry = glowPlane
        glow.eulerAngles.x = -.pi / 2
        glow.position.y = 0.36
        glow.opacity = 0
        glow.renderingOrder = 10
        chestRoot.addChildNode(glow)

        beam.addChildNode(Self.beamCone(top: 0.62, bottom: 0.36, height: 1.15, intensity: 1.5, tint: tier.lightColor, turn: 26))
        if tier.level >= 2 {
            // A narrower, brighter core turning the other way
            let core = Self.beamCone(top: 0.34, bottom: 0.22, height: 1.6, intensity: 2.2, tint: .white, turn: -18)
            core.position.y = 0.2
            beam.addChildNode(core)
        }
        // Stretched to the chest's opening (the spinning children keep the rays turning inside)
        beam.scale = SCNVector3(1.4 * tier.beamWidth, 1, 0.92 * tier.beamWidth)
        beam.position.y = Float(Dim.height) - 0.03 + 0.575
        beam.opacity = 0
        beam.renderingOrder = 11
        chestRoot.addChildNode(beam)

        motes.position.y = 0.4
        chestRoot.addChildNode(motes)

        // Light leaking around the seam while it charges (rare and up)
        if tier.seamGlow > 0 {
            let margin = Dim.seamMargin
            let plane = SCNPlane(width: Dim.width + 2 * margin, height: Dim.depth + 2 * margin)
            plane.materials = [ChestScene.decal(textures.seam, add: true, intensity: 1.8, tint: tier.lightColor, readsDepth: true)]
            seam.geometry = plane
            seam.eulerAngles.x = -.pi / 2
            seam.position.y = Float(Dim.height) + 0.004
            seam.opacity = 0
            seam.renderingOrder = 9
            chestRoot.addChildNode(seam)
            seamLight.light = ChestScene.omni(color: tier.lightColor, reach: 1.1)
            seamLight.position = SCNVector3(0, Float(Dim.height), Float(Dim.depth / 2) + 0.22)
            chestRoot.addChildNode(seamLight)
        }

        // Flash (legendary): a glow facing the camera that blows up and fades
        if tier.flash {
            let plane = SCNPlane(width: 1, height: 1)
            plane.materials = [ChestScene.decal(textures.glow, add: true, intensity: 2.5, tint: UIColor(red: 0.85, green: 0.95, blue: 1, alpha: 1))]
            flashNode.geometry = plane
            flashNode.constraints = [SCNBillboardConstraint()]
            flashNode.position = SCNVector3(0, Float(Dim.height) + 0.25, 0)
            flashNode.opacity = 0
            flashNode.renderingOrder = 20
            chestRoot.addChildNode(flashNode)
        }
    }

    private static func beamCone(top: CGFloat, bottom: CGFloat, height: CGFloat, intensity: CGFloat, tint: UIColor, turn: TimeInterval) -> SCNNode {
        let cone = SCNCone(topRadius: top, bottomRadius: bottom, height: height)
        cone.radialSegmentCount = 48
        let invisible = SCNMaterial()
        invisible.transparency = 0
        invisible.writesToDepthBuffer = false
        cone.materials = [ChestScene.decal(ChestTextures.shared.beam, add: true, intensity: intensity, tint: tint), invisible, invisible]
        let node = SCNNode(geometry: cone)
        node.runAction(.repeatForever(.rotateBy(x: 0, y: (turn > 0 ? 1 : -1) * .pi * 2, z: 0, duration: abs(turn))))
        return node
    }

    // MARK: Playing

    private func play() {
        let tier = tier
        chestRoot.position.y = 1.1
        chestRoot.opacity = 0

        // 1. Drop in and land (0 – 0.55 s)
        chestRoot.runAction(.sequence([
            .wait(duration: 0.05),
            .group([
                .fadeIn(duration: 0.12),
                .move(to: SCNVector3(0, 0, 0), duration: 0.32).timed(Ease.inQuad)
            ]),
            .moveBy(x: 0, y: 0.03, z: 0, duration: 0.08).timed(Ease.outQuad),
            .moveBy(x: 0, y: -0.03, z: 0, duration: 0.08).timed(Ease.inQuad)
        ]))
        event(at: 0.37) { [weak self] in
            guard let self else { return }
            self.haptics.impact(.medium, 0.9)
            self.puffDust(at: SCNVector3(0, 0.01, 0), spread: SCNVector3(Float(Dim.width) + 0.1, 0.01, Float(Dim.depth) + 0.1), amount: 1)
        }

        // Timeline, stretched by the knocks and the charge of each rarity
        let strain = 0.65
        let knockGap = 0.25
        let knocksEnd = strain + Double(tier.knocks.count - 1) * knockGap + 0.15
        let chargeStart = knocksEnd + 0.05
        let unlock = chargeStart + tier.charge + 0.1
        let fall = unlock + 0.12
        let open = unlock + 0.27
        let done = open + (tier.level >= 3 ? 1.15 : 0.95)

        // Slowly closing in, a little more once it opens; then the chest moves up
        cameraNode.runAction(.sequence([
            Self.zoom(from: Self.zoomStart, to: Self.zoomMid, duration: open + 0.3),
            Self.zoom(from: Self.zoomMid, to: Self.zoomEnd, duration: 1.3)
        ]))
        cameraRig.runAction(.sequence([
            .wait(duration: open - 0.1),
            .move(to: Self.targetEnd, duration: 1.7).timed(Ease.inOut)
        ]))

        // 2. The lid strains against the padlock
        var lidKnocks: [SCNAction] = [.wait(duration: strain)]
        for (index, lift) in tier.knocks.enumerated() {
            if index > 0 { lidKnocks.append(.wait(duration: knockGap - 0.15)) }
            lidKnocks.append(Self.lidKnock(lift: lift))
            let side: CGFloat = index.isMultiple(of: 2) ? 1 : -1
            let rock = 0.018 * side * lift / 0.07
            let time = strain + Double(index) * knockGap
            chestRoot.runAction(.sequence([
                .wait(duration: time),
                .rotateBy(x: 0, y: 0, z: rock, duration: 0.07).timed(Ease.outQuad),
                .rotateBy(x: 0, y: 0, z: -rock, duration: 0.12).timed(Ease.inOut)
            ]))
            event(at: time + 0.15) { [weak self] in self?.haptics.impact(.rigid, min(1, lift * 9)) }
        }
        lidPivot.runAction(.sequence(lidKnocks))
        // The padlock swings on the hasp
        let swing = 1 + 0.25 * CGFloat(tier.level)
        padlock.runAction(.sequence([
            .wait(duration: strain + 0.08),
            .sequence([0.22, -0.17, 0.12, -0.08, 0.04, 0].map { angle in
                SCNAction.rotateTo(x: 0, y: 0, z: CGFloat(angle) * swing, duration: 0.11).timed(Ease.inOut)
            })
        ]))

        // 3. Charge (rare and up): it trembles, light leaks from the seam, it rumbles
        if tier.charge > 0 {
            playCharge(from: chargeStart, duration: tier.charge, unlock: unlock)
        }

        // 4. The padlock gives way with a jolt and falls to the floor
        event(at: unlock) { [weak self] in self?.haptics.impact(.rigid, 1) }
        let hang = art.padlockHang
        let landing = art.padlockRest
        padlock.runAction(.sequence([
            .wait(duration: unlock),
            .move(to: SCNVector3(hang.x, hang.y + 0.025, hang.z + 0.01), duration: 0.07).timed(Ease.outQuad),
            .wait(duration: fall - unlock - 0.07),
            .group([
                .move(to: landing, duration: 0.3).timed(Ease.inQuad),
                .rotateTo(x: -CGFloat(Dim.padlockTilt), y: 0, z: 0.12, duration: 0.3).timed(Ease.inQuad)
            ]),
            .group([
                .moveBy(x: 0, y: 0.022, z: 0.02, duration: 0.07).timed(Ease.outQuad),
                .rotateBy(x: 0.18, y: 0, z: 0, duration: 0.07)
            ]),
            .group([
                .moveBy(x: 0, y: -0.022, z: 0.008, duration: 0.07).timed(Ease.inQuad),
                .rotateBy(x: -0.18, y: 0, z: 0, duration: 0.07)
            ])
        ]))
        event(at: fall + 0.3) { [weak self] in
            guard let self else { return }
            self.haptics.impact(.light, 0.8)
            self.puffDust(at: landing, spread: SCNVector3(0.18, 0.01, 0.22), amount: 0.35)
        }

        // 5. The lid swings open (faster the rarer), falls back past vertical, hits its stop, settles
        let swingOpen = 0.42 - 0.045 * Double(tier.level)
        lidPivot.runAction(.sequence([
            .wait(duration: open),
            .rotateTo(x: -1.05, y: 0, z: 0, duration: swingOpen).timed(Ease.outCubic),
            .rotateTo(x: -1.96, y: 0, z: 0, duration: 0.3).timed(Ease.inQuad),
            .rotateTo(x: -1.76, y: 0, z: 0, duration: 0.12).timed(Ease.outQuad),
            .rotateTo(x: CGFloat(Dim.openAngle), y: 0, z: 0, duration: 0.15).timed(Ease.inQuad)
        ]))
        let hitStop = open + swingOpen + 0.3
        chestRoot.runAction(.sequence([
            .wait(duration: hitStop),
            .rotateBy(x: -0.02, y: 0, z: 0, duration: 0.06).timed(Ease.outQuad),
            .rotateBy(x: 0.02, y: 0, z: 0, duration: 0.14).timed(Ease.inOut)
        ]))
        event(at: hitStop) { [weak self] in self?.haptics.impact(.medium, 0.75) }
        event(at: hitStop + 0.27) { [weak self] in self?.haptics.impact(.light, 0.4) }

        // 6. Light pours out, more the rarer
        seam.runAction(.sequence([.wait(duration: open + 0.15), .fadeOut(duration: 0.4)]))
        seamLight.runAction(.sequence([.wait(duration: open + 0.1), Self.lightRamp(to: 0, from: 500 * tier.seamGlow, duration: 0.4)]))
        if tier.flash {
            innerLight.runAction(.sequence([
                .wait(duration: open + 0.02),
                Self.lightRamp(to: tier.lightIntensity * 2.2, from: 0, duration: 0.15),
                Self.lightRamp(to: tier.lightIntensity, from: tier.lightIntensity * 2.2, duration: 0.8)
            ]))
        } else {
            innerLight.runAction(.sequence([.wait(duration: open + 0.05), Self.lightRamp(to: tier.lightIntensity, from: 0, duration: 0.7)]))
        }
        glow.runAction(.sequence([.wait(duration: open + 0.1), .fadeOpacity(to: 0.85, duration: 0.6)]))
        beam.runAction(.sequence([.wait(duration: open + 0.2), .fadeOpacity(to: tier.beamOpacity, duration: 0.8).timed(Ease.outQuad)]))
        event(at: open + 0.22) { [weak self] in self?.burstSparks() }
        event(at: open + 0.3) { [weak self] in self?.startMotes() }

        if tier.level >= 2 {
            // The burst: a heavy hit, then the rumble dies down
            event(at: open + 0.05) { [weak self] in
                guard let self else { return }
                self.haptics.impact(.heavy, 1)
                self.haptics.rumble(duration: 0.5 + 0.4 * Double(tier.level - 2), from: tier.rumble, to: 0, sharpness: 0.5)
            }
        }
        for (index, ring) in rings.enumerated() {
            let start = open + 0.08 + 0.18 * Double(index)
            ring.scale = SCNVector3(0.4, 0.4, 0.4)
            ring.runAction(.sequence([
                .wait(duration: start),
                .group([
                    .fadeOpacity(to: 1, duration: 0.04),
                    .scale(to: 3.8 + 1.2 * CGFloat(index), duration: 0.75).timed(Ease.outCubic),
                    .sequence([.wait(duration: 0.15), .fadeOut(duration: 0.6)])
                ])
            ]))
            if index > 0 {
                event(at: start) { [weak self] in self?.haptics.impact(.heavy, 0.8) }
            }
        }
        if tier.flash {
            flashNode.scale = SCNVector3(0.2, 0.2, 0.2)
            flashNode.runAction(.sequence([
                .wait(duration: open + 0.02),
                .group([
                    .fadeOpacity(to: 1, duration: 0.05),
                    .scale(to: 6, duration: 0.5).timed(Ease.outCubic),
                    .sequence([.wait(duration: 0.08), .fadeOut(duration: 0.42).timed(Ease.outQuad)])
                ])
            ]))
        }
        if tier.shake > 0 {
            cameraShake.runAction(.sequence([.wait(duration: open + 0.04), Self.shake(tier.shake, steps: 6 + 3 * tier.level)]))
        }

        // 7. Done
        event(at: done) { [weak self] in
            guard let self else { return }
            if tier.level >= 1 { self.haptics.success() }
            self.finish()
        }
    }

    /// Trembling that grows, light leaking around the seam, a rumble; the legendary chest also
    /// levitates and slams back down when the padlock gives way.
    private func playCharge(from start: TimeInterval, duration: TimeInterval, unlock: TimeInterval) {
        let tier = tier
        let steps = max(2, Int(duration / 0.05))
        var tremble: [SCNAction] = [.wait(duration: start)]
        for step in 0..<steps {
            let amount = CGFloat(0.003 + 0.004 * Double(tier.level) * Double(step) / Double(steps))
            tremble.append(.rotateBy(x: 0, y: 0, z: amount, duration: 0.025))
            tremble.append(.rotateBy(x: 0, y: 0, z: -amount, duration: 0.025))
        }
        chestRoot.runAction(.sequence(tremble))

        seam.runAction(.sequence([.wait(duration: start), Self.seamPulse(tier.seamGlow, duration: duration)]))
        seamLight.runAction(.sequence([.wait(duration: start), Self.lightRamp(to: 500 * tier.seamGlow, from: 0, duration: duration)]))
        if !glowing.isEmpty {
            events.runAction(.sequence([.wait(duration: start), Self.crystalRamp(glowing, duration: duration)]))
        }

        event(at: start) { [weak self] in
            self?.haptics.rumble(duration: duration, from: 0.15, to: tier.rumble, sharpness: 0.3)
        }

        if tier.levitates {
            let rise: CGFloat = 0.08
            chestRoot.runAction(.sequence([
                .wait(duration: start),
                .moveBy(x: 0, y: rise, z: 0, duration: duration * 0.85).timed(Ease.inOut),
                .wait(duration: unlock - start - duration * 0.85 - 0.1),
                .moveBy(x: 0, y: -rise, z: 0, duration: 0.1).timed(Ease.inQuad)
            ]))
            event(at: unlock) { [weak self] in
                guard let self else { return }
                self.haptics.impact(.heavy, 1)
                self.puffDust(at: SCNVector3(0, 0.01, 0), spread: SCNVector3(Float(Dim.width) + 0.15, 0.01, Float(Dim.depth) + 0.15), amount: 1.3)
            }
            cameraShake.runAction(.sequence([.wait(duration: unlock), Self.shake(0.02, steps: 5)]))
        }
    }

    /// Reduce Motion: the chest is already in place; the padlock fades and the lid opens.
    private func playCalm() {
        cameraRig.position = Self.targetEnd
        cameraNode.camera?.orthographicScale = Self.zoomEnd
        padlock.runAction(.sequence([.wait(duration: 0.2), .fadeOut(duration: 0.25)]))
        lidPivot.runAction(.sequence([
            .wait(duration: 0.4),
            .rotateTo(x: CGFloat(Dim.openAngle), y: 0, z: 0, duration: 0.8).timed(Ease.inOut)
        ]))
        innerLight.runAction(.sequence([.wait(duration: 0.5), Self.lightRamp(to: tier.lightIntensity, from: 0, duration: 0.6)]))
        glow.runAction(.sequence([.wait(duration: 0.5), .fadeOpacity(to: 0.85, duration: 0.6)]))
        beam.runAction(.sequence([.wait(duration: 0.6), .fadeOpacity(to: tier.beamOpacity, duration: 0.6)]))
        let level = tier.level
        event(at: 1.3) { [weak self] in
            guard let self else { return }
            if level >= 1 { self.haptics.success() }
            self.finish()
        }
    }

    /// Jumps to the open chest.
    func skip() {
        guard built, !finished else { return }
        var nodes = [events, chestRoot, lidPivot, padlock, innerLight, seamLight, seam, glow, beam, flashNode, cameraRig, cameraShake, cameraNode]
        nodes.append(contentsOf: rings)
        for node in nodes {
            node.removeAllActions()
        }
        haptics.stopRumble()
        SCNTransaction.begin()
        SCNTransaction.animationDuration = 0
        chestRoot.position = SCNVector3(0, 0, 0)
        chestRoot.eulerAngles = SCNVector3(0, 0, 0)
        chestRoot.opacity = 1
        lidPivot.eulerAngles = SCNVector3(Dim.openAngle, 0, 0)
        padlock.position = art.padlockRest
        padlock.eulerAngles = SCNVector3(-Dim.padlockTilt, 0, 0.12)
        padlock.opacity = calm ? 0 : 1
        innerLight.light?.intensity = tier.lightIntensity
        seamLight.light?.intensity = 0
        seam.opacity = 0
        glow.opacity = 0.85
        beam.opacity = tier.beamOpacity
        flashNode.opacity = 0
        for ring in rings { ring.opacity = 0 }
        for material in glowing { material.emission.intensity = Dim.crystalGlowEnd }
        cameraRig.position = Self.targetEnd
        cameraShake.position = SCNVector3(0, 0, 0)
        cameraNode.camera?.orthographicScale = Self.zoomEnd
        SCNTransaction.commit()
        startMotes()
        if tier.level >= 1 { haptics.success() }
        finish()
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        onOpened?()
    }

    // MARK: Helpers

    /// Runs `block` on the main thread at `time` seconds into the animation.
    private func event(at time: TimeInterval, _ block: @escaping () -> Void) {
        events.runAction(.sequence([.wait(duration: time), Self.onMainThread(block)]))
    }

    /// An action (run on the render thread) that calls `block` on the main thread.
    nonisolated private static func onMainThread(_ block: @escaping () -> Void) -> SCNAction {
        .run { _ in DispatchQueue.main.async(execute: block) }
    }

    nonisolated private static func lidKnock(lift: CGFloat) -> SCNAction {
        .sequence([
            .rotateTo(x: -lift, y: 0, z: 0, duration: 0.07).timed(Ease.outQuad),
            .rotateTo(x: 0, y: 0, z: 0, duration: 0.08).timed(Ease.inQuad)
        ])
    }

    /// The camera closing in (half the width of the view, in scene units).
    nonisolated private static func zoom(from start: Double, to target: Double, duration: TimeInterval) -> SCNAction {
        .customAction(duration: duration) { node, elapsed in
            let progress = Float(min(1, elapsed / CGFloat(duration)))
            node.camera?.orthographicScale = start + (target - start) * Double(Ease.inOut(progress))
        }
    }

    nonisolated private static func lightRamp(to target: CGFloat, from start: CGFloat, duration: TimeInterval) -> SCNAction {
        .customAction(duration: duration) { node, elapsed in
            let progress = Float(min(1, elapsed / CGFloat(duration)))
            node.light?.intensity = start + (target - start) * CGFloat(Ease.outCubic(progress))
        }
    }

    /// The seam's light flickering brighter while it charges.
    nonisolated private static func seamPulse(_ amount: CGFloat, duration: TimeInterval) -> SCNAction {
        .customAction(duration: duration) { node, elapsed in
            let progress = Double(elapsed) / duration
            node.opacity = amount * CGFloat(progress * (0.75 + 0.25 * sin(Double(elapsed) * 28)))
        }
    }

    /// The crystal glowing brighter while it charges.
    nonisolated private static func crystalRamp(_ materials: [SCNMaterial], duration: TimeInterval) -> SCNAction {
        .customAction(duration: duration) { _, elapsed in
            let progress = min(1, CGFloat(elapsed) / CGFloat(duration))
            for material in materials {
                material.emission.intensity = Dim.crystalGlowStart + (Dim.crystalGlowEnd - Dim.crystalGlowStart) * progress
            }
        }
    }

    /// Camera shake that dies down (the camera moves inside its rig).
    nonisolated private static func shake(_ amount: Float, steps: Int) -> SCNAction {
        var random = SeededRandom(seed: UInt64(steps) &* 31)
        var actions: [SCNAction] = []
        for step in 0..<steps {
            let decay = amount * (1 - Float(step) / Float(steps))
            let offset = SCNVector3(
                random.next(in: -decay...decay),
                random.next(in: -decay...decay),
                random.next(in: -decay * 0.5...decay * 0.5)
            )
            actions.append(.move(to: offset, duration: 0.035))
        }
        actions.append(.move(to: SCNVector3(0, 0, 0), duration: 0.06))
        return .sequence(actions)
    }

    private func puffDust(at position: SCNVector3, spread: SCNVector3, amount: CGFloat) {
        let node = SCNNode()
        node.position = position
        scene.rootNode.addChildNode(node)
        node.addParticleSystem(ChestParticles.dust(spread: spread, amount: amount))
        node.runAction(.sequence([.wait(duration: 2), .removeFromParentNode()]))
    }

    private func burstSparks() {
        motes.addParticleSystem(ChestParticles.sparks(tier))
    }

    private func startMotes() {
        guard !motesStarted else { return }
        motesStarted = true
        motes.addParticleSystem(ChestParticles.motes(tier))
        if tier.flames {
            motes.addParticleSystem(ChestParticles.flames(tier))
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

    func impact(_ style: Style, _ intensity: CGFloat) {
        let generator: UIImpactFeedbackGenerator
        switch style {
        case .light: generator = light
        case .medium: generator = medium
        case .rigid: generator = rigid
        case .heavy: generator = heavy
        }
        generator.impactOccurred(intensity: intensity)
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

// MARK: - Easing

private enum Ease {
    static let inQuad: (Float) -> Float = { $0 * $0 }
    static let outQuad: (Float) -> Float = { 1 - (1 - $0) * (1 - $0) }
    static let outCubic: (Float) -> Float = { 1 - pow(1 - $0, 3) }
    static let inOut: (Float) -> Float = { $0 * $0 * (3 - 2 * $0) }
}

private extension SCNAction {
    func timed(_ function: @escaping (Float) -> Float) -> SCNAction {
        timingFunction = function
        return self
    }
}

// MARK: - Scene pieces

private enum ChestScene {
    static let background = UIColor(red: 0.06, green: 0.048, blue: 0.042, alpha: 1)

    /// Studio lighting for the treasure: a warm key light, a cool fill and a warm rim. The inside of
    /// the chest and of the lid (`ChestBuilder.insideCategory`) is lit only by a dim ambient light
    /// and the light coming from the treasure, so it's dark until the chest opens. (The picture
    /// painted on the outside isn't lit at all: it's shown as drawn.)
    static func addLights(to root: SCNNode) {
        let key = SCNLight()
        key.type = .directional
        key.color = UIColor(red: 1, green: 0.93, blue: 0.84, alpha: 1)
        key.intensity = 1100
        key.categoryBitMask = 1
        root.addChildNode(lightNode(key, at: SCNVector3(-2.2, 4.5, 3.0)))

        let ambient = SCNLight()
        ambient.type = .ambient
        ambient.color = UIColor(red: 1, green: 0.88, blue: 0.75, alpha: 1)
        ambient.intensity = 260
        ambient.categoryBitMask = ChestBuilder.insideCategory
        let ambientNode = SCNNode()
        ambientNode.light = ambient
        root.addChildNode(ambientNode)

        let fill = SCNLight()
        fill.type = .directional
        fill.color = UIColor(red: 0.62, green: 0.72, blue: 1, alpha: 1)
        fill.intensity = 320
        fill.categoryBitMask = 1
        root.addChildNode(lightNode(fill, at: SCNVector3(3.2, 1.4, 2.0)))

        let rim = SCNLight()
        rim.type = .directional
        rim.color = UIColor(red: 1, green: 0.84, blue: 0.68, alpha: 1)
        rim.intensity = 900
        rim.categoryBitMask = 1
        root.addChildNode(lightNode(rim, at: SCNVector3(0.6, 3.0, -3.6)))
    }

    /// An omni light that starts off.
    static func omni(color: UIColor, reach: CGFloat) -> SCNLight {
        let light = SCNLight()
        light.type = .omni
        light.color = color
        light.intensity = 0
        light.attenuationStartDistance = 0
        light.attenuationEndDistance = reach
        light.attenuationFalloffExponent = 2
        return light
    }

    private static func lightNode(_ light: SCNLight, at position: SCNVector3) -> SCNNode {
        let node = SCNNode()
        node.light = light
        node.position = position
        node.look(at: SCNVector3(0, 0.3, 0))
        return node
    }

    /// Unlit, see-through material for glows (added as light, tinted) and decals.
    static func decal(_ image: UIImage, add: Bool, intensity: CGFloat = 1, tint: UIColor? = nil, readsDepth: Bool = true) -> SCNMaterial {
        let material = SCNMaterial()
        material.lightingModel = .constant
        material.diffuse.contents = image
        material.diffuse.intensity = intensity
        if let tint { material.multiply.contents = tint }
        material.isDoubleSided = true
        material.writesToDepthBuffer = false
        material.readsFromDepthBuffer = readsDepth
        material.blendMode = add ? .add : .alpha
        return material
    }
}

// MARK: - Artwork

/// A chest's illustration and the view it's drawn from.
///
/// The pictures are drawn as if seen from a little above and to the right: an orthographic view
/// turned 25.8° around the chest and looking down 7.8°, at 306.7 px per scene unit. With the
/// chest's size in `Dim`, every point of the chest at rest lands on the pixel of the picture that
/// shows it, so painting the picture onto the model from that viewpoint (camera projection
/// mapping) makes the chest at rest look exactly like the picture, and when the lid swings open
/// the picture swings with it. The camera looks from that same direction.
///
/// The pictures are cut into the pieces that move separately by scripts/maintenance/split-chests.py.
private struct ChestArt {
    static let canvas: Float = 420
    static let pixelsPerUnit: Float = 306.7
    static let yaw: Float = 25.8 * .pi / 180
    static let pitch: Float = 7.8 * .pi / 180
    /// The view's axes in the scene: to the right, up, and towards the viewer.
    static let right = SIMD3<Float>(cos(yaw), 0, -sin(yaw))
    static let up = SIMD3<Float>(-sin(pitch) * sin(yaw), cos(pitch), -sin(pitch) * cos(yaw))
    static let toViewer = SIMD3<Float>(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch))

    let name: String
    /// Pixel of the scene origin (the floor under the middle of the chest).
    let origin: SIMD2<Float>
    /// Pixels: the top of the lid (diamond included), the hasp and the padlock.
    let lidTop: Float
    let hasp: CGRect
    let lock: CGRect
    /// The metal of the bands, for the rims the picture doesn't show.
    let band: UIColor

    init(_ rarity: String) {
        let frontLeft: SIMD2<Float>
        switch rarity {
        case "rare":
            name = "chest_rare"
            frontLeft = SIMD2(30, 171); lidTop = 79
            hasp = CGRect(x: 120, y: 162, width: 81, height: 33)
            lock = CGRect(x: 107, y: 186, width: 99, height: 126)
            band = UIColor(red: 0.56, green: 0.58, blue: 0.66, alpha: 1)
        case "epic":
            name = "chest_epic"
            frontLeft = SIMD2(30, 172); lidTop = 79
            hasp = CGRect(x: 123, y: 165, width: 79, height: 32)
            lock = CGRect(x: 111, y: 188, width: 97, height: 128)
            band = UIColor(red: 0.86, green: 0.67, blue: 0.14, alpha: 1)
        case "legendary":
            name = "chest_legendary"
            frontLeft = SIMD2(34, 179); lidTop = 76
            hasp = CGRect(x: 126, y: 170, width: 76, height: 28)
            lock = CGRect(x: 114, y: 192, width: 97, height: 126)
            band = UIColor(red: 0.64, green: 0.67, blue: 0.75, alpha: 1)
        default:
            name = "chest_common"
            frontLeft = SIMD2(32, 172); lidTop = 77
            hasp = CGRect(x: 123, y: 162, width: 79, height: 35)
            lock = CGRect(x: 111, y: 189, width: 97, height: 126)
            band = UIColor(red: 0.64, green: 0.31, blue: 0.13, alpha: 1)
        }
        // The front-left corner of the top of the body is where the picture says it is
        let corner = SIMD3<Float>(-Float(Dim.width) / 2, Float(Dim.height), Float(Dim.depth) / 2)
        origin = frontLeft - Self.offset(corner)
    }

    var lid: String { name + "_lid" }
    var base: String { name + "_base" }
    var padlock: String { name + "_lock" }
    var wood: String { name + "_wood" }
    static func layers(_ rarity: String) -> [String] {
        let art = ChestArt(rarity)
        return [art.lid, art.base, art.padlock, art.wood]
    }

    private static func offset(_ point: SIMD3<Float>) -> SIMD2<Float> {
        SIMD2(pixelsPerUnit * simd_dot(right, point), -pixelsPerUnit * simd_dot(up, point))
    }

    /// The pixel of the picture that shows a point of the chest at rest.
    func pixel(_ point: SIMD3<Float>) -> SIMD2<Float> {
        origin + Self.offset(point)
    }

    /// Texture coordinate of a point of the chest at rest.
    func uv(_ point: SIMD3<Float>) -> SIMD2<Float> {
        pixel(point) / Self.canvas
    }

    /// The point on the plane z = `z` (facing the front) that the picture shows at `pixel`.
    func point(at pixel: CGPoint, z: Float) -> SIMD3<Float> {
        let px = Float(pixel.x) - origin.x, py = Float(pixel.y) - origin.y
        let x = (px / Self.pixelsPerUnit - Self.right.z * z) / Self.right.x
        let y = (-py / Self.pixelsPerUnit - Self.up.x * x - Self.up.z * z) / Self.up.y
        return SIMD3(x, y, z)
    }

    /// Height of the domed lid above the body, so its top reaches the top of the picture.
    var lidHeight: Float {
        (origin.y - (lidTop - 2)) / (Self.pixelsPerUnit * Self.up.y) - Float(Dim.height)
    }

    /// Where the padlock hangs from (the top of its shackle) and where it ends up on the floor.
    var padlockZ: Float { Float(Dim.depth) / 2 + 0.035 }
    var padlockHang: SCNVector3 {
        SCNVector3(point(at: CGPoint(x: lock.midX, y: lock.minY + 4), z: padlockZ))
    }
    /// How far the padlock reaches below where it hangs.
    var padlockLength: Float {
        simd_length(point(at: CGPoint(x: lock.midX, y: lock.maxY), z: padlockZ) - point(at: CGPoint(x: lock.midX, y: lock.minY + 4), z: padlockZ))
    }
    /// Lying on the floor, tilted back on its shackle (`Dim.padlockTilt`), in front of the chest.
    var padlockRest: SCNVector3 {
        let hang = padlockHang
        return SCNVector3(hang.x + 0.02, padlockLength * cos(Dim.padlockTilt) + 0.012, hang.z + 0.06)
    }
}

/// Builds geometry from a parametric surface.
private enum Mesh {
    /// The surface through `point(u, v)` for u and v in 0...1, as a grid of `columns` × `rows`
    /// quads. Its faces point along ∂u × ∂v (the other way with `flipped`); `texture` gives the
    /// texture coordinate of each point; `offset` is taken off the points (where the node is).
    static func surface(
        columns: Int,
        rows: Int,
        flipped: Bool = false,
        offset: SIMD3<Float> = .zero,
        point: (Float, Float) -> SIMD3<Float>,
        texture: (Float, Float, SIMD3<Float>) -> SIMD2<Float>
    ) -> SCNGeometry {
        var positions: [SCNVector3] = []
        var normals: [SCNVector3] = []
        var coordinates: [CGPoint] = []
        var indices: [UInt32] = []
        let step: Float = 0.002
        for column in 0...columns {
            for row in 0...rows {
                let u = Float(column) / Float(columns), v = Float(row) / Float(rows)
                let p = point(u, v)
                // At the tip of a fan there's no normal: take it a little way out
                var n = SIMD3<Float>(0, 0, 1)
                for probe in [u, max(u, 0.02)] {
                    let du = point(min(1, probe + step), v) - point(max(0, probe - step), v)
                    let dv = point(probe, min(1, v + step)) - point(probe, max(0, v - step))
                    let cross = simd_cross(du, dv)
                    if simd_length(cross) > 1e-9 {
                        n = cross
                        break
                    }
                }
                n = simd_normalize(n) * (flipped ? -1 : 1)
                positions.append(SCNVector3(p - offset))
                normals.append(SCNVector3(n))
                let t = texture(u, v, p)
                coordinates.append(CGPoint(x: CGFloat(t.x), y: CGFloat(t.y)))
            }
        }
        for column in 0..<columns {
            for row in 0..<rows {
                let a = UInt32(column * (rows + 1) + row)
                let b = UInt32((column + 1) * (rows + 1) + row)
                if flipped {
                    indices += [a, a + 1, b, a + 1, b + 1, b]
                } else {
                    indices += [a, b, a + 1, a + 1, b, b + 1]
                }
            }
        }
        let sources = [
            SCNGeometrySource(vertices: positions),
            SCNGeometrySource(normals: normals),
            SCNGeometrySource(textureCoordinates: coordinates)
        ]
        return SCNGeometry(sources: sources, elements: [SCNGeometryElement(indices: indices, primitiveType: .triangles)])
    }
}

// MARK: - Model

/// Builds the chest of a tier: the body and the lid with the picture painted on them, the inside
/// (which the picture doesn't show) in the chest's own planks, the padlock and the treasure.
private struct ChestBuilder {
    let tier: ChestTier
    let art: ChestArt
    let materials: ChestMaterials
    /// Materials that glow as the chest charges.
    private(set) var glowing: [SCNMaterial] = []

    init(tier: ChestTier, art: ChestArt) {
        self.tier = tier
        self.art = art
        materials = ChestMaterials(tier, art: art)
    }

    /// Category of the inside of the chest and of the lid, lit only by the light inside.
    static let insideCategory = 2

    /// A node with the picture painted on.
    private func pictured(_ name: String, shade: CGFloat = 1, _ build: (_ texture: (Float, Float, SIMD3<Float>) -> SIMD2<Float>) -> SCNGeometry) -> SCNNode {
        let art = art
        let geometry = build { _, _, point in art.uv(point) }
        geometry.materials = [ChestMaterials.picture(name, shade: shade)]
        return SCNNode(geometry: geometry)
    }

    /// A node in the chest's planks (or the rims' metal), lit by the light inside.
    private func inside(_ material: SCNMaterial, _ geometry: SCNGeometry) -> SCNNode {
        geometry.materials = [material]
        let node = SCNNode(geometry: geometry)
        node.categoryBitMask = Self.insideCategory
        return node
    }

    /// Planks repeating every so many scene units along u and v.
    private static func planks(_ lengthU: Float, _ lengthV: Float) -> (Float, Float, SIMD3<Float>) -> SIMD2<Float> {
        // One copy of the texture covers about 0.39 x 0.16 units, as on the lid
        { u, v, _ in SIMD2(u * lengthU / 0.39, v * lengthV / 0.16) }
    }

    func buildBase(into parent: SCNNode) {
        let width = Float(Dim.width), height = Float(Dim.height), depth = Float(Dim.depth), wall = Float(Dim.plank)
        // Front and right end, a little larger than the box so they take every pixel of the body
        // (the corner brackets and bands stick out); the picture is see-through beyond it.
        let margin: Float = 0.06, bottom: Float = -0.06, top = height + 0.035
        parent.addChildNode(pictured(art.base) { texture in
            Mesh.surface(columns: 8, rows: 8, point: { u, v in
                SIMD3(-width / 2 - margin + (width + margin) * u, bottom + (top - bottom) * v, depth / 2)
            }, texture: texture)
        })
        parent.addChildNode(pictured(art.base) { texture in
            Mesh.surface(columns: 8, rows: 8, point: { u, v in
                SIMD3(width / 2, bottom + (top - bottom) * v, depth / 2 - (depth + margin) * u)
            }, texture: texture)
        })

        // Inside: the back and left walls, the floor and the tops of the walls
        let ix = width / 2 - wall, iz = depth / 2 - wall, floor: Float = 0.04
        parent.addChildNode(inside(materials.wood, Mesh.surface(columns: 4, rows: 4, point: { u, v in
            SIMD3(-ix + 2 * ix * u, floor + (height - floor) * v, -iz)
        }, texture: Self.planks(2 * ix, height - floor))))
        parent.addChildNode(inside(materials.wood, Mesh.surface(columns: 4, rows: 4, point: { u, v in
            SIMD3(-ix, floor + (height - floor) * v, iz - 2 * iz * u)
        }, texture: Self.planks(2 * iz, height - floor))))
        parent.addChildNode(inside(materials.woodDark, Mesh.surface(columns: 4, rows: 4, point: { u, v in
            SIMD3(-ix + 2 * ix * u, floor, iz - 2 * iz * v)
        }, texture: Self.planks(2 * ix, 2 * iz))))
        let rims: [(Float, Float, Float, Float)] = [
            (-width / 2, width / 2, iz, depth / 2),
            (-width / 2, width / 2, -depth / 2, -iz),
            (-width / 2, -ix, -iz, iz),
            (ix, width / 2, -iz, iz)
        ]
        for (x0, x1, z0, z1) in rims {
            parent.addChildNode(inside(materials.rim, Mesh.surface(columns: 1, rows: 1, point: { u, v in
                SIMD3(x0 + (x1 - x0) * u, height, z1 - (z1 - z0) * v)
            }, texture: { u, v, _ in SIMD2(u, v) })))
        }
    }

    /// The treasure inside: a heap of coins, with silver coins, gems or crystals the rarer it is.
    mutating func buildTreasure(into parent: SCNNode) {
        let heap = SCNSphere(radius: 1)
        heap.segmentCount = 32
        heap.materials = [materials.heap]
        let heapNode = SCNNode(geometry: heap)
        let heapSize = SCNVector3(0.42, 0.19, 0.24)
        heapNode.scale = heapSize
        heapNode.position.y = 0.07
        parent.addChildNode(heapNode)

        var random = SeededRandom(seed: 21)
        let halfX = Float(Dim.width / 2 - Dim.plank) - 0.04
        let halfZ = Float(Dim.depth / 2 - Dim.plank) - 0.04
        /// A random spot on the heap (or the floor around it) and the height there.
        func spot(_ random: inout SeededRandom) -> SCNVector3 {
            let x = random.next(in: -halfX...halfX)
            let z = random.next(in: -halfZ...halfZ)
            let inside = 1 - pow(x / heapSize.x, 2) - pow(z / heapSize.z, 2)
            return SCNVector3(x, 0.07 + heapSize.y * sqrt(max(0, inside)) + 0.004, z)
        }

        let gold = SCNCylinder(radius: 0.034, height: 0.008)
        gold.radialSegmentCount = 28
        gold.materials = [materials.gold]
        let silver = gold.copy() as? SCNCylinder ?? gold
        silver.materials = [materials.silver]
        for index in 0..<60 {
            let node = SCNNode(geometry: tier.treasure == .silverAndGold && index.isMultiple(of: 2) ? silver : gold)
            node.position = spot(&random)
            node.eulerAngles = SCNVector3(random.next(in: -0.4...0.4), random.next(in: 0...3), random.next(in: -0.4...0.4))
            parent.addChildNode(node)
        }

        switch tier.treasure {
        case .gems:
            // Low-poly spheres read as cut gems
            let colors = [
                UIColor(red: 0.9, green: 0.1, blue: 0.2, alpha: 1),
                UIColor(red: 0.1, green: 0.75, blue: 0.35, alpha: 1),
                UIColor(red: 0.6, green: 0.25, blue: 0.95, alpha: 1),
                UIColor(red: 0.15, green: 0.45, blue: 1, alpha: 1)
            ]
            for index in 0..<14 {
                let gem = SCNSphere(radius: CGFloat(random.next(in: 0.024...0.036)))
                gem.segmentCount = 6
                gem.materials = [ChestMaterials.gem(colors[index % colors.count])]
                let node = SCNNode(geometry: gem)
                node.position = spot(&random)
                node.position.y += 0.01
                node.eulerAngles = SCNVector3(random.next(in: 0...3), random.next(in: 0...3), 0)
                parent.addChildNode(node)
            }
        case .crystals:
            // Hexagonal crystal shards sticking out of the coins
            let crystal = materials.crystal(&random)
            glowing.append(crystal)
            for _ in 0..<11 {
                let length = CGFloat(random.next(in: 0.09...0.17))
                let radius = CGFloat(random.next(in: 0.018...0.03))
                let shard = SCNNode()
                let prism = SCNCylinder(radius: radius, height: length)
                prism.radialSegmentCount = 6
                prism.materials = [crystal]
                shard.addChildNode(SCNNode(geometry: prism))
                let tip = SCNCone(topRadius: 0, bottomRadius: radius, height: radius * 1.6)
                tip.radialSegmentCount = 6
                tip.materials = [crystal]
                let tipNode = SCNNode(geometry: tip)
                tipNode.position.y = Float(length / 2 + radius * 0.8)
                shard.addChildNode(tipNode)
                shard.position = spot(&random)
                shard.eulerAngles = SCNVector3(random.next(in: -0.6...0.6), random.next(in: 0...3), random.next(in: -0.6...0.6))
                parent.addChildNode(shard)
            }
        case .coins, .silverAndGold:
            break
        }
    }

    /// The domed lid. `pivot` sits on the back hinge; the lid's node, in the middle of the top of the
    /// body, half a depth in front of it.
    func buildLid(into pivot: SCNNode) {
        let lid = SCNNode()
        lid.position = SCNVector3(0, 0, Float(Dim.depth / 2))
        pivot.addChildNode(lid)
        // Points are built where they are on the chest at rest (so they take the right pixels) and
        // stored relative to the lid's node.
        let at = SIMD3<Float>(0, Float(Dim.height), 0)
        let height = Float(Dim.height)
        // A little larger than the body: the bands on the ends stick out
        let halfWidth = Float(Dim.width) / 2 + 0.012
        let radiusZ = Float(Dim.depth) / 2 + 0.004
        let radiusY = art.lidHeight
        let thickness: Float = 0.035

        // Outside: the dome and its right end (the left end never faces the camera)
        lid.addChildNode(pictured(art.lid) { texture in
            Mesh.surface(columns: 24, rows: 32, offset: at, point: { u, v in
                let angle = Float.pi * v
                return SIMD3(-halfWidth + 2 * halfWidth * u, height + radiusY * sin(angle), radiusZ * cos(angle))
            }, texture: texture)
        })
        lid.addChildNode(pictured(art.lid) { texture in
            Mesh.surface(columns: 6, rows: 24, flipped: true, offset: at, point: { u, v in
                let angle = Float.pi * v
                return SIMD3(halfWidth, height + radiusY * u * sin(angle), radiusZ * u * cos(angle))
            }, texture: texture)
        })
        // The hasp, hanging from the front of the lid over the band
        let haspZ = Float(Dim.depth) / 2 + 0.006
        let haspTop = art.point(at: CGPoint(x: art.hasp.minX - 2, y: art.hasp.minY - 2), z: haspZ)
        let haspBottom = art.point(at: CGPoint(x: art.hasp.maxX + 2, y: art.hasp.maxY + 3), z: haspZ)
        lid.addChildNode(pictured(art.lid) { texture in
            Mesh.surface(columns: 2, rows: 2, offset: at, point: { u, v in
                SIMD3(haspTop.x + (haspBottom.x - haspTop.x) * u, haspBottom.y + (haspTop.y - haspBottom.y) * v, haspZ)
            }, texture: texture)
        })

        // Inside: the underside of the dome and of its left end, and the edges it rests on
        let innerWidth = halfWidth - 0.02
        lid.addChildNode(inside(materials.wood, Mesh.surface(columns: 8, rows: 24, flipped: true, offset: at, point: { u, v in
            let angle = Float.pi * v
            return SIMD3(-innerWidth + 2 * innerWidth * u, height + (radiusY - thickness) * sin(angle), (radiusZ - thickness) * cos(angle))
        }, texture: Self.planks(2 * innerWidth, Float.pi * radiusZ))))
        lid.addChildNode(inside(materials.woodDark, Mesh.surface(columns: 4, rows: 24, flipped: true, offset: at, point: { u, v in
            let angle = Float.pi * v
            return SIMD3(-innerWidth, height + (radiusY - thickness) * u * sin(angle), (radiusZ - thickness) * u * cos(angle))
        }, texture: Self.planks(radiusZ, 2 * radiusZ))))
        for (z0, z1) in [(radiusZ - thickness, radiusZ), (-radiusZ, -radiusZ + thickness)] {
            lid.addChildNode(inside(materials.rim, Mesh.surface(columns: 1, rows: 1, offset: at, point: { u, v in
                SIMD3(-halfWidth + 2 * halfWidth * u, height, z0 + (z1 - z0) * v)
            }, texture: { u, v, _ in SIMD2(u, v) })))
        }
    }

    /// The padlock: its picture, and a darker copy just behind it so it has some thickness when it
    /// lies on the floor. The node's origin is where it hangs from (the top of the shackle).
    func buildPadlock(into node: SCNNode) {
        let z = art.padlockZ
        let topLeft = art.point(at: CGPoint(x: art.lock.minX - 3, y: art.lock.minY - 3), z: z)
        let bottomRight = art.point(at: CGPoint(x: art.lock.maxX + 3, y: art.lock.maxY + 3), z: z)
        let hang = art.padlockHang
        let offset = SIMD3<Float>(hang.x, hang.y, hang.z)
        for (shade, depth) in [(CGFloat(1), Float(0)), (0.35, -0.022)] {
            let face = pictured(art.padlock, shade: shade) { texture in
                Mesh.surface(columns: 2, rows: 2, offset: offset, point: { u, v in
                    SIMD3(topLeft.x + (bottomRight.x - topLeft.x) * u, bottomRight.y + (topLeft.y - bottomRight.y) * v, z)
                }, texture: texture)
            }
            face.position.z = depth
            node.addChildNode(face)
        }
    }
}

// MARK: - Materials

private struct ChestMaterials {
    let gold: SCNMaterial
    let silver: SCNMaterial
    let heap: SCNMaterial
    /// The inside of the chest and of the lid, in the chest's planks (crystal for the legendary)
    let wood: SCNMaterial
    let woodDark: SCNMaterial
    /// Tops of the walls and edges of the lid
    let rim: SCNMaterial

    init(_ tier: ChestTier, art: ChestArt) {
        let textures = ChestTextures.shared
        gold = Self.metal(UIColor(red: 1, green: 0.78, blue: 0.34, alpha: 1), roughness: NSNumber(value: 0.22))
        silver = Self.metal(UIColor(red: 0.86, green: 0.88, blue: 0.92, alpha: 1), roughness: NSNumber(value: 0.2))
        let heapColor = tier.treasure == .silverAndGold
            ? UIColor(red: 0.86, green: 0.76, blue: 0.5, alpha: 1)
            : UIColor(red: 0.85, green: 0.62, blue: 0.24, alpha: 1)
        heap = Self.metal(heapColor, roughness: NSNumber(value: 0.42))
        heap.normal.contents = textures.woodNormal
        heap.normal.intensity = 0.6
        wood = Self.planks(art.wood, shade: 0.75)
        woodDark = Self.planks(art.wood, shade: 0.5)
        rim = SCNMaterial()
        rim.lightingModel = .lambert
        rim.diffuse.contents = art.band
    }

    /// The picture painted on the chest: shown as drawn (unlit), and see-through where the picture
    /// is, so the geometry can be a little larger than what it shows.
    static func picture(_ name: String, shade: CGFloat = 1) -> SCNMaterial {
        let material = SCNMaterial()
        material.lightingModel = .constant
        material.diffuse.contents = UIImage(named: name)
        material.diffuse.mipFilter = .linear
        if shade < 1 { material.multiply.contents = UIColor(white: shade, alpha: 1) }
        material.blendMode = .alpha
        material.writesToDepthBuffer = true
        material.readsFromDepthBuffer = true
        // Cut out where the picture is see-through, so nothing behind is hidden by empty pixels
        material.shaderModifiers = [.fragment: "if (_output.color.a < 0.5) { discard_fragment(); }"]
        return material
    }

    /// Planks lit by the light inside the chest (and a dim ambient light).
    private static func planks(_ name: String, shade: CGFloat) -> SCNMaterial {
        let material = SCNMaterial()
        material.lightingModel = .lambert
        material.diffuse.contents = UIImage(named: name)
        material.diffuse.wrapS = .mirror
        material.diffuse.wrapT = .mirror
        material.diffuse.mipFilter = .linear
        material.multiply.contents = UIColor(white: shade, alpha: 1)
        return material
    }

    /// Faceted blue crystal that glows from within.
    func crystal(_ random: inout SeededRandom) -> SCNMaterial {
        let textures = ChestTextures.shared
        let material = SCNMaterial()
        material.lightingModel = .physicallyBased
        material.diffuse.contents = textures.crystalAlbedo
        material.normal.contents = textures.crystalNormal
        material.normal.intensity = 1
        material.roughness.contents = NSNumber(value: 0.06)
        material.metalness.contents = NSNumber(value: 0.15)
        material.emission.contents = UIColor(red: 0.12, green: 0.42, blue: 0.85, alpha: 1)
        material.emission.intensity = Dim.crystalGlowStart
        Self.offset(material, &random)
        return material
    }

    static func gem(_ color: UIColor) -> SCNMaterial {
        let material = SCNMaterial()
        material.lightingModel = .physicallyBased
        material.diffuse.contents = color
        material.metalness.contents = NSNumber(value: 0.1)
        material.roughness.contents = NSNumber(value: 0.05)
        material.emission.contents = color
        material.emission.intensity = 0.25
        return material
    }

    /// Shows a random part of the textures (no seams: the window stays inside them).
    private static func offset(_ material: SCNMaterial, _ random: inout SeededRandom) {
        let scale: Float = 0.55
        let transform = SCNMatrix4Mult(
            SCNMatrix4MakeScale(scale, scale, 1),
            SCNMatrix4MakeTranslation(random.next(in: 0...0.45), random.next(in: 0...0.45), 0)
        )
        material.diffuse.contentsTransform = transform
        material.normal.contentsTransform = transform
    }

    private static func metal(_ color: UIColor, roughness: Any) -> SCNMaterial {
        let material = SCNMaterial()
        material.lightingModel = .physicallyBased
        material.diffuse.contents = color
        material.metalness.contents = NSNumber(value: 1)
        material.roughness.contents = roughness
        return material
    }
}

// MARK: - Particles

private enum ChestParticles {
    /// Motes drifting up out of the chest, for as long as it's on screen.
    static func motes(_ tier: ChestTier) -> SCNParticleSystem {
        let system = SCNParticleSystem()
        system.particleImage = ChestTextures.shared.dot
        system.emitterShape = SCNBox(width: Dim.width - 2 * Dim.plank - 0.1, height: 0.02, length: Dim.depth - 2 * Dim.plank - 0.1, chamferRadius: 0)
        system.birthLocation = .volume
        system.birthRate = tier.moteRate
        system.particleLifeSpan = 2 + 0.3 * CGFloat(tier.level)
        system.particleLifeSpanVariation = 0.7
        system.emittingDirection = SCNVector3(0, 1, 0)
        system.spreadingAngle = 18 + 6 * CGFloat(tier.level)
        system.particleVelocity = 0.28 + 0.06 * CGFloat(tier.level)
        system.particleVelocityVariation = 0.15
        system.acceleration = SCNVector3(0, 0.04, 0)
        system.particleSize = 0.011
        system.particleSizeVariation = 0.007
        system.particleColor = tier.moteColor
        system.particleColorVariation = SCNVector4(0.04, 0.1, 0.1, 0)
        system.particleIntensity = 2.2
        system.blendMode = .additive
        system.isLightingEnabled = false
        system.propertyControllers = [.opacity: fade(peak: 0.2)]
        return system
    }

    /// A burst of sparks when the lid flies open.
    static func sparks(_ tier: ChestTier) -> SCNParticleSystem {
        let system = motes(tier)
        system.loops = false
        system.birthRate = tier.sparkRate
        system.emissionDuration = 0.08
        system.particleLifeSpan = 1.3 + 0.15 * CGFloat(tier.level)
        system.particleLifeSpanVariation = 0.4
        system.spreadingAngle = 35 + 8 * CGFloat(tier.level)
        system.particleVelocity = 1.0 + 0.25 * CGFloat(tier.level)
        system.particleVelocityVariation = 0.4
        system.acceleration = SCNVector3(0, -0.7, 0)
        system.dampingFactor = 1.4
        system.particleSize = 0.008 + 0.0015 * CGFloat(tier.level)
        system.particleColor = tier.sparkColor
        system.particleIntensity = 3
        system.stretchFactor = tier.level >= 2 ? 0.03 : 0
        system.propertyControllers = [.opacity: fade(peak: 0.05)]
        return system
    }

    /// Diamond-blue flames licking up out of the legendary chest.
    static func flames(_ tier: ChestTier) -> SCNParticleSystem {
        let system = SCNParticleSystem()
        system.particleImage = ChestTextures.shared.dot
        system.emitterShape = SCNBox(width: Dim.width - 2 * Dim.plank - 0.06, height: 0.02, length: Dim.depth - 2 * Dim.plank - 0.06, chamferRadius: 0)
        system.birthLocation = .volume
        system.birthRate = 110
        system.particleLifeSpan = 0.75
        system.particleLifeSpanVariation = 0.3
        system.emittingDirection = SCNVector3(0, 1, 0)
        system.spreadingAngle = 10
        system.particleVelocity = 0.9
        system.particleVelocityVariation = 0.35
        system.acceleration = SCNVector3(0, 0.5, 0)
        system.particleSize = 0.05
        system.particleSizeVariation = 0.02
        system.stretchFactor = 0.05
        system.particleColor = tier.lightColor
        system.particleColorVariation = SCNVector4(0.03, 0.05, 0.05, 0)
        system.particleIntensity = 2.4
        system.blendMode = .additive
        system.isLightingEnabled = false
        system.propertyControllers = [.opacity: fade(peak: 0.15), .size: grow(from: 1, to: 0.2)]
        return system
    }

    /// A low puff of dust where something hits the floor.
    static func dust(spread: SCNVector3, amount: CGFloat) -> SCNParticleSystem {
        let system = SCNParticleSystem()
        system.particleImage = ChestTextures.shared.dot
        system.emitterShape = SCNBox(width: CGFloat(spread.x), height: CGFloat(spread.y), length: CGFloat(spread.z), chamferRadius: 0)
        system.birthLocation = .surface
        system.loops = false
        system.birthRate = 700 * amount
        system.emissionDuration = 0.05
        system.particleLifeSpan = 1.1
        system.particleLifeSpanVariation = 0.4
        system.emittingDirection = SCNVector3(0, 1, 0)
        system.spreadingAngle = 80
        system.particleVelocity = 0.35
        system.particleVelocityVariation = 0.2
        system.dampingFactor = 3.5
        system.acceleration = SCNVector3(0, 0.03, 0)
        system.particleSize = 0.05
        system.particleSizeVariation = 0.02
        system.particleColor = UIColor(red: 0.62, green: 0.53, blue: 0.45, alpha: 0.32)
        system.blendMode = .alpha
        system.isLightingEnabled = false
        system.propertyControllers = [.opacity: fade(peak: 0.1), .size: grow(from: 0.6, to: 2.6)]
        return system
    }

    private static func fade(peak: Double) -> SCNParticlePropertyController {
        let animation = CAKeyframeAnimation()
        animation.values = [0, 1, 0]
        animation.keyTimes = [0, NSNumber(value: peak), 1]
        return SCNParticlePropertyController(animation: animation)
    }

    private static func grow(from start: Double, to end: Double) -> SCNParticlePropertyController {
        let animation = CAKeyframeAnimation()
        animation.values = [start, end]
        animation.keyTimes = [0, 1]
        return SCNParticlePropertyController(animation: animation)
    }
}

// MARK: - Procedural textures

/// Textures generated once: wood grain bumps, faceted crystal (for the treasure), light sprites and
/// the studio environment for reflections.
private final class ChestTextures {
    static let shared = ChestTextures()

    let woodNormal: UIImage
    let crystalAlbedo: UIImage
    let crystalNormal: UIImage
    let dot: UIImage
    let glow: UIImage
    let beam: UIImage
    let seam: UIImage
    let ring: UIImage
    let contactShadow: UIImage
    let environment: UIImage

    private init() {
        woodNormal = Self.makeWoodNormal()
        (crystalAlbedo, crystalNormal) = Self.makeCrystal()
        dot = Self.radial(size: 64, color: (1, 1, 1), power: 2.2, alpha: 1)
        glow = Self.radial(size: 128, color: (1, 1, 1), power: 1.6, alpha: 1)
        contactShadow = Self.radial(size: 128, color: (0, 0, 0), power: 1.4, alpha: 0.55)
        beam = Self.makeBeam()
        seam = Self.makeSeam()
        ring = Self.makeRing()
        environment = Self.makeEnvironment()
    }

    /// Bumps of wood grain (for the heap of coins): growth rings warped by noise and fine fibres.
    private static func makeWoodNormal() -> UIImage {
        let width = 512, height = 256
        var heights = [Double](repeating: 0, count: width * height)
        for y in 0..<height {
            for x in 0..<width {
                let u = Double(x) / Double(width), v = Double(y) / Double(height)
                let warp = Noise.fbm(u * 3, v * 2, octaves: 3, seed: 1)
                let rings = v * 9 + warp * 2.2 + 0.4 * Noise.value(u * 1.5, v * 0.5, seed: 9)
                let line = pow(0.5 + 0.5 * sin(rings * 2 * .pi), 6)
                let fiber = Noise.value(u * 10, v * 140, seed: 3)
                heights[y * width + x] = 1 - 0.65 * line - 0.35 * fiber
            }
        }
        return normalMap(heights, width: width, height: height, strength: 2.5)
    }

    /// Faceted crystal: flat cells (Voronoi), each tilted its own way and a different blue, with
    /// bright edges where facets meet.
    private static func makeCrystal() -> (UIImage, UIImage) {
        let size = 256
        var random = SeededRandom(seed: 99)
        let cells = (0..<36).map { _ in
            (x: Double(random.nextUnit()), y: Double(random.nextUnit()),
             nx: random.nextUnit() * 0.9 - 0.45, ny: random.nextUnit() * 0.9 - 0.45,
             tone: 0.7 + 0.45 * random.nextUnit())
        }
        var nearest = [Int](repeating: 0, count: size * size)
        var edge = [Double](repeating: 0, count: size * size)
        for y in 0..<size {
            for x in 0..<size {
                let u = Double(x) / Double(size), v = Double(y) / Double(size)
                var best = Double.greatestFiniteMagnitude, second = Double.greatestFiniteMagnitude, bestIndex = 0
                for (index, cell) in cells.enumerated() {
                    let distance = (u - cell.x) * (u - cell.x) + (v - cell.y) * (v - cell.y)
                    if distance < best {
                        second = best; best = distance; bestIndex = index
                    } else if distance < second {
                        second = distance
                    }
                }
                nearest[y * size + x] = bestIndex
                edge[y * size + x] = 1 - min(1, (sqrt(second) - sqrt(best)) / 0.012)
            }
        }
        let albedo = pixels(width: size, height: size) { x, y in
            let cell = cells[nearest[y * size + x]]
            let e = edge[y * size + x]
            let base = (0.2 * cell.tone, 0.55 * cell.tone, 0.95 * min(1, cell.tone))
            return (base.0 + (0.85 - base.0) * e, base.1 + (0.95 - base.1) * e, base.2 + (1 - base.2) * e, 1)
        }
        let normal = pixels(width: size, height: size, linear: true) { x, y in
            let cell = cells[nearest[y * size + x]]
            let length = sqrt(cell.nx * cell.nx + cell.ny * cell.ny + 1)
            return (0.5 + 0.5 * cell.nx / length, 0.5 + 0.5 * cell.ny / length, 0.5 + 0.5 / length, 1)
        }
        return (albedo, normal)
    }

    /// Light beam: bright at the bottom, fading up, with soft rays around (seamless around the cone).
    /// White: each chest tints it.
    private static func makeBeam() -> UIImage {
        let width = 256, height = 256
        return pixels(width: width, height: height) { x, y in
            let u = Double(x) / Double(width), v = Double(y) / Double(height)
            let rays = 0.45 + 0.55 * (0.5 + 0.5 * sin(u * 2 * .pi * 5 + 1.3)) * (0.5 + 0.5 * sin(u * 2 * .pi * 9 + 0.4))
            let fade = pow(v, 1.8) * (1 - smoothstep(0.94, 1, v) * 0.5)
            return (1, 0.97, 0.93, min(1, fade * rays * 0.75))
        }
    }

    /// Light around the lid's seam: full inside the chest's outline, fading out beyond it.
    private static func makeSeam() -> UIImage {
        let margin = Dim.seamMargin
        let innerX = Double(Dim.width / (Dim.width + 2 * margin))
        let innerY = Double(Dim.depth / (Dim.depth + 2 * margin))
        let width = 256, height = Int(256 * (Dim.depth + 2 * margin) / (Dim.width + 2 * margin))
        return pixels(width: width, height: height) { x, y in
            let dx = abs((Double(x) + 0.5) / Double(width) * 2 - 1)
            let dy = abs((Double(y) + 0.5) / Double(height) * 2 - 1)
            let ex = max(0, (dx - innerX) / (1 - innerX))
            let ey = max(0, (dy - innerY) / (1 - innerY))
            return (1, 1, 1, pow(max(0, 1 - sqrt(ex * ex + ey * ey)), 2.4))
        }
    }

    /// Shockwave: a sharp bright ring with a soft trail inside.
    private static func makeRing() -> UIImage {
        let size = 256
        return pixels(width: size, height: size) { x, y in
            let dx = (Double(x) + 0.5) / Double(size) * 2 - 1
            let dy = (Double(y) + 0.5) / Double(size) * 2 - 1
            let d = sqrt(dx * dx + dy * dy)
            let ring = exp(-pow((d - 0.86) / 0.05, 2)) + 0.3 * exp(-pow((d - 0.65) / 0.18, 2))
            return (1, 1, 1, d > 1 ? 0 : min(1, ring))
        }
    }

    /// Equirectangular studio: bright warm top, dark floor and two softboxes for crisp reflections.
    private static func makeEnvironment() -> UIImage {
        let size = CGSize(width: 512, height: 256)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            let cg = context.cgContext
            let colors = [
                UIColor(red: 0.78, green: 0.72, blue: 0.64, alpha: 1).cgColor,
                UIColor(red: 0.3, green: 0.26, blue: 0.22, alpha: 1).cgColor,
                UIColor(red: 0.07, green: 0.055, blue: 0.05, alpha: 1).cgColor
            ] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors, locations: [0, 0.5, 0.62]) {
                cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: size.height), options: [])
            }
            cg.setFillColor(UIColor.white.cgColor)
            cg.fillEllipse(in: CGRect(x: 120, y: 30, width: 110, height: 50))
            cg.setFillColor(UIColor(red: 0.8, green: 0.88, blue: 1, alpha: 1).cgColor)
            cg.fillEllipse(in: CGRect(x: 380, y: 70, width: 60, height: 28))
        }
    }

    private static func radial(size: Int, color: (Double, Double, Double), power: Double, alpha: Double) -> UIImage {
        pixels(width: size, height: size) { x, y in
            let dx = (Double(x) + 0.5) / Double(size) * 2 - 1
            let dy = (Double(y) + 0.5) / Double(size) * 2 - 1
            return (color.0, color.1, color.2, pow(max(0, 1 - sqrt(dx * dx + dy * dy)), power) * alpha)
        }
    }

    private static func normalMap(_ heights: [Double], width: Int, height: Int, strength: Double) -> UIImage {
        pixels(width: width, height: height, linear: true) { x, y in
            func h(_ px: Int, _ py: Int) -> Double {
                heights[min(height - 1, max(0, py)) * width + min(width - 1, max(0, px))]
            }
            let dx = (h(x + 1, y) - h(x - 1, y)) * strength
            let dy = (h(x, y + 1) - h(x, y - 1)) * strength
            let length = sqrt(dx * dx + dy * dy + 1)
            return (0.5 - 0.5 * dx / length, 0.5 + 0.5 * dy / length, 0.5 + 0.5 / length, 1)
        }
    }

    private static func smoothstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
        let t = min(max((x - edge0) / (edge1 - edge0), 0), 1)
        return t * t * (3 - 2 * t)
    }

    /// An image from a per-pixel function returning straight (non premultiplied) RGBA in 0...1.
    private static func pixels(width: Int, height: Int, linear: Bool = false, _ pixel: (Int, Int) -> (Double, Double, Double, Double)) -> UIImage {
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        for y in 0..<height {
            for x in 0..<width {
                let (r, g, b, a) = pixel(x, y)
                let alpha = max(0, min(1, a))
                let index = (y * width + x) * 4
                // Stored premultiplied
                bytes[index] = UInt8(max(0, min(1, r)) * alpha * 255)
                bytes[index + 1] = UInt8(max(0, min(1, g)) * alpha * 255)
                bytes[index + 2] = UInt8(max(0, min(1, b)) * alpha * 255)
                bytes[index + 3] = UInt8(alpha * 255)
            }
        }
        let space = CGColorSpace(name: linear ? CGColorSpace.linearSRGB : CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        guard let provider = CGDataProvider(data: Data(bytes) as CFData),
              let image = CGImage(
                width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
                space: space, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent
              ) else { return UIImage() }
        return UIImage(cgImage: image)
    }
}

// MARK: - Noise

private enum Noise {
    private static func hash(_ x: Int, _ y: Int, _ seed: Int) -> Double {
        var h = UInt64(bitPattern: Int64(x &* 374_761_393 &+ y &* 668_265_263 &+ seed &* 2_246_822_519))
        h = (h ^ (h >> 13)) &* 1_274_126_177
        h ^= h >> 16
        return Double(h & 0xFFFF) / 65535
    }

    /// Smooth value noise in 0...1.
    static func value(_ x: Double, _ y: Double, seed: Int = 0) -> Double {
        let fx = floor(x), fy = floor(y)
        let xi = Int(fx), yi = Int(fy)
        let tx = x - fx, ty = y - fy
        let u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty)
        let a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed)
        let c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed)
        return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
    }

    static func fbm(_ x: Double, _ y: Double, octaves: Int, seed: Int) -> Double {
        var sum = 0.0, amplitude = 0.5, frequency = 1.0, total = 0.0
        for octave in 0..<octaves {
            sum += amplitude * value(x * frequency, y * frequency, seed: seed + octave * 17)
            total += amplitude
            amplitude *= 0.5
            frequency *= 2
        }
        return sum / total
    }
}

/// Deterministic random numbers, so each chest looks the same every time.
private struct SeededRandom {
    private var state: UInt64

    init(seed: UInt64) { state = seed &* 0x9E37_79B9_7F4A_7C15 }

    mutating func nextUnit() -> Double {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        z ^= z >> 31
        return Double(z >> 11) / Double(1 << 53)
    }

    mutating func next(in range: ClosedRange<Float>) -> Float {
        range.lowerBound + Float(nextUnit()) * (range.upperBound - range.lowerBound)
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
        .onAppear { ChestOpening3DView.prewarm() }
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
            ChestOpening3DView(rarity: rarity) {
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
