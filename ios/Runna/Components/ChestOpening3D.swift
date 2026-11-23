import SceneKit
import SwiftUI
import UIKit

/// The common chest opening, in real 3D (SceneKit): the chest drops in, the lid strains against the
/// padlock, the shackle pops, the padlock falls to the floor and the lid swings open on its hinge;
/// warm light pours out of the coins inside with a beam and rising motes. The model and its textures
/// (wood grain, copper, gold) are generated in code to match the illustrated `chest_common`.
/// Tapping skips to the open chest. With Reduce Motion the lid just opens.
/// `onOpened` is called once, when the lid is open (or the animation was skipped).
struct ChestOpening3DView: View {
    let onOpened: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var director = ChestOpeningDirector()

    var body: some View {
        ChestSceneView(director: director, reduceMotion: reduceMotion, onOpened: onOpened)
            .contentShape(Rectangle())
            .onTapGesture { director.skip() }
            .accessibilityElement()
            .accessibilityLabel("Abriendo el cofre")
            .accessibilityAction(named: "Abrir ya") { director.skip() }
    }

    /// Builds the textures ahead of time (in the background) so the first opening doesn't stutter.
    static func prewarm() {
        DispatchQueue.global(qos: .utility).async { _ = ChestTextures.shared }
    }
}

