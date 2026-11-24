import CoreHaptics
import SceneKit
import SwiftUI
import UIKit

/// A chest opening in real 3D (SceneKit), for every rarity. The chest drops in, the lid strains
/// against the padlock, the shackle pops, the padlock falls to the floor and the lid swings open on
/// its hinge; light pours out of the treasure inside.
///
/// It goes from less to more with the rarity: common is wood and copper with a warm glow; rare is
/// steel, with light leaking through the seam before it opens; epic is gold, with a longer charge, a
/// purple light, a second beam and a shockwave; legendary has crystal panels and a diamond on the
/// lid, levitates while it charges and slams down, then bursts open in a flash with diamond-blue
/// flames and two shockwaves. Light, beams, particles, camera shake and haptics (Core Haptics
/// rumbles on the premium ones) all grow with the rarity.
///
/// The models and textures are generated in code to match the illustrated chests. Tapping skips to
/// the open chest; with Reduce Motion the lid just opens. `onOpened` is called once, when the lid is
/// open (or the animation was skipped).
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
        DispatchQueue.global(qos: .utility).async { _ = ChestTextures.shared }
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
    enum Panels { case wood, steel, gold, crystal }
    enum Treasure { case coins, silverAndGold, gems, crystals }

    /// 0 common · 1 rare · 2 epic · 3 legendary
    let level: Int

    // Look
    let panels: Panels
    let trim: UIColor
    let trimRoughness: CGFloat
    let rivet: UIColor
    let lock: UIColor
    let treasure: Treasure
    let diamond: Bool

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
            panels = .steel
            trim = UIColor(red: 0.7, green: 0.72, blue: 0.76, alpha: 1); trimRoughness = 0.3
            rivet = UIColor(red: 0.88, green: 0.9, blue: 0.93, alpha: 1)
            lock = UIColor(red: 0.8, green: 0.82, blue: 0.86, alpha: 1)
            treasure = .silverAndGold; diamond = false
            lightColor = UIColor(red: 0.72, green: 0.86, blue: 1, alpha: 1); lightIntensity = 1100
            beamOpacity = 0.9; beamWidth = 1.05
            moteColor = UIColor(red: 0.8, green: 0.9, blue: 1, alpha: 1); moteRate = 55
            sparkColor = UIColor(red: 0.85, green: 0.93, blue: 1, alpha: 1); sparkRate = 1700
            knocks = [0.06, 0.09, 0.065]; charge = 0.35; seamGlow = 0.55
            levitates = false; shockwaves = 0; flash = false; flames = false
            shake = 0.01; rumble = 0.35
        case "epic":
            level = 2
            panels = .gold
            trim = UIColor(red: 1, green: 0.74, blue: 0.28, alpha: 1); trimRoughness = 0.26
            rivet = UIColor(red: 1, green: 0.86, blue: 0.5, alpha: 1)
            lock = UIColor(red: 1, green: 0.8, blue: 0.36, alpha: 1)
            treasure = .gems; diamond = false
            lightColor = UIColor(red: 0.82, green: 0.56, blue: 1, alpha: 1); lightIntensity = 1700
            beamOpacity = 1; beamWidth = 1.15
            moteColor = UIColor(red: 0.86, green: 0.66, blue: 1, alpha: 1); moteRate = 85
            sparkColor = UIColor(red: 1, green: 0.84, blue: 0.45, alpha: 1); sparkRate = 3200
            knocks = [0.07, 0.1, 0.08, 0.12]; charge = 0.7; seamGlow = 0.85
            levitates = false; shockwaves = 1; flash = false; flames = false
            shake = 0.025; rumble = 0.65
        case "legendary":
            level = 3
            panels = .crystal
            trim = UIColor(red: 0.86, green: 0.88, blue: 0.92, alpha: 1); trimRoughness = 0.2
            rivet = UIColor(red: 0.95, green: 0.96, blue: 1, alpha: 1)
            lock = UIColor(red: 0.88, green: 0.9, blue: 0.94, alpha: 1)
            treasure = .crystals; diamond = true
            lightColor = UIColor(red: 0.45, green: 0.78, blue: 1, alpha: 1); lightIntensity = 2600
            beamOpacity = 1; beamWidth = 1.3
            moteColor = UIColor(red: 0.6, green: 0.85, blue: 1, alpha: 1); moteRate = 130
            sparkColor = UIColor(red: 0.8, green: 0.95, blue: 1, alpha: 1); sparkRate = 5200
            knocks = [0.08, 0.11, 0.09, 0.14]; charge = 1.1; seamGlow = 1
            levitates = true; shockwaves = 2; flash = true; flames = true
            shake = 0.045; rumble = 1
        default:
            level = 0
            panels = .wood
            trim = UIColor(red: 0.8, green: 0.46, blue: 0.26, alpha: 1); trimRoughness = -1
            rivet = UIColor(red: 0.93, green: 0.6, blue: 0.36, alpha: 1)
            lock = UIColor(red: 0.86, green: 0.62, blue: 0.3, alpha: 1)
            treasure = .coins; diamond = false
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

