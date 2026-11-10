#if DEBUG
import SwiftUI
import UIKit

// MARK: - The weather on the glass, on its own (e2e screenshots)

/// Which weather the preview shows (runnaio://weather/<rain|snow|fog>).
struct WeatherDemoKind: Identifiable {
    let id: String
}

/// The replay's weather over a drawn map with the shared video's titles on top, without Mapbox or
/// WeatherKit: the simulator screenshots show the rain, the snow and the fog as the video has them
/// (the boxes at the bottom, and the weather going round them).
struct WeatherDemoView: View {
    let kind: String
    @Environment(\.dismiss) private var dismiss

    private var overlay: RouteShareOverlay {
        RouteShareOverlay(
            options: RouteShareOptions(title: "Vuelta por el río", date: Date(timeIntervalSince1970: 1_793_000_000), area: 18_500),
            fraction: 0.62,
            isFinished: false,
            distance: 8_420,
            duration: 2_715,
            elevation: (0...40).map { step in
                ReplayElevationPoint(km: Double(step) * 0.21, metres: 210 + 38 * sin(Double(step) * 0.31) + 14 * sin(Double(step) * 0.9))
            },
            weatherCredit: true,
            accent: .brand,
            raisedBoxes: kind != "fog"
        )
    }

    var body: some View {
        ZStack {
            WeatherDemoGlass(kind: kind, boxes: overlay.boxLayout)
            overlay
        }
        .background(Color.black.ignoresSafeArea())
        .contentShape(Rectangle())
        .onTapGesture { dismiss() }
    }
}

private struct WeatherDemoGlass: UIViewRepresentable {
    let kind: String
    let boxes: ShareBoxLayout

    func makeUIView(context: Context) -> WeatherDemoStage {
        WeatherDemoStage(kind: kind, boxes: boxes)
    }

    func updateUIView(_ uiView: WeatherDemoStage, context: Context) {}
}

/// A drawn map with the weather's glass over it, stepped by the screen's clock.
final class WeatherDemoStage: UIView {
    private let kind: String
    private let picture = UIImageView()
    private let glass = WetGlassView()
    private var displayLink: CADisplayLink?
    private var lastTick: CFTimeInterval = 0
    private var drawnSize = CGSize.zero
    private var warmedUp = false

    init(kind: String, boxes: ShareBoxLayout) {
        self.kind = kind
        super.init(frame: .zero)
        clipsToBounds = true
        picture.contentMode = .scaleToFill
        addSubview(picture)
        addSubview(glass)
        glass.backdropView = picture
        if !boxes.isEmpty {
            glass.setShelves { size in boxes.shelves(in: size) }
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        picture.frame = bounds
        glass.frame = bounds
        if bounds.size != drawnSize, bounds.width > 1, bounds.height > 1 {
            drawnSize = bounds.size
            picture.image = Self.makePicture(size: bounds.size)
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        displayLink?.invalidate()
        displayLink = nil
        guard window != nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    @objc private func tick(_ link: CADisplayLink) {
        guard bounds.width > 1 else { return }
        if !warmedUp {
            // Well into the weather from the first frame: the screenshot doesn't depend on how fast
            // the simulator runs
            warmedUp = true
            switch kind {
            case "snow":
                glass.setWeather(.snow, level: 0.7)
            case "fog":
                glass.setWeather(.dry, level: 0, fog: 0.9)
            default:
                glass.setWeather(.rain, level: 0.75)
            }
            for _ in 0..<540 {
                glass.step(dt: 1.0 / 30)
            }
            lastTick = link.timestamp
            return
        }
        let dt = min(0.1, max(0, link.timestamp - lastTick))
        lastTick = link.timestamp
        glass.step(dt: dt)
    }

    /// Something like a satellite view: fields and blocks, a river, streets and a route.
    private static func makePicture(size: CGSize) -> UIImage {
        UIGraphicsImageRenderer(size: size).image { context in
            let cg = context.cgContext
            UIColor(red: 0.2, green: 0.29, blue: 0.19, alpha: 1).setFill()
            cg.fill(CGRect(origin: .zero, size: size))
            var seed: UInt64 = 7
            func next() -> CGFloat {
                seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
                return CGFloat((seed >> 33) % 1000) / 1000
            }
            let tones: [UIColor] = [
                UIColor(red: 0.27, green: 0.37, blue: 0.22, alpha: 1),
                UIColor(red: 0.36, green: 0.34, blue: 0.25, alpha: 1),
                UIColor(red: 0.45, green: 0.44, blue: 0.4, alpha: 1),
                UIColor(red: 0.16, green: 0.25, blue: 0.16, alpha: 1),
                UIColor(red: 0.55, green: 0.5, blue: 0.42, alpha: 1),
            ]
            for index in 0..<90 {
                tones[index % tones.count].setFill()
                let width = 24 + next() * 70
                let height = 20 + next() * 60
                cg.fill(CGRect(x: next() * size.width - 20, y: next() * size.height - 20, width: width, height: height))
            }
            // The river
            let river = UIBezierPath()
            river.move(to: CGPoint(x: -20, y: size.height * 0.2))
            river.addCurve(
                to: CGPoint(x: size.width + 20, y: size.height * 0.62),
                controlPoint1: CGPoint(x: size.width * 0.5, y: size.height * 0.1),
                controlPoint2: CGPoint(x: size.width * 0.4, y: size.height * 0.7)
            )
            UIColor(red: 0.16, green: 0.3, blue: 0.4, alpha: 1).setStroke()
            river.lineWidth = 34
            river.stroke()
            // Streets
            UIColor(white: 0.8, alpha: 0.75).setStroke()
            for index in 0..<9 {
                let street = UIBezierPath()
                let offset = CGFloat(index) * size.height / 7
                street.move(to: CGPoint(x: -10, y: offset - 60))
                street.addLine(to: CGPoint(x: size.width + 10, y: offset + 50))
                street.lineWidth = index % 3 == 0 ? 4 : 2
                street.stroke()
                let cross = UIBezierPath()
                let across = CGFloat(index) * size.width / 6
                cross.move(to: CGPoint(x: across + 30, y: -10))
                cross.addLine(to: CGPoint(x: across - 50, y: size.height + 10))
                cross.lineWidth = 2
                cross.stroke()
            }
            // The route: white casing under the runner's colour
            let route = UIBezierPath()
            route.move(to: CGPoint(x: size.width * 0.2, y: size.height * 0.72))
            route.addCurve(
                to: CGPoint(x: size.width * 0.7, y: size.height * 0.3),
                controlPoint1: CGPoint(x: size.width * 0.1, y: size.height * 0.4),
                controlPoint2: CGPoint(x: size.width * 0.5, y: size.height * 0.2)
            )
            route.addCurve(
                to: CGPoint(x: size.width * 0.55, y: size.height * 0.6),
                controlPoint1: CGPoint(x: size.width * 0.95, y: size.height * 0.42),
                controlPoint2: CGPoint(x: size.width * 0.8, y: size.height * 0.62)
            )
            route.lineCapStyle = .round
            route.lineJoinStyle = .round
            UIColor.white.setStroke()
            route.lineWidth = 7
            route.stroke()
            UIColor(Color.brand).setStroke()
            route.lineWidth = 4.5
            route.stroke()
        }
    }
}
#endif
