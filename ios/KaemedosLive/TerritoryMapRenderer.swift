import MapKit
import UIKit

/// Draws a world map for a widget: a dark, muted Apple map, my territory in my colour over it and
/// my friends' and club mates' fainter around it, with a shade where the text goes. Without the map
/// (no network, or for the placeholder) the territories are drawn on black with a faint grid.
enum TerritoryMapRenderer {
    /// Where the text sits over the map: the territory is framed in the rest.
    enum Layout {
        /// Text along the bottom (small widget).
        case bottom
        /// Text on the left (medium widget).
        case left
        /// Text under the map (large widget).
        case top

        /// The part of the image (0...1) the territory is fitted into.
        var focus: CGRect {
            switch self {
            case .bottom: return CGRect(x: 0.1, y: 0.07, width: 0.8, height: 0.52)
            case .left: return CGRect(x: 0.46, y: 0.1, width: 0.5, height: 0.8)
            case .top: return CGRect(x: 0.08, y: 0.08, width: 0.84, height: 0.78)
            }
        }
    }

    static func render(_ map: WidgetDetails.MapData, size: CGSize, scale: CGFloat, layout: Layout) async -> UIImage? {
        guard size.width > 1, size.height > 1, let rect = mapRect(for: map, size: size, layout: layout) else { return nil }
        let options = MKMapSnapshotter.Options()
        options.mapRect = rect
        options.size = size
        options.scale = scale
        options.mapType = .mutedStandard
        options.pointOfInterestFilter = .excludingAll
        options.showsBuildings = false
        options.traitCollection = UITraitCollection(userInterfaceStyle: .dark)
        let base = try? await MKMapSnapshotter(options: options).start().image
        return draw(map, base: base, rect: rect, size: size, scale: scale, layout: layout)
    }

    /// Without the map underneath (synchronous: placeholders).
    static func vector(_ map: WidgetDetails.MapData, size: CGSize, scale: CGFloat, layout: Layout) -> UIImage? {
        guard size.width > 1, size.height > 1, let rect = mapRect(for: map, size: size, layout: layout) else { return nil }
        return draw(map, base: nil, rect: rect, size: size, scale: scale, layout: layout)
    }

    // MARK: Framing

    private static func mapRect(for map: WidgetDetails.MapData, size: CGSize, layout: Layout) -> MKMapRect? {
        let points = map.polygons.flatMap { $0.first ?? [] }
        guard !points.isEmpty else { return nil }
        var territory = MKMapRect.null
        for point in points where point.count >= 2 {
            let mapPoint = MKMapPoint(CLLocationCoordinate2D(latitude: point[1], longitude: point[0]))
            territory = territory.union(MKMapRect(origin: mapPoint, size: MKMapSize(width: 0, height: 0)))
        }
        guard !territory.isNull else { return nil }
        // Never closer than ~700 m across, so a small territory still sits in its streets
        let latitude = territory.origin.coordinate.latitude
        let minimum = 700 * MKMapPointsPerMeterAtLatitude(latitude)
        let width = max(territory.size.width, minimum)
        let height = max(territory.size.height, minimum * 0.6)
        let centre = MKMapPoint(x: territory.midX, y: territory.midY)
        let focus = layout.focus
        // Map points per pixel, so the territory fills the focus box
        let perPixel = max(width / (focus.width * size.width), height / (focus.height * size.height))
        let fullWidth = size.width * perPixel
        let fullHeight = size.height * perPixel
        let originX = centre.x - (focus.midX * size.width) * perPixel
        let originY = centre.y - (focus.midY * size.height) * perPixel
        return MKMapRect(x: originX, y: originY, width: fullWidth, height: fullHeight)
    }

    // MARK: Drawing

    private static func draw(_ map: WidgetDetails.MapData, base: UIImage?, rect: MKMapRect, size: CGSize, scale: CGFloat, layout: Layout) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            let cg = context.cgContext
            let bounds = CGRect(origin: .zero, size: size)
            // Ground
            UIColor(white: 0.035, alpha: 1).setFill()
            cg.fill(bounds)
            if let base {
                base.draw(in: bounds)
                // The map steps back: darker and calmer than the territories on it
                UIColor(white: 0, alpha: 0.32).setFill()
                cg.fill(bounds)
            } else {
                drawGrid(cg, size: size)
            }