/// Chest size in scene units (≈ metres): width (x), base height (y), depth (z), plank thickness.
private enum Dim {
    static let width: CGFloat = 1.0
    static let height: CGFloat = 0.5
    static let depth: CGFloat = 0.66
    static let plank: CGFloat = 0.045
    /// Radius of the domed lid (a half cylinder along x).
    static var lidRadius: CGFloat { depth / 2 }
    /// Lid angle once open (radians, around the back hinge).
    static let openAngle: Float = -1.92
    /// Where the padlock hangs (shackle top) and where it ends up on the floor.
    static let padlockHang = SCNVector3(0, Float(height) - 0.1, Float(depth / 2) + 0.045)
    static let padlockRest = SCNVector3(0.02, 0.026, Float(depth / 2) + 0.11)
    /// Light leaking around the seam: a glow this much wider than the chest on each side.
    static let seamMargin: CGFloat = 0.14
    /// Glow of the legendary crystal before and after charging.
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
    private let shackle = SCNNode()
    private let innerLight = SCNNode()
    private let seamLight = SCNNode()
    private let seam = SCNNode()
    private let glow = SCNNode()
    private let beam = SCNNode()
    private let motes = SCNNode()
    private let flashNode = SCNNode()
    private var rings: [SCNNode] = []
    private let cameraRig = SCNNode()
    private let cameraNode = SCNNode()
    private let cameraTarget = SCNNode()
    /// Materials that glow brighter as the chest charges (the legendary crystal).
    private var glowing: [SCNMaterial] = []

    private var tier = ChestTier("common")
    private var built = false
    private var finished = false
    private var motesStarted = false
    private var calm = false
    private var onOpened: (() -> Void)?
    private let haptics = ChestHaptics()

    private static let cameraStart = SCNVector3(1.5, 2.05, 4.0)
    private static let cameraMid = SCNVector3(1.15, 1.7, 3.2)
    private static let cameraEnd = SCNVector3(1.0, 1.85, 2.9)
    private static let targetStart = SCNVector3(0, 0.35, 0)
    private static let targetEnd = SCNVector3(0, 0.05, 0)