private struct ChestSceneView: UIViewRepresentable {
    let director: ChestOpeningDirector
    let reduceMotion: Bool
    let onOpened: () -> Void

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView(frame: .zero)
        director.attach(to: view, reduceMotion: reduceMotion, onOpened: onOpened)
        return view
    }

    func updateUIView(_ uiView: SCNView, context: Context) {}

    static func dismantleUIView(_ uiView: SCNView, coordinator: ()) {
        uiView.isPlaying = false
        uiView.scene = nil
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
    private let glow = SCNNode()
    private let beam = SCNNode()
    private let motes = SCNNode()
    private let cameraNode = SCNNode()
    private let cameraTarget = SCNNode()

    private var built = false
    private var finished = false
    private var motesStarted = false
    private var calm = false
    private var onOpened: (() -> Void)?

    private let thud = UIImpactFeedbackGenerator(style: .medium)
    private let knock = UIImpactFeedbackGenerator(style: .rigid)
    private let clink = UIImpactFeedbackGenerator(style: .light)

    private static let cameraStart = SCNVector3(1.5, 2.05, 4.0)
    private static let cameraMid = SCNVector3(1.15, 1.7, 3.2)
    private static let cameraEnd = SCNVector3(1.0, 1.85, 2.9)
    private static let targetStart = SCNVector3(0, 0.35, 0)
    private static let targetEnd = SCNVector3(0, 0.05, 0)

    func attach(to view: SCNView, reduceMotion: Bool, onOpened: @escaping () -> Void) {
        self.onOpened = onOpened
        if !built {
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
        [thud, knock, clink].forEach { $0.prepare() }
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

        ChestScene.addLights(to: root)

        // Camera, always looking at a target node that moves with the shot
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
        camera.bloomIntensity = 0.7
        camera.bloomThreshold = 0.85
        camera.bloomBlurRadius = 14
        camera.vignettingPower = 0.8
        camera.vignettingIntensity = 1.2
        camera.screenSpaceAmbientOcclusionIntensity = 0.9
        camera.screenSpaceAmbientOcclusionRadius = 0.12
        cameraNode.camera = camera
        cameraNode.position = Self.cameraStart
        let lookAt = SCNLookAtConstraint(target: cameraTarget)
        lookAt.isGimbalLockEnabled = true
        cameraNode.constraints = [lookAt]
        root.addChildNode(cameraNode)

        // The chest
        root.addChildNode(chestRoot)
        ChestModel.buildBase(into: chestRoot)
        ChestModel.buildTreasure(into: chestRoot)
        lidPivot.position = SCNVector3(0, Float(Dim.height), -Float(Dim.depth / 2))
        chestRoot.addChildNode(lidPivot)
        ChestModel.buildLid(into: lidPivot)
        padlock.position = Dim.padlockHang
        chestRoot.addChildNode(padlock)
        ChestModel.buildPadlock(into: padlock, shackle: shackle)

        // Light from inside: a warm omni light, a glow over the coins and a beam of light
        let light = SCNLight()
        light.type = .omni
        light.color = UIColor(red: 1, green: 0.76, blue: 0.42, alpha: 1)
        light.intensity = 0
        light.attenuationStartDistance = 0
        light.attenuationEndDistance = 1.7
        light.attenuationFalloffExponent = 2
        innerLight.light = light
        innerLight.position = SCNVector3(0, 0.36, 0)
        chestRoot.addChildNode(innerLight)

        let glowPlane = SCNPlane(width: Dim.width - 2 * Dim.plank - 0.04, height: Dim.depth - 2 * Dim.plank - 0.04)
        glowPlane.materials = [ChestScene.decal(textures.glow, add: true, intensity: 1.3)]
        glow.geometry = glowPlane
        glow.eulerAngles.x = -.pi / 2
        glow.position.y = 0.36
        glow.opacity = 0
        glow.renderingOrder = 10
        chestRoot.addChildNode(glow)

        let cone = SCNCone(topRadius: 0.62, bottomRadius: 0.36, height: 1.15)
        cone.radialSegmentCount = 48
        let invisible = SCNMaterial()
        invisible.transparency = 0
        invisible.writesToDepthBuffer = false
        cone.materials = [ChestScene.decal(textures.beam, add: true, intensity: 1.5), invisible, invisible]
        let spinning = SCNNode(geometry: cone)
        spinning.runAction(.repeatForever(.rotateBy(x: 0, y: .pi * 2, z: 0, duration: 26)))
        beam.addChildNode(spinning)
        // Stretched to the chest's opening (the spinning child keeps the rays turning inside)
        beam.scale = SCNVector3(1.4, 1, 0.92)
        beam.position.y = Float(Dim.height) - 0.03 + 0.575
        beam.opacity = 0
        beam.renderingOrder = 11
        chestRoot.addChildNode(beam)

        motes.position.y = 0.4
        chestRoot.addChildNode(motes)
    }

    // MARK: Playing

    private func play() {
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
            self.thud.impactOccurred(intensity: 0.9)
            self.puffDust(at: SCNVector3(0, 0.01, 0), spread: SCNVector3(Float(Dim.width) + 0.1, 0.01, Float(Dim.depth) + 0.1), amount: 1)
        }

        // Slow dolly in, then a second push once it opens
        cameraNode.runAction(.sequence([
            .move(to: Self.cameraMid, duration: 2.0).timed(Ease.inOut),
            .move(to: Self.cameraEnd, duration: 1.3).timed(Ease.inOut)
        ]))
        cameraTarget.runAction(.sequence([
            .wait(duration: 1.6),
            .move(to: Self.targetEnd, duration: 1.7).timed(Ease.inOut)
        ]))

        // 2. The lid strains against the padlock three times (0.65 – 1.3 s)
        let strain = 0.65
        lidPivot.runAction(.sequence([
            .wait(duration: strain),
            Self.lidKnock(lift: 0.06, up: 0.07, down: 0.08),
            .wait(duration: 0.12),
            Self.lidKnock(lift: 0.085, up: 0.07, down: 0.08),
            .wait(duration: 0.1),
            Self.lidKnock(lift: 0.05, up: 0.06, down: 0.07)
        ]))
        for (time, side) in [(0.0, 1.0), (0.27, -1.0), (0.52, 1.0)] {
            chestRoot.runAction(.sequence([
                .wait(duration: strain + time),
                .rotateBy(x: 0, y: 0, z: CGFloat(0.018 * side), duration: 0.07).timed(Ease.outQuad),
                .rotateBy(x: 0, y: 0, z: CGFloat(-0.018 * side), duration: 0.12).timed(Ease.inOut)
            ]))
        }
        for (time, intensity) in [(0.15, 0.7), (0.42, 0.85), (0.65, 0.6)] {
            event(at: strain + time) { [weak self] in self?.knock.impactOccurred(intensity: intensity) }
        }
        // The padlock swings on the hasp
        padlock.runAction(.sequence([
            .wait(duration: strain + 0.08),
            .sequence([0.22, -0.17, 0.12, -0.08, 0.04, 0].map { angle in
                SCNAction.rotateTo(x: 0, y: 0, z: CGFloat(angle), duration: 0.11).timed(Ease.inOut)
            })
        ]))

        // 3. The shackle pops and the padlock falls to the floor (1.45 – 2.0 s)
        let unlock = 1.45
        shackle.runAction(.sequence([
            .wait(duration: unlock),
            .moveBy(x: 0, y: 0.03, z: 0, duration: 0.07).timed(Ease.outQuad)
        ]))
        event(at: unlock) { [weak self] in self?.knock.impactOccurred(intensity: 1) }
        let fall = unlock + 0.12
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
            self.clink.impactOccurred(intensity: 0.8)
            self.puffDust(at: landing, spread: SCNVector3(0.18, 0.01, 0.22), amount: 0.35)
        }

        // 4. The lid swings open, falls back past vertical, hits its stop and settles (1.72 – 2.7 s)
        let open = 1.72
        lidPivot.runAction(.sequence([
            .wait(duration: open),
            .rotateTo(x: -1.05, y: 0, z: 0, duration: 0.42).timed(Ease.outCubic),
            .rotateTo(x: -1.96, y: 0, z: 0, duration: 0.3).timed(Ease.inQuad),
            .rotateTo(x: -1.76, y: 0, z: 0, duration: 0.12).timed(Ease.outQuad),
            .rotateTo(x: CGFloat(Dim.openAngle), y: 0, z: 0, duration: 0.15).timed(Ease.inQuad)
        ]))
        chestRoot.runAction(.sequence([
            .wait(duration: open + 0.72),
            .rotateBy(x: -0.02, y: 0, z: 0, duration: 0.06).timed(Ease.outQuad),
            .rotateBy(x: 0.02, y: 0, z: 0, duration: 0.14).timed(Ease.inOut)
        ]))
        event(at: open + 0.72) { [weak self] in self?.thud.impactOccurred(intensity: 0.75) }
        event(at: open + 0.99) { [weak self] in self?.clink.impactOccurred(intensity: 0.4) }

        // 5. Light pours out
        innerLight.runAction(.sequence([.wait(duration: open + 0.05), Self.lightRamp(duration: 0.7)]))
        glow.runAction(.sequence([.wait(duration: open + 0.1), .fadeOpacity(to: 0.85, duration: 0.6)]))
        beam.runAction(.sequence([.wait(duration: open + 0.2), .fadeOpacity(to: 0.8, duration: 0.8).timed(Ease.outQuad)]))
        event(at: open + 0.22) { [weak self] in self?.burstSparks() }
        event(at: open + 0.3) { [weak self] in self?.startMotes() }

        // 6. Done
        event(at: open + 0.95) { [weak self] in self?.finish() }
    }

    /// Reduce Motion: the chest is already in place; the padlock fades and the lid opens.
    private func playCalm() {
        cameraNode.position = Self.cameraEnd
        cameraTarget.position = Self.targetEnd
        padlock.runAction(.sequence([.wait(duration: 0.2), .fadeOut(duration: 0.25)]))
        lidPivot.runAction(.sequence([
            .wait(duration: 0.4),
            .rotateTo(x: CGFloat(Dim.openAngle), y: 0, z: 0, duration: 0.8).timed(Ease.inOut)
        ]))
        innerLight.runAction(.sequence([.wait(duration: 0.5), Self.lightRamp(duration: 0.6)]))
        glow.runAction(.sequence([.wait(duration: 0.5), .fadeOpacity(to: 0.85, duration: 0.6)]))
        beam.runAction(.sequence([.wait(duration: 0.6), .fadeOpacity(to: 0.8, duration: 0.6)]))
        event(at: 1.3) { [weak self] in self?.finish() }
    }

    /// Jumps to the open chest.
    func skip() {
        guard built, !finished else { return }
        for node in [events, chestRoot, lidPivot, padlock, shackle, innerLight, glow, beam, cameraNode, cameraTarget] {
            node.removeAllActions()
        }
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
        innerLight.light?.intensity = ChestScene.innerLightIntensity
        glow.opacity = 0.85
        beam.opacity = 0.8
        cameraNode.position = Self.cameraEnd
        cameraTarget.position = Self.targetEnd
        SCNTransaction.commit()
        startMotes()
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

    nonisolated private static func lidKnock(lift: CGFloat, up: TimeInterval, down: TimeInterval) -> SCNAction {
        .sequence([
            .rotateTo(x: -lift, y: 0, z: 0, duration: up).timed(Ease.outQuad),
            .rotateTo(x: 0, y: 0, z: 0, duration: down).timed(Ease.inQuad)
        ])
    }

    nonisolated private static func lightRamp(duration: TimeInterval) -> SCNAction {
        .customAction(duration: duration) { node, elapsed in
            let progress = Float(min(1, elapsed / CGFloat(duration)))
            node.light?.intensity = ChestScene.innerLightIntensity * CGFloat(Ease.outCubic(progress))
        }
    }

    private func puffDust(at position: SCNVector3, spread: SCNVector3, amount: CGFloat) {
        let node = SCNNode()
        node.position = position
        scene.rootNode.addChildNode(node)
        node.addParticleSystem(ChestParticles.dust(spread: spread, amount: amount))
        node.runAction(.sequence([.wait(duration: 2), .removeFromParentNode()]))
    }

    private func burstSparks() {
        motes.addParticleSystem(ChestParticles.sparks())
    }

    private func startMotes() {
        guard !motesStarted else { return }
        motesStarted = true
        motes.addParticleSystem(ChestParticles.motes())
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
    static let innerLightIntensity: CGFloat = 750

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

    private static func lightNode(_ light: SCNLight, at position: SCNVector3) -> SCNNode {
        let node = SCNNode()
        node.light = light
        node.position = position
        node.look(at: SCNVector3(0, 0.3, 0))
        return node
    }

    /// Unlit, see-through material for glows (added as light) and decals.
    static func decal(_ image: UIImage, add: Bool, intensity: CGFloat = 1) -> SCNMaterial {
        let material = SCNMaterial()
        material.lightingModel = .constant
        material.diffuse.contents = image
        material.diffuse.intensity = intensity
        material.isDoubleSided = true
        material.writesToDepthBuffer = false
        material.blendMode = add ? .add : .alpha
        return material
    }
}

// MARK: - Model

private enum ChestModel {
    private static let materials = ChestMaterials()

    static func buildBase(into parent: SCNNode) {
        let width = Dim.width, height = Dim.height, depth = Dim.depth, plank = Dim.plank
        var random = SeededRandom(seed: 7)
        let rowHeight = height / 3

        // Walls: three horizontal planks per side, each a slightly different shade
        for row in 0..<3 {
            let y = Float(rowHeight * (CGFloat(row) + 0.5))
            for side in [Float(1), -1] {
                let front = box(width, rowHeight - 0.006, plank, chamfer: 0.01, materials.wood(&random))
                front.position = SCNVector3(0, y, side * Float(depth / 2 - plank / 2))
                parent.addChildNode(front)
                let end = box(plank, rowHeight - 0.006, depth - 2 * plank, chamfer: 0.01, materials.wood(&random))
                end.position = SCNVector3(side * Float(width / 2 - plank / 2), y, 0)
                parent.addChildNode(end)
            }
        }
        let bottom = box(width - 2 * plank, 0.03, depth - 2 * plank, chamfer: 0.004, materials.wood(&random, shade: 0.5))
        bottom.position.y = 0.05
        parent.addChildNode(bottom)

        // Copper corner brackets with rivets
        let post: CGFloat = 0.1, stick: CGFloat = 0.012
        for sx in [Float(1), -1] {
            for sz in [Float(1), -1] {
                let corner = box(post, height + 0.012, post, chamfer: 0.012, materials.copper)
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

        // Copper bands along the top and bottom edges
        for y in [Float(height) - 0.03, 0.045] {
            for side in [Float(1), -1] {
                let long = box(width - 0.2, 0.05, 0.016, chamfer: 0.004, materials.copper)
                long.position = SCNVector3(0, y, side * Float(depth / 2 + 0.004))
                parent.addChildNode(long)
                let short = box(0.016, 0.05, depth - 0.2, chamfer: 0.004, materials.copper)
                short.position = SCNVector3(side * Float(width / 2 + 0.004), y, 0)
                parent.addChildNode(short)
            }
            for x in [Float(-0.33), -0.18, 0.18, 0.33] {
                parent.addChildNode(rivet(at: SCNVector3(x, y, Float(depth / 2) + 0.012)))
            }
        }

        // Lock plate behind the padlock
        let plate = box(0.17, 0.22, 0.016, chamfer: 0.004, materials.copper)
        plate.position = SCNVector3(0, Float(height) - 0.14, Float(depth / 2) + 0.008)
        parent.addChildNode(plate)
        for (x, y) in [(-0.065, -0.05), (0.065, -0.05), (-0.065, -0.23), (0.065, -0.23)] {
            parent.addChildNode(rivet(at: SCNVector3(Float(x), Float(height) + Float(y), Float(depth / 2) + 0.016), radius: 0.011))
        }
    }

    /// A heap of gold coins inside.
    static func buildTreasure(into parent: SCNNode) {
        let heap = SCNSphere(radius: 1)
        heap.segmentCount = 32
        heap.materials = [materials.heap]
        let heapNode = SCNNode(geometry: heap)
        let heapSize = SCNVector3(0.42, 0.19, 0.24)
        heapNode.scale = heapSize
        heapNode.position.y = 0.07
        parent.addChildNode(heapNode)

        let coin = SCNCylinder(radius: 0.034, height: 0.008)
        coin.radialSegmentCount = 28
        coin.materials = [materials.gold]
        var random = SeededRandom(seed: 21)
        let halfX = Float(Dim.width / 2 - Dim.plank) - 0.04
        let halfZ = Float(Dim.depth / 2 - Dim.plank) - 0.04
        for _ in 0..<60 {
            let x = random.next(in: -halfX...halfX)
            let z = random.next(in: -halfZ...halfZ)
            let inside = 1 - pow(x / heapSize.x, 2) - pow(z / heapSize.z, 2)
            let node = SCNNode(geometry: coin)
            node.position = SCNVector3(x, 0.07 + heapSize.y * sqrt(max(0, inside)) + 0.004, z)
            node.eulerAngles = SCNVector3(random.next(in: -0.4...0.4), random.next(in: 0...3), random.next(in: -0.4...0.4))
            parent.addChildNode(node)
        }
    }

    /// The domed lid. `pivot` sits on the back hinge; the lid's axis is half a depth in front of it.
    static func buildLid(into pivot: SCNNode) {
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
            let stave = box(width - 0.01, plank, chord, chamfer: 0.008, materials.wood(&random))
            let middle = Float(radius - plank / 2)
            stave.position = SCNVector3(0, middle * sin(angle), middle * cos(angle))
            stave.eulerAngles.x = .pi / 2 - angle
            lid.addChildNode(stave)
        }

        // Wooden ends and copper arches over them
        for side in [Float(1), -1] {
            let end = arch(outer: radius - plank + 0.004, inner: 0, thickness: 0.03, materials.wood(&random, shade: 0.85))
            end.position.x = side * Float(width / 2 - 0.02)
            lid.addChildNode(end)

            let band = arch(outer: radius + 0.016, inner: radius - plank - 0.005, thickness: 0.07, materials.copper)
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
            let edge = box(width - 0.16, 0.05, 0.016, chamfer: 0.004, materials.copper)
            edge.position = SCNVector3(0, 0.03, side * Float(radius + 0.004))
            lid.addChildNode(edge)
        }

        // Hasp hanging over the lock plate, with the staple the padlock goes through
        let hasp = box(0.11, 0.17, 0.014, chamfer: 0.005, materials.copper)
        hasp.position = SCNVector3(0, -0.045, Float(radius) + 0.024)
        lid.addChildNode(hasp)
        lid.addChildNode(rivet(at: SCNVector3(0, 0.015, Float(radius) + 0.031), radius: 0.012))
        let staple = SCNTorus(ringRadius: 0.022, pipeRadius: 0.007)
        staple.ringSegmentCount = 32
        staple.pipeSegmentCount = 12
        staple.materials = [materials.copper]
        let stapleNode = SCNNode(geometry: staple)
        stapleNode.eulerAngles.z = .pi / 2
        let hang = Dim.padlockHang
        stapleNode.position = SCNVector3(0, hang.y - Float(Dim.height) + 0.002, hang.z)
        lid.addChildNode(stapleNode)
    }

    /// The padlock. Its origin is the top of the shackle, where it hangs from the staple.
    static func buildPadlock(into node: SCNNode, shackle: SCNNode) {
        let ring = SCNTorus(ringRadius: 0.042, pipeRadius: 0.011)
        ring.ringSegmentCount = 48
        ring.pipeSegmentCount = 16
        ring.materials = [materials.steel]
        shackle.geometry = ring
        shackle.eulerAngles.x = .pi / 2
        shackle.position.y = -0.042
        node.addChildNode(shackle)

        let body = box(0.13, 0.12, 0.05, chamfer: 0.016, materials.brass)
        body.position.y = -0.042 - 0.06
        node.addChildNode(body)

        let keyhole = SCNCylinder(radius: 0.011, height: 0.004)
        keyhole.materials = [materials.iron]
        let hole = SCNNode(geometry: keyhole)
        hole.eulerAngles.x = .pi / 2
        hole.position = SCNVector3(0, -0.092, 0.0255)
        node.addChildNode(hole)
        let slot = box(0.007, 0.026, 0.004, chamfer: 0, materials.iron)
        slot.position = SCNVector3(0, -0.108, 0.0255)
        node.addChildNode(slot)
    }

    // MARK: Shapes

    private static func box(_ width: CGFloat, _ height: CGFloat, _ length: CGFloat, chamfer: CGFloat, _ material: SCNMaterial) -> SCNNode {
        let geometry = SCNBox(width: width, height: height, length: length, chamferRadius: chamfer)
        geometry.chamferSegmentCount = 3
        geometry.materials = [material]
        return SCNNode(geometry: geometry)
    }

    private static let rivetGeometry: SCNSphere = {
        let sphere = SCNSphere(radius: 0.016)
        sphere.segmentCount = 14
        sphere.materials = [ChestModel.materials.copperBright]
        return sphere
    }()

    private static func rivet(at position: SCNVector3, radius: CGFloat = 0.016) -> SCNNode {
        let geometry: SCNGeometry
        if radius == 0.016 {
            geometry = rivetGeometry
        } else {
            let sphere = SCNSphere(radius: radius)
            sphere.segmentCount = 14
            sphere.materials = [materials.copperBright]
            geometry = sphere
        }
        let node = SCNNode(geometry: geometry)
        node.position = position
        return node
    }

    /// A half disc (inner 0) or half ring standing in the y-z plane, `thickness` wide along x.
    private static func arch(outer: CGFloat, inner: CGFloat, thickness: CGFloat, _ material: SCNMaterial) -> SCNNode {
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
    let copper: SCNMaterial
    let copperBright: SCNMaterial
    let brass: SCNMaterial
    let steel: SCNMaterial
    let iron: SCNMaterial
    let gold: SCNMaterial
    let heap: SCNMaterial

    init() {
        let textures = ChestTextures.shared
        copper = Self.metal(color: UIColor(red: 0.80, green: 0.46, blue: 0.26, alpha: 1), roughness: textures.metalRoughness, albedo: textures.metalAlbedo)
        copperBright = Self.metal(color: UIColor(red: 0.93, green: 0.6, blue: 0.36, alpha: 1), roughness: 0.28)
        brass = Self.metal(color: UIColor(red: 0.86, green: 0.62, blue: 0.3, alpha: 1), roughness: textures.metalRoughness, albedo: textures.metalAlbedo)
        steel = Self.metal(color: UIColor(red: 0.72, green: 0.66, blue: 0.6, alpha: 1), roughness: 0.3)
        iron = Self.metal(color: UIColor(white: 0.05, alpha: 1), roughness: 0.7)
        gold = Self.metal(color: UIColor(red: 1, green: 0.78, blue: 0.34, alpha: 1), roughness: 0.22)
        heap = Self.metal(color: UIColor(red: 0.85, green: 0.62, blue: 0.24, alpha: 1), roughness: 0.42)
        heap.normal.contents = textures.woodNormal
        heap.normal.intensity = 0.6
    }

    /// Wood with its grain. Each plank shows a different part of the texture and a slightly
    /// different shade, so no two look the same.
    func wood(_ random: inout SeededRandom, shade: CGFloat = 1) -> SCNMaterial {
        let textures = ChestTextures.shared
        let material = SCNMaterial()
        material.lightingModel = .physicallyBased
        material.diffuse.contents = textures.woodAlbedo
        material.normal.contents = textures.woodNormal
        material.normal.intensity = 0.9
        material.roughness.contents = NSNumber(value: 0.7)
        material.metalness.contents = NSNumber(value: 0)
        let tone = shade * CGFloat(random.next(in: 0.82...1))
        material.multiply.contents = UIColor(white: tone, alpha: 1)
        let scale: Float = 0.55
        let transform = SCNMatrix4Mult(
            SCNMatrix4MakeScale(scale, scale, 1),
            SCNMatrix4MakeTranslation(random.next(in: 0...0.45), random.next(in: 0...0.45), 0)
        )
        material.diffuse.contentsTransform = transform
        material.normal.contentsTransform = transform
        return material
    }

    private static func metal(color: UIColor, roughness: Any, albedo: UIImage? = nil) -> SCNMaterial {
        let material = SCNMaterial()
        material.lightingModel = .physicallyBased
        if let albedo {
            material.diffuse.contents = albedo
            material.multiply.contents = color
        } else {
            material.diffuse.contents = color
        }
        material.metalness.contents = NSNumber(value: 1)
        if let number = roughness as? Double {
            material.roughness.contents = NSNumber(value: number)
        } else {
            material.roughness.contents = roughness
        }
        return material
    }
}

// MARK: - Particles

private enum ChestParticles {
    /// Golden motes drifting up out of the chest, for as long as it's on screen.
    static func motes() -> SCNParticleSystem {
        let system = SCNParticleSystem()
        system.particleImage = ChestTextures.shared.dot
        system.emitterShape = SCNBox(width: Dim.width - 2 * Dim.plank - 0.1, height: 0.02, length: Dim.depth - 2 * Dim.plank - 0.1, chamferRadius: 0)
        system.birthLocation = .volume
        system.birthRate = 36
        system.particleLifeSpan = 2
        system.particleLifeSpanVariation = 0.7
        system.emittingDirection = SCNVector3(0, 1, 0)
        system.spreadingAngle = 18
        system.particleVelocity = 0.28
        system.particleVelocityVariation = 0.15
        system.acceleration = SCNVector3(0, 0.04, 0)
        system.particleSize = 0.011
        system.particleSizeVariation = 0.007
        system.particleColor = UIColor(red: 1, green: 0.82, blue: 0.5, alpha: 1)
        system.particleColorVariation = SCNVector4(0.04, 0.1, 0.1, 0)
        system.particleIntensity = 2.2
        system.blendMode = .additive
        system.isLightingEnabled = false
        system.propertyControllers = [.opacity: fade(peak: 0.2)]
        return system
    }

    /// A burst of sparks when the lid flies open.
    static func sparks() -> SCNParticleSystem {
        let system = motes()
        system.loops = false
        system.birthRate = 900
        system.emissionDuration = 0.08
        system.particleLifeSpan = 1.3
        system.particleLifeSpanVariation = 0.4
        system.spreadingAngle = 35
        system.particleVelocity = 1.0
        system.particleVelocityVariation = 0.4
        system.acceleration = SCNVector3(0, -0.7, 0)
        system.dampingFactor = 1.4
        system.particleSize = 0.008
        system.particleIntensity = 3
        system.propertyControllers = [.opacity: fade(peak: 0.05)]
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
        system.propertyControllers = [.opacity: fade(peak: 0.1), .size: grow()]
        return system
    }

    private static func fade(peak: Double) -> SCNParticlePropertyController {
        let animation = CAKeyframeAnimation()
        animation.values = [0, 1, 0]
        animation.keyTimes = [0, NSNumber(value: peak), 1]
        return SCNParticlePropertyController(animation: animation)
    }

    private static func grow() -> SCNParticlePropertyController {
        let animation = CAKeyframeAnimation()
        animation.values = [0.6, 2.6]
        animation.keyTimes = [0, 1]
        return SCNParticlePropertyController(animation: animation)
    }
}

// MARK: - Procedural textures

/// Textures generated once (wood grain with its normal map, worn metal, light sprites and the
/// studio environment for reflections).
private final class ChestTextures {
    static let shared = ChestTextures()

    let woodAlbedo: UIImage
    let woodNormal: UIImage
    let metalAlbedo: UIImage
    let metalRoughness: UIImage
    let dot: UIImage
    let glow: UIImage
    let beam: UIImage
    let contactShadow: UIImage
    let environment: UIImage

    private init() {
        (woodAlbedo, woodNormal) = Self.makeWood()
        (metalAlbedo, metalRoughness) = Self.makeMetal()
        dot = Self.radial(size: 64, color: (1, 1, 1), power: 2.2, alpha: 1)
        glow = Self.radial(size: 128, color: (1, 0.78, 0.45), power: 1.6, alpha: 1)
        contactShadow = Self.radial(size: 128, color: (0, 0, 0), power: 1.4, alpha: 0.55)
        beam = Self.makeBeam()
        environment = Self.makeEnvironment()
    }

    /// Wood planks: growth rings warped by noise, fine fibres along the grain, broad tone changes.
    private static func makeWood() -> (UIImage, UIImage) {
        let width = 512, height = 256
        var heights = [Double](repeating: 0, count: width * height)
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
            return (dark.0 + (light.0 - dark.0) * t, dark.1 + (light.1 - dark.1) * t, dark.2 + (light.2 - dark.2) * t, 1)
        }
        let normal = normalMap(heights, width: width, height: height, strength: 2.5)
        return (albedo, normal)
    }

    /// Worn metal: light brightness blotches (multiplied by each metal's colour) and uneven roughness.
    private static func makeMetal() -> (UIImage, UIImage) {
        let size = 128
        let albedo = pixels(width: size, height: size) { x, y in
            let u = Double(x) / Double(size), v = Double(y) / Double(size)
            let wear = Noise.fbm(u * 4, v * 4, octaves: 4, seed: 11)
            let value = 0.78 + 0.3 * wear
            return (value, value, value, 1)
        }
        let roughness = pixels(width: size, height: size, linear: true) { x, y in
            let u = Double(x) / Double(size), v = Double(y) / Double(size)
            let value = 0.24 + 0.26 * Noise.fbm(u * 5, v * 5, octaves: 4, seed: 17)
            return (value, value, value, 1)
        }
        return (albedo, roughness)
    }

    /// Light beam: bright at the bottom, fading up, with soft rays around (seamless around the cone).
    private static func makeBeam() -> UIImage {
        let width = 256, height = 256
        return pixels(width: width, height: height) { x, y in
            let u = Double(x) / Double(width), v = Double(y) / Double(height)
            let rays = 0.45 + 0.55 * (0.5 + 0.5 * sin(u * 2 * .pi * 5 + 1.3)) * (0.5 + 0.5 * sin(u * 2 * .pi * 9 + 0.4))
            let fade = pow(v, 1.8) * (1 - smoothstep(0.94, 1, v) * 0.5)
            let a = min(1, fade * rays * 0.75)
            return (1, 0.8, 0.48, a)
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
            let a = pow(max(0, 1 - sqrt(dx * dx + dy * dy)), power) * alpha
            return (color.0, color.1, color.2, a)
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

/// Deterministic random numbers, so the chest looks the same every time.
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

// MARK: - Preview

private struct ChestOpeningPreview: View {
    @State private var run = 0
    @State private var opened = false

    var body: some View {
        ChestOpening3DView { opened = true }
            .id(run)
            .ignoresSafeArea()
            .overlay(alignment: .bottom) {
                Button(opened ? "Repetir" : "Abriendo…") {
                    opened = false
                    run += 1
                }
                .buttonStyle(.borderedProminent)
                .padding(40)
            }
    }
}

#Preview("Apertura cofre común") {
    ChestOpeningPreview()
}