            func project(_ point: [Double]) -> CGPoint {
                let mapPoint = MKMapPoint(CLLocationCoordinate2D(latitude: point[1], longitude: point[0]))
                return CGPoint(
                    x: (mapPoint.x - rect.minX) / rect.width * size.width,
                    y: (mapPoint.y - rect.minY) / rect.height * size.height
                )
            }

            func path(_ polygons: [WidgetDetails.Polygon]) -> UIBezierPath {
                let path = UIBezierPath()
                for polygon in polygons {
                    for ring in polygon where ring.count >= 3 {
                        path.move(to: project(ring[0]))
                        for point in ring.dropFirst() { path.addLine(to: project(point)) }
                        path.close()
                    }
                }
                path.usesEvenOddFillRule = true
                path.lineJoinStyle = .round
                return path
            }

            // Friends and club mates: a quiet wash and a hairline
            for neighbour in map.others {
                let color = WidgetColor.visible(neighbour.color, fallback: UIColor(white: 0.6, alpha: 1))
                let shape = path(neighbour.polygons)
                color.withAlphaComponent(0.14).setFill()
                shape.fill()
                color.withAlphaComponent(0.5).setStroke()
                shape.lineWidth = 0.75
                shape.stroke()
            }

            // Mine: a firm fill and a crisp edge, with a thin dark keyline so it reads on any street
            let mine = path(map.polygons)
            let color = WidgetColor.visible(map.color, fallback: WidgetColor.neon)
            color.withAlphaComponent(0.3).setFill()
            mine.fill()
            UIColor(white: 0, alpha: 0.55).setStroke()
            mine.lineWidth = 3.2
            mine.stroke()
            color.setStroke()
            mine.lineWidth = 1.6
            mine.stroke()

            drawShade(cg, size: size, layout: layout)
        }
    }

    /// A faint square grid, like a plotting sheet, for when there's no map.
    private static func drawGrid(_ cg: CGContext, size: CGSize) {
        let step: CGFloat = 18
        cg.setStrokeColor(UIColor(white: 1, alpha: 0.05).cgColor)
        cg.setLineWidth(0.5)
        var x: CGFloat = 0
        while x <= size.width {
            cg.move(to: CGPoint(x: x, y: 0))
            cg.addLine(to: CGPoint(x: x, y: size.height))
            x += step
        }
        var y: CGFloat = 0
        while y <= size.height {
            cg.move(to: CGPoint(x: 0, y: y))
            cg.addLine(to: CGPoint(x: size.width, y: y))
            y += step
        }
        cg.strokePath()
    }

    /// Darkens the side where the text goes, smoothly, so the text never sits on busy streets.
    private static func drawShade(_ cg: CGContext, size: CGSize, layout: Layout) {
        let colors = [UIColor(white: 0, alpha: 0).cgColor, UIColor(white: 0, alpha: 0.55).cgColor, UIColor(white: 0, alpha: 0.88).cgColor] as CFArray
        guard let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 0.55, 1]) else { return }
        switch layout {
        case .bottom:
            cg.drawLinearGradient(gradient, start: CGPoint(x: 0, y: size.height * 0.42), end: CGPoint(x: 0, y: size.height), options: [.drawsAfterEndLocation])
        case .left:
            cg.drawLinearGradient(gradient, start: CGPoint(x: size.width * 0.62, y: 0), end: CGPoint(x: 0, y: 0), options: [.drawsAfterEndLocation])
        case .top:
            cg.drawLinearGradient(gradient, start: CGPoint(x: 0, y: size.height * 0.62), end: CGPoint(x: 0, y: size.height), options: [.drawsAfterEndLocation])
        }
    }
}

/// Colours of the widgets.
enum WidgetColor {
    /// KM2's green, as in the icon.
    static let neon = UIColor(red: 0, green: 1, blue: 30 / 255, alpha: 1)

    static func color(_ hex: String?) -> UIColor? {
        guard var text = hex?.trimmingCharacters(in: .whitespaces) else { return nil }
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        return UIColor(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }

    /// A runner's colour, lifted towards white if it's too dark to see on black.
    static func visible(_ hex: String?, fallback: UIColor) -> UIColor {
        guard let color = color(hex) else { return fallback }
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        let luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
        guard luminance < 0.32 else { return color }
        let lift = (0.32 - luminance) / 0.32 * 0.55
        return UIColor(red: r + (1 - r) * lift, green: g + (1 - g) * lift, blue: b + (1 - b) * lift, alpha: 1)
    }
}