    func attach(to view: SCNView, rarity: String, reduceMotion: Bool, onOpened: @escaping () -> Void) {
        self.onOpened = onOpened
        if !built {
            tier = ChestTier(rarity)
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

        // Floor: only receives the chest's shadow, plus a soft contact shadow
        let floor = SCNFloor()
        floor.reflectivity = 0
        let floorMaterial = SCNMaterial()
        floorMaterial.lightingModel = .shadowOnly
        floor.materials = [floorMaterial]
        root.addChildNode(SCNNode(geometry: floor))
        let contact = SCNPlane(width: Dim.width + 0.45, height: Dim.depth + 0.4)
        contact.materials = [ChestScene.decal(textures.contactShadow, add: false)]
        let contactNode = SCNNode(geometry: contact)
        contactNode.eulerAngles.x = -.pi / 2
        contactNode.position.y = 0.002
        contactNode.renderingOrder = 1
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

        // Camera: a rig that dollies in, the camera inside it shakes; it always looks at a target
        cameraTarget.position = Self.targetStart
        root.addChildNode(cameraTarget)
        let camera = SCNCamera()
        camera.projectionDirection = .horizontal
        camera.fieldOfView = 34
        camera.zNear = 0.1
        camera.zFar = 30
        camera.wantsHDR = true
        camera.wantsExposureAdaptation = false
        camera.exposureOffset = 0.15
        camera.bloomIntensity = 0.7 + 0.25 * CGFloat(tier.level)
        camera.bloomThreshold = 0.85
        camera.bloomBlurRadius = 14 + 3 * CGFloat(tier.level)
        camera.vignettingPower = 0.8
        camera.vignettingIntensity = 1.2
        camera.screenSpaceAmbientOcclusionIntensity = 0.9
        camera.screenSpaceAmbientOcclusionRadius = 0.12
        cameraNode.camera = camera
        let lookAt = SCNLookAtConstraint(target: cameraTarget)
        lookAt.isGimbalLockEnabled = true
        cameraNode.constraints = [lookAt]
        cameraRig.position = Self.cameraStart
        cameraRig.addChildNode(cameraNode)
        root.addChildNode(cameraRig)

        // The chest
        root.addChildNode(chestRoot)
        var builder = ChestBuilder(tier: tier)
        builder.buildBase(into: chestRoot)
        builder.buildTreasure(into: chestRoot)
        lidPivot.position = SCNVector3(0, Float(Dim.height), -Float(Dim.depth / 2))
        chestRoot.addChildNode(lidPivot)
        builder.buildLid(into: lidPivot)
        padlock.position = Dim.padlockHang
        chestRoot.addChildNode(padlock)
        builder.buildPadlock(into: padlock, shackle: shackle)
        glowing = builder.glowing

        // Light from inside: an omni light, a glow over the treasure and a beam of light
        innerLight.light = ChestScene.omni(color: tier.lightColor, reach: 1.7 + 0.25 * CGFloat(tier.level))
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

        // Slow dolly in, then a second push once it opens
        cameraRig.runAction(.sequence([
            .move(to: Self.cameraMid, duration: open + 0.3).timed(Ease.inOut),
            .move(to: Self.cameraEnd, duration: 1.3).timed(Ease.inOut)
        ]))
        cameraTarget.runAction(.sequence([
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

        // 4. The shackle pops and the padlock falls to the floor
        shackle.runAction(.sequence([
            .wait(duration: unlock),
            .moveBy(x: 0, y: 0.03, z: 0, duration: 0.07).timed(Ease.outQuad)
        ]))
        event(at: unlock) { [weak self] in self?.haptics.impact(.rigid, 1) }
        let landing = Dim.padlockRest
        padlock.runAction(.sequence([
            .wait(duration: fall),
            .group([
                .move(to: landing, duration: 0.3).timed(Ease.inQuad),
                .rotateTo(x: -.pi / 2, y: 0, z: 0, duration: 0.3).timed(Ease.inQuad)
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
            cameraNode.runAction(.sequence([.wait(duration: open + 0.04), Self.shake(tier.shake, steps: 6 + 3 * tier.level)]))
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
            cameraNode.runAction(.sequence([.wait(duration: unlock), Self.shake(0.02, steps: 5)]))
        }
    }

    /// Reduce Motion: the chest is already in place; the padlock fades and the lid opens.
    private func playCalm() {
        cameraRig.position = Self.cameraEnd
        cameraTarget.position = Self.targetEnd
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
        var nodes = [events, chestRoot, lidPivot, padlock, shackle, innerLight, seamLight, seam, glow, beam, flashNode, cameraRig, cameraNode, cameraTarget]
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
        padlock.position = Dim.padlockRest
        padlock.eulerAngles = SCNVector3(-Float.pi / 2, 0, 0)
        padlock.opacity = calm ? 0 : 1
        shackle.position.y = -0.042 + 0.03
        innerLight.light?.intensity = tier.lightIntensity
        seamLight.light?.intensity = 0
        seam.opacity = 0
        glow.opacity = 0.85
        beam.opacity = tier.beamOpacity
        flashNode.opacity = 0
        for ring in rings { ring.opacity = 0 }
        for material in glowing { material.emission.intensity = Dim.crystalGlowEnd }
        cameraRig.position = Self.cameraEnd
        cameraNode.position = SCNVector3(0, 0, 0)
        cameraTarget.position = Self.targetEnd
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

    /// Studio lighting: a warm key light with soft shadows, a cool fill and a warm rim.
    static func addLights(to root: SCNNode) {
        let key = SCNLight()
        key.type = .directional
        key.color = UIColor(red: 1, green: 0.93, blue: 0.84, alpha: 1)
        key.intensity = 1100
        key.castsShadow = true
        key.shadowMode = .deferred
        key.shadowRadius = 8
        key.shadowSampleCount = 16
        key.shadowMapSize = CGSize(width: 2048, height: 2048)
        key.shadowColor = UIColor(white: 0, alpha: 0.62)
        key.automaticallyAdjustsShadowProjection = true
        root.addChildNode(lightNode(key, at: SCNVector3(-2.2, 4.5, 3.0)))

        let fill = SCNLight()
        fill.type = .directional
        fill.color = UIColor(red: 0.62, green: 0.72, blue: 1, alpha: 1)
        fill.intensity = 320
        root.addChildNode(lightNode(fill, at: SCNVector3(3.2, 1.4, 2.0)))

        let rim = SCNLight()
        rim.type = .directional
        rim.color = UIColor(red: 1, green: 0.84, blue: 0.68, alpha: 1)
        rim.intensity = 900
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

// MARK: - Model

/// Builds the chest of a tier: walls, domed lid, metal trim, padlock and treasure.
private struct ChestBuilder {
    let tier: ChestTier
    let materials: ChestMaterials
    /// Materials that glow as the chest charges.
    private(set) var glowing: [SCNMaterial] = []
    private let rivetGeometry: SCNSphere

    init(tier: ChestTier) {
        self.tier = tier
        materials = ChestMaterials(tier)
        let sphere = SCNSphere(radius: 0.016)
        sphere.segmentCount = 14
        sphere.materials = [materials.rivet]
        rivetGeometry = sphere
    }

    /// A wall plank or lid stave of the tier.
    private mutating func panel(_ random: inout SeededRandom, shade: CGFloat = 1) -> SCNMaterial {
        let material = materials.panel(tier.panels, &random, shade: shade)
        if tier.panels == .crystal { glowing.append(material) }
        return material
    }

    mutating func buildBase(into parent: SCNNode) {
        let width = Dim.width, height = Dim.height, depth = Dim.depth, plank = Dim.plank
        var random = SeededRandom(seed: 7)
        let rowHeight = height / 3

        // Walls: three horizontal planks per side, each slightly different
        for row in 0..<3 {
            let y = Float(rowHeight * (CGFloat(row) + 0.5))
            for side in [Float(1), -1] {
                let frontMaterial = panel(&random)
                let front = box(width, rowHeight - 0.006, plank, chamfer: 0.01, frontMaterial)
                front.position = SCNVector3(0, y, side * Float(depth / 2 - plank / 2))
                parent.addChildNode(front)
                let endMaterial = panel(&random)
                let end = box(plank, rowHeight - 0.006, depth - 2 * plank, chamfer: 0.01, endMaterial)
                end.position = SCNVector3(side * Float(width / 2 - plank / 2), y, 0)
                parent.addChildNode(end)
            }
        }
        let bottom = box(width - 2 * plank, 0.03, depth - 2 * plank, chamfer: 0.004, materials.panel(.wood, &random, shade: 0.45))
        bottom.position.y = 0.05
        parent.addChildNode(bottom)

        // Metal corner brackets with rivets
        let post: CGFloat = 0.1, stick: CGFloat = 0.012
        for sx in [Float(1), -1] {
            for sz in [Float(1), -1] {
                let corner = box(post, height + 0.012, post, chamfer: 0.012, materials.trim)
                let cx = sx * Float(width / 2 - post / 2 + stick)
                let cz = sz * Float(depth / 2 - post / 2 + stick)
                corner.position = SCNVector3(cx, Float(height / 2), cz)
                parent.addChildNode(corner)
                for y in [Float(0.1), Float(height) - 0.1] {
                    parent.addChildNode(rivet(at: SCNVector3(cx, y, cz + sz * Float(post / 2))))
                    parent.addChildNode(rivet(at: SCNVector3(cx + sx * Float(post / 2), y, cz)))
                }
            }
        }

        // Metal bands along the top and bottom edges
        for y in [Float(height) - 0.03, 0.045] {
            for side in [Float(1), -1] {
                let long = box(width - 0.2, 0.05, 0.016, chamfer: 0.004, materials.trim)
                long.position = SCNVector3(0, y, side * Float(depth / 2 + 0.004))
                parent.addChildNode(long)
                let short = box(0.016, 0.05, depth - 0.2, chamfer: 0.004, materials.trim)
                short.position = SCNVector3(side * Float(width / 2 + 0.004), y, 0)
                parent.addChildNode(short)
            }
            for x in [Float(-0.33), -0.18, 0.18, 0.33] {
                parent.addChildNode(rivet(at: SCNVector3(x, y, Float(depth / 2) + 0.012)))
            }
        }

        // Lock plate behind the padlock
        let plate = box(0.17, 0.22, 0.016, chamfer: 0.004, materials.trim)
        plate.position = SCNVector3(0, Float(height) - 0.14, Float(depth / 2) + 0.008)
        parent.addChildNode(plate)
        for (x, y) in [(-0.065, -0.05), (0.065, -0.05), (-0.065, -0.23), (0.065, -0.23)] {
            parent.addChildNode(rivet(at: SCNVector3(Float(x), Float(height) + Float(y), Float(depth / 2) + 0.016), radius: 0.011))
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

    /// The domed lid. `pivot` sits on the back hinge; the lid's axis is half a depth in front of it.
    mutating func buildLid(into pivot: SCNNode) {
        let lid = SCNNode()
        lid.position = SCNVector3(0, 0, Float(Dim.depth / 2))
        pivot.addChildNode(lid)
        let width = Dim.width, radius = Dim.lidRadius, plank = Dim.plank
        var random = SeededRandom(seed: 13)

        // Staves around the half cylinder
        let staves = 7
        let chord = 2 * radius * sin(.pi / CGFloat(2 * staves)) + 0.006
        for index in 0..<staves {
            let angle = Float.pi * (Float(index) + 0.5) / Float(staves)
            let staveMaterial = panel(&random)
            let stave = box(width - 0.01, plank, chord, chamfer: 0.008, staveMaterial)
            let middle = Float(radius - plank / 2)
            stave.position = SCNVector3(0, middle * sin(angle), middle * cos(angle))
            stave.eulerAngles.x = .pi / 2 - angle
            lid.addChildNode(stave)
        }

        // Ends, and metal arches over them
        for side in [Float(1), -1] {
            let endMaterial = panel(&random, shade: 0.85)
            let end = arch(outer: radius - plank + 0.004, inner: 0, thickness: 0.03, endMaterial)
            end.position.x = side * Float(width / 2 - 0.02)
            lid.addChildNode(end)

            let band = arch(outer: radius + 0.016, inner: radius - plank - 0.005, thickness: 0.07, materials.trim)
            let bandX = side * Float(width / 2 - 0.035)
            band.position.x = bandX
            lid.addChildNode(band)
            for step in 0..<5 {
                let angle = Float.pi * (Float(step) + 0.5) / 5
                let outer = Float(radius + 0.016)
                lid.addChildNode(rivet(at: SCNVector3(bandX, outer * sin(angle), outer * cos(angle))))
            }
        }

        // Front and back edge bands
        for side in [Float(1), -1] {
            let edge = box(width - 0.16, 0.05, 0.016, chamfer: 0.004, materials.trim)
            edge.position = SCNVector3(0, 0.03, side * Float(radius + 0.004))
            lid.addChildNode(edge)
        }

        // Hasp hanging over the lock plate, with the staple the padlock goes through
        let hasp = box(0.11, 0.17, 0.014, chamfer: 0.005, materials.trim)
        hasp.position = SCNVector3(0, -0.045, Float(radius) + 0.024)
        lid.addChildNode(hasp)
        lid.addChildNode(rivet(at: SCNVector3(0, 0.015, Float(radius) + 0.031), radius: 0.012))
        let staple = SCNTorus(ringRadius: 0.022, pipeRadius: 0.007)
        staple.ringSegmentCount = 32
        staple.pipeSegmentCount = 12
        staple.materials = [materials.trim]
        let stapleNode = SCNNode(geometry: staple)
        stapleNode.eulerAngles.z = .pi / 2
        let hang = Dim.padlockHang
        stapleNode.position = SCNVector3(0, hang.y - Float(Dim.height) + 0.002, hang.z)
        lid.addChildNode(stapleNode)

        // A big diamond set on top (legendary)
        if tier.diamond {
            let diamond = SCNNode()
            let material = materials.crystal(&random)
            glowing.append(material)
            let crown = SCNCone(topRadius: 0.065, bottomRadius: 0.125, height: 0.055)
            crown.radialSegmentCount = 8
            crown.materials = [material]
            let crownNode = SCNNode(geometry: crown)
            crownNode.position.y = 0.0275
            diamond.addChildNode(crownNode)
            let pavilion = SCNCone(topRadius: 0.125, bottomRadius: 0, height: 0.12)
            pavilion.radialSegmentCount = 8
            pavilion.materials = [material]
            let pavilionNode = SCNNode(geometry: pavilion)
            pavilionNode.position.y = -0.06
            diamond.addChildNode(pavilionNode)
            diamond.position = SCNVector3(0, Float(radius) + 0.035, 0.03)
            diamond.eulerAngles = SCNVector3(0.3, 0.2, 0)
            lid.addChildNode(diamond)
        }
    }

    /// The padlock. Its origin is the top of the shackle, where it hangs from the staple.
    func buildPadlock(into node: SCNNode, shackle: SCNNode) {
        let ring = SCNTorus(ringRadius: 0.042, pipeRadius: 0.011)
        ring.ringSegmentCount = 48
        ring.pipeSegmentCount = 16
        ring.materials = [materials.shackle]
        shackle.geometry = ring
        shackle.eulerAngles.x = .pi / 2
        shackle.position.y = -0.042
        node.addChildNode(shackle)

        let body = box(0.13, 0.12, 0.05, chamfer: 0.016, materials.lock)
        body.position.y = -0.042 - 0.06
        node.addChildNode(body)

        let keyhole = SCNCylinder(radius: 0.011, height: 0.004)
        keyhole.materials = [materials.keyhole]
        let hole = SCNNode(geometry: keyhole)
        hole.eulerAngles.x = .pi / 2
        hole.position = SCNVector3(0, -0.092, 0.0255)
        node.addChildNode(hole)
        let slot = box(0.007, 0.026, 0.004, chamfer: 0, materials.keyhole)
        slot.position = SCNVector3(0, -0.108, 0.0255)
        node.addChildNode(slot)
    }

    // MARK: Shapes

    private func box(_ width: CGFloat, _ height: CGFloat, _ length: CGFloat, chamfer: CGFloat, _ material: SCNMaterial) -> SCNNode {
        let geometry = SCNBox(width: width, height: height, length: length, chamferRadius: chamfer)
        geometry.chamferSegmentCount = 3
        geometry.materials = [material]
        return SCNNode(geometry: geometry)
    }

    private func rivet(at position: SCNVector3, radius: CGFloat = 0.016) -> SCNNode {
        let geometry: SCNGeometry
        if radius == 0.016 {
            geometry = rivetGeometry
        } else {
            let sphere = SCNSphere(radius: radius)
            sphere.segmentCount = 14
            sphere.materials = [materials.rivet]
            geometry = sphere
        }
        let node = SCNNode(geometry: geometry)
        node.position = position
        return node
    }

    /// A half disc (inner 0) or half ring standing in the y-z plane, `thickness` wide along x.
    private func arch(outer: CGFloat, inner: CGFloat, thickness: CGFloat, _ material: SCNMaterial) -> SCNNode {
        let path = UIBezierPath()
        path.move(to: CGPoint(x: outer, y: 0))
        path.addArc(withCenter: .zero, radius: outer, startAngle: 0, endAngle: .pi, clockwise: true)
        if inner > 0 {
            path.addLine(to: CGPoint(x: -inner, y: 0))
            path.addArc(withCenter: .zero, radius: inner, startAngle: .pi, endAngle: 0, clockwise: false)
        }
        path.close()
        path.flatness = 0.002
        let shape = SCNShape(path: path, extrusionDepth: thickness)
        shape.chamferRadius = inner > 0 ? 0.003 : 0
        shape.materials = [material]
        let node = SCNNode(geometry: shape)
        // Path x → depth (z), extrusion → width (x)
        node.eulerAngles.y = .pi / 2
        return node
    }
}

// MARK: - Materials

private struct ChestMaterials {
    let trim: SCNMaterial
    let rivet: SCNMaterial
    let lock: SCNMaterial
    let shackle: SCNMaterial
    let keyhole: SCNMaterial
    let gold: SCNMaterial
    let silver: SCNMaterial
    let heap: SCNMaterial

    init(_ tier: ChestTier) {
        let textures = ChestTextures.shared
        let worn: Any
        if tier.trimRoughness < 0 {
            worn = textures.metalRoughness
        } else {
            worn = NSNumber(value: Double(tier.trimRoughness))
        }
        trim = Self.metal(tier.trim, roughness: worn, albedo: textures.metalAlbedo)
        rivet = Self.metal(tier.rivet, roughness: NSNumber(value: 0.26))
        lock = Self.metal(tier.lock, roughness: textures.metalRoughness, albedo: textures.metalAlbedo)
        shackle = Self.metal(UIColor(red: 0.74, green: 0.7, blue: 0.66, alpha: 1), roughness: NSNumber(value: 0.3))
        keyhole = Self.metal(UIColor(white: 0.05, alpha: 1), roughness: NSNumber(value: 0.7))
        if tier.level >= 3 {
            // A glowing keyhole on the legendary padlock
            keyhole.emission.contents = tier.lightColor
            keyhole.emission.intensity = 1.5
        }
        gold = Self.metal(UIColor(red: 1, green: 0.78, blue: 0.34, alpha: 1), roughness: NSNumber(value: 0.22))
        silver = Self.metal(UIColor(red: 0.86, green: 0.88, blue: 0.92, alpha: 1), roughness: NSNumber(value: 0.2))
        let heapColor = tier.treasure == .silverAndGold
            ? UIColor(red: 0.86, green: 0.76, blue: 0.5, alpha: 1)
            : UIColor(red: 0.85, green: 0.62, blue: 0.24, alpha: 1)
        heap = Self.metal(heapColor, roughness: NSNumber(value: 0.42))
        heap.normal.contents = textures.woodNormal
        heap.normal.intensity = 0.6
    }

    /// A wall plank or lid stave. Each one shows a different part of the texture and a slightly
    /// different shade, so no two look the same.
    func panel(_ style: ChestTier.Panels, _ random: inout SeededRandom, shade: CGFloat = 1) -> SCNMaterial {
        let textures = ChestTextures.shared
        if style == .crystal { return crystal(&random) }
        let material = SCNMaterial()
        material.lightingModel = .physicallyBased
        material.normal.contents = textures.woodNormal
        let tone = shade * CGFloat(random.next(in: 0.84...1))
        switch style {
        case .wood:
            material.diffuse.contents = textures.woodAlbedo
            material.normal.intensity = 0.9
            material.roughness.contents = NSNumber(value: 0.7)
            material.metalness.contents = NSNumber(value: 0)
            material.multiply.contents = UIColor(white: tone, alpha: 1)
        case .steel:
            material.diffuse.contents = textures.grainGray
            material.normal.intensity = 0.7
            material.roughness.contents = NSNumber(value: 0.42)
            material.metalness.contents = NSNumber(value: 0.9)
            material.multiply.contents = UIColor(red: 0.56 * tone, green: 0.59 * tone, blue: 0.65 * tone, alpha: 1)
        case .gold, .crystal:
            material.diffuse.contents = textures.grainGray
            material.normal.intensity = 0.6
            material.roughness.contents = NSNumber(value: 0.32)
            material.metalness.contents = NSNumber(value: 1)
            material.multiply.contents = UIColor(red: 1 * tone, green: 0.77 * tone, blue: 0.3 * tone, alpha: 1)
        }
        Self.offset(material, &random)
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

    private static func metal(_ color: UIColor, roughness: Any, albedo: UIImage? = nil) -> SCNMaterial {
        let material = SCNMaterial()
        material.lightingModel = .physicallyBased
        if let albedo {
            material.diffuse.contents = albedo
            material.multiply.contents = color
        } else {
            material.diffuse.contents = color
        }
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

/// Textures generated once: wood grain (in colour and grey, for the metal chests) with its normal
/// map, worn metal, faceted crystal, light sprites and the studio environment for reflections.
private final class ChestTextures {
    static let shared = ChestTextures()

    let woodAlbedo: UIImage
    let grainGray: UIImage
    let woodNormal: UIImage
    let metalAlbedo: UIImage
    let metalRoughness: UIImage
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
        (woodAlbedo, grainGray, woodNormal) = Self.makeWood()
        (metalAlbedo, metalRoughness) = Self.makeMetal()
        (crystalAlbedo, crystalNormal) = Self.makeCrystal()
        dot = Self.radial(size: 64, color: (1, 1, 1), power: 2.2, alpha: 1)
        glow = Self.radial(size: 128, color: (1, 1, 1), power: 1.6, alpha: 1)
        contactShadow = Self.radial(size: 128, color: (0, 0, 0), power: 1.4, alpha: 0.55)
        beam = Self.makeBeam()
        seam = Self.makeSeam()
        ring = Self.makeRing()
        environment = Self.makeEnvironment()
    }

    /// Wood planks: growth rings warped by noise, fine fibres along the grain, broad tone changes.
    private static func makeWood() -> (UIImage, UIImage, UIImage) {
        let width = 512, height = 256
        var heights = [Double](repeating: 0, count: width * height)
        var tones = [Double](repeating: 0, count: width * height)
        let light = (0.64, 0.39, 0.2), dark = (0.29, 0.14, 0.065)
        let albedo = pixels(width: width, height: height) { x, y in
            let u = Double(x) / Double(width), v = Double(y) / Double(height)
            let warp = Noise.fbm(u * 3, v * 2, octaves: 3, seed: 1)
            let rings = v * 9 + warp * 2.2 + 0.4 * Noise.value(u * 1.5, v * 0.5, seed: 9)
            let line = pow(0.5 + 0.5 * sin(rings * 2 * .pi), 6)
            let fiber = Noise.value(u * 10, v * 140, seed: 3)
            let tone = Noise.fbm(u * 2.5, v * 1.2, octaves: 3, seed: 5)
            let t = min(1, max(0, 0.66 + 0.4 * (tone - 0.5) - 0.42 * line - 0.2 * fiber))
            heights[y * width + x] = 1 - 0.65 * line - 0.35 * fiber
            tones[y * width + x] = t
            return (dark.0 + (light.0 - dark.0) * t, dark.1 + (light.1 - dark.1) * t, dark.2 + (light.2 - dark.2) * t, 1)
        }
        let gray = pixels(width: width, height: height) { x, y in
            let value = 0.62 + 0.4 * tones[y * width + x]
            return (value, value, value, 1)
        }
        let normal = normalMap(heights, width: width, height: height, strength: 2.5)
        return (albedo, gray, normal)
    }

    /// Worn metal: light brightness blotches (multiplied by each metal's colour) and uneven roughness.
    private static func makeMetal() -> (UIImage, UIImage) {
        let size = 128
        let albedo = pixels(width: size, height: size) { x, y in
            let u = Double(x) / Double(size), v = Double(y) / Double(size)
            let value = 0.78 + 0.3 * Noise.fbm(u * 4, v * 4, octaves: 4, seed: 11)
            return (value, value, value, 1)
        }
        let roughness = pixels(width: size, height: size, linear: true) { x, y in
            let u = Double(x) / Double(size), v = Double(y) / Double(size)
            let value = 0.24 + 0.26 * Noise.fbm(u * 5, v * 5, octaves: 4, seed: 17)
            return (value, value, value, 1)
        }
        return (albedo, roughness)
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
            let r: Double = 0.2 * cell.tone
            let g: Double = 0.55 * cell.tone
            let b: Double = 0.95 * min(1, cell.tone)
            return (r + (0.85 - r) * e, g + (0.95 - g) * e, b + (1 - b) * e, 1)
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
        // Split into small typed steps: as one expression it took the compiler too long to type-check
        return pixels(width: width, height: height) { (x: Int, y: Int) -> (Double, Double, Double, Double) in
            let u: Double = Double(x) / Double(width)
            let v: Double = Double(y) / Double(height)
            let turn: Double = u * 2 * Double.pi
            let wave5: Double = 0.5 + 0.5 * sin(turn * 5 + 1.3)
            let wave9: Double = 0.5 + 0.5 * sin(turn * 9 + 0.4)
            let rays: Double = 0.45 + 0.55 * wave5 * wave9
            let top: Double = 1 - smoothstep(0.94, 1, v) * 0.5
            let fade: Double = pow(v, 1.8) * top
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
            let sharp: Double = exp(-pow((d - 0.86) / 0.05, 2))
            let soft: Double = exp(-pow((d - 0.65) / 0.18, 2))
            let ring: Double = sharp + 0.3 * soft
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
