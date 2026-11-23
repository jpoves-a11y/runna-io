import SwiftUI
import UIKit

/// "Mover y ajustar": frame the circle of your profile photo by pinching and dragging.
/// The photo always covers the circle (it springs back if you pull past an edge); double-tap
/// zooms in on that point or back out. "Elegir" returns a 512×512 square of what's inside the circle.
struct AvatarCropView: View {
    let image: UIImage
    let onCancel: () -> Void
    let onChoose: (UIImage) -> Void

    /// Zoom relative to the smallest size that still covers the circle (1 … maxZoom).
    @State private var zoom: CGFloat = 1
    /// Photo centre relative to the circle centre, in points.
    @State private var offset: CGSize = .zero
    /// Values at the start of the current gesture.
    @State private var gestureStart: (zoom: CGFloat, offset: CGSize)?
    /// Last pinch seen in this gesture (kept if one finger lifts and the other keeps dragging).
    @State private var pinch: (magnification: CGFloat, location: CGPoint)?
    @State private var translation: CGSize = .zero

    private let maxZoom: CGFloat = 6
    private let outputSide: CGFloat = 512
    private let margin: CGFloat = 24

    /// Size of the crop area, kept for the output (the offset is in its points).
    @State private var containerSize: CGSize = .zero

    var body: some View {
        ZStack {
            GeometryReader { proxy in
                let layout = Layout(container: proxy.size, imageSize: image.size, margin: margin)
                let live = liveState(layout)
                ZStack {
                    Color.black
                    Image(uiImage: image)
                        .resizable()
                        .frame(width: layout.displaySize(live.zoom).width, height: layout.displaySize(live.zoom).height)
                        .position(x: layout.center.x + live.offset.width, y: layout.center.y + live.offset.height)
                    cropOverlay(layout)
                }
                .contentShape(Rectangle())
                .gesture(cropGesture(layout))
                .onTapGesture(count: 2) { location in
                    doubleTap(at: location, layout: layout)
                }
                .onAppear { containerSize = proxy.size }
                .onChange(of: proxy.size) { _, size in containerSize = size }
            }
            .ignoresSafeArea()
            VStack {
                Text("Mover y ajustar")
                    .font(.headline)
                    .foregroundStyle(.white)
                    .padding(.top, DS.Spacing.l)
                    .allowsHitTesting(false)
                Spacer()
                buttons
            }
        }
        .background(Color.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
    }

    // MARK: Geometry

    private struct Layout {
        let container: CGSize
        let imageSize: CGSize
        let diameter: CGFloat
        let center: CGPoint
        /// Points per image point at zoom 1 (the photo just covers the circle).
        let fillScale: CGFloat

        init(container: CGSize, imageSize: CGSize, margin: CGFloat) {
            self.container = container
            self.imageSize = imageSize
            diameter = max(1, min(container.width, container.height) - margin * 2)
            center = CGPoint(x: container.width / 2, y: container.height / 2)
            fillScale = diameter / max(1, min(imageSize.width, imageSize.height))
        }

        func displaySize(_ zoom: CGFloat) -> CGSize {
            CGSize(width: imageSize.width * fillScale * zoom, height: imageSize.height * fillScale * zoom)
        }

        /// How far the photo centre can move from the circle centre and still cover it.
        func limit(_ zoom: CGFloat) -> CGSize {
            let size = displaySize(zoom)
            return CGSize(width: max(0, (size.width - diameter) / 2), height: max(0, (size.height - diameter) / 2))
        }

        var circleRect: CGRect {
            CGRect(x: center.x - diameter / 2, y: center.y - diameter / 2, width: diameter, height: diameter)
        }
    }

    /// Zoom and offset while a gesture is running (with elastic resistance past the limits).
    private func liveState(_ layout: Layout) -> (zoom: CGFloat, offset: CGSize) {
        guard let start = gestureStart else { return (zoom, offset) }
        var newZoom = start.zoom
        var newOffset = start.offset
        if let pinch {
            let raw = start.zoom * pinch.magnification
            newZoom = rubberBand(raw, lower: 1, upper: maxZoom, factor: 0.35)
            // Keep the photo point under the fingers where it is
            let k = newZoom / start.zoom
            let anchor = CGSize(width: pinch.location.x - layout.center.x, height: pinch.location.y - layout.center.y)
            newOffset = CGSize(
                width: anchor.width - (anchor.width - start.offset.width) * k,
                height: anchor.height - (anchor.height - start.offset.height) * k
            )
        }
        newOffset.width += translation.width
        newOffset.height += translation.height
        let limit = layout.limit(newZoom)
        newOffset = CGSize(
            width: rubberBand(newOffset.width, lower: -limit.width, upper: limit.width, factor: 0.35),
            height: rubberBand(newOffset.height, lower: -limit.height, upper: limit.height, factor: 0.35)
        )
        return (newZoom, newOffset)
    }

    private func rubberBand(_ value: CGFloat, lower: CGFloat, upper: CGFloat, factor: CGFloat) -> CGFloat {
        if value < lower { return lower - (lower - value) * factor }
        if value > upper { return upper + (value - upper) * factor }
        return value
    }

    private func clamped(zoom: CGFloat, offset: CGSize, layout: Layout) -> (zoom: CGFloat, offset: CGSize) {
        let newZoom = min(max(zoom, 1), maxZoom)
        let limit = layout.limit(newZoom)
        let newOffset = CGSize(
            width: min(max(offset.width, -limit.width), limit.width),
            height: min(max(offset.height, -limit.height), limit.height)
        )
        return (newZoom, newOffset)
    }

    // MARK: Gestures

    private func cropGesture(_ layout: Layout) -> some Gesture {
        let drag = DragGesture(minimumDistance: 1)
        let magnify = MagnifyGesture()
        return drag.simultaneously(with: magnify)
            .onChanged { value in
                if gestureStart == nil {
                    gestureStart = (zoom, offset)
                }
                if let dragValue = value.first {
                    translation = dragValue.translation
                }
                if let magnifyValue = value.second {
                    pinch = (magnifyValue.magnification, magnifyValue.startLocation)
                }
            }
            .onEnded { value in
                var live = liveState(layout)
                // A little momentum from the flick
                if let dragValue = value.first {
                    live.offset.width += (dragValue.predictedEndTranslation.width - dragValue.translation.width) * 0.35
                    live.offset.height += (dragValue.predictedEndTranslation.height - dragValue.translation.height) * 0.35
                }
                let settled = clamped(zoom: live.zoom, offset: live.offset, layout: layout)
                let hitEdge = abs(settled.zoom - live.zoom) > 0.01
                    || abs(settled.offset.width - live.offset.width) > 8
                    || abs(settled.offset.height - live.offset.height) > 8
                // Glide from where the photo is on screen to the settled spot (inside the circle)
                withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                    gestureStart = nil
                    pinch = nil
                    translation = .zero
                    zoom = settled.zoom
                    offset = settled.offset
                }
                if hitEdge { Haptics.tap() }
            }
    }

    private func doubleTap(at location: CGPoint, layout: Layout) {
        let target: (zoom: CGFloat, offset: CGSize)
        if zoom > 1.05 {
            target = clamped(zoom: 1, offset: offset, layout: layout)
        } else {
            let newZoom: CGFloat = 2.5
            let k = newZoom / zoom
            let anchor = CGSize(width: location.x - layout.center.x, height: location.y - layout.center.y)
            let newOffset = CGSize(
                width: anchor.width - (anchor.width - offset.width) * k,
                height: anchor.height - (anchor.height - offset.height) * k
            )
            target = clamped(zoom: newZoom, offset: newOffset, layout: layout)
        }
        withAnimation(.spring(response: 0.4, dampingFraction: 0.85)) {
            zoom = target.zoom
            offset = target.offset
        }
    }

    // MARK: Overlay

    private func cropOverlay(_ layout: Layout) -> some View {
        let circle = layout.circleRect
        let interacting = gestureStart != nil
        return ZStack {
            Path { path in
                path.addRect(CGRect(origin: .zero, size: layout.container))
                path.addEllipse(in: circle)
            }
            .fill(Color.black.opacity(0.6), style: FillStyle(eoFill: true))
            // Rule of thirds while you move it
            Path { path in
                for step in 1...2 {
                    let x = circle.minX + circle.width * CGFloat(step) / 3
                    let y = circle.minY + circle.height * CGFloat(step) / 3
                    path.move(to: CGPoint(x: x, y: circle.minY))
                    path.addLine(to: CGPoint(x: x, y: circle.maxY))
                    path.move(to: CGPoint(x: circle.minX, y: y))
                    path.addLine(to: CGPoint(x: circle.maxX, y: y))
                }
            }
            .stroke(Color.white.opacity(0.45), lineWidth: 0.5)
            .clipShape(Circle().path(in: circle))
            .opacity(interacting ? 1 : 0)
            .animation(.easeOut(duration: 0.2), value: interacting)
            Circle()
                .path(in: circle)
                .stroke(Color.white.opacity(0.9), lineWidth: 1)
        }
        .allowsHitTesting(false)
    }

    private var buttons: some View {
        HStack {
            Button("Cancelar", action: onCancel)
                .font(.body.weight(.medium))
                .foregroundStyle(.white)
            Spacer()
            Button {
                if let cropped = croppedImage() {
                    Haptics.success()
                    onChoose(cropped)
                }
            } label: {
                Text("Elegir")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, DS.Spacing.xl)
                    .frame(minHeight: 44)
                    .background(Color.brand, in: Capsule())
            }
        }
        .padding(.horizontal, DS.Spacing.screen)
        .padding(.bottom, DS.Spacing.l)
    }

    // MARK: Output

    /// What's inside the circle as a square image (`outputSide` px), keeping the photo's orientation.
    private func croppedImage() -> UIImage? {
        guard containerSize.width > 0, containerSize.height > 0 else { return nil }
        // Same geometry as on screen
        let layout = Layout(container: containerSize, imageSize: image.size, margin: margin)
        let pointsPerImagePoint = layout.fillScale * zoom
        let side = layout.diameter / pointsPerImagePoint
        let display = layout.displaySize(zoom)
        let originX = (display.width / 2 - offset.width - layout.diameter / 2) / pointsPerImagePoint
        let originY = (display.height / 2 - offset.height - layout.diameter / 2) / pointsPerImagePoint
        guard side > 0 else { return nil }
        let ratio = outputSide / side
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: CGSize(width: outputSide, height: outputSide), format: format).image { _ in
            image.draw(in: CGRect(
                x: -originX * ratio,
                y: -originY * ratio,
                width: image.size.width * ratio,
                height: image.size.height * ratio
            ))
        }
    }
}

#Preview {
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: 1200, height: 800))
    let sample = renderer.image { context in
        UIColor.systemTeal.setFill()
        context.fill(CGRect(x: 0, y: 0, width: 1200, height: 800))
        UIColor.systemOrange.setFill()
        context.cgContext.fillEllipse(in: CGRect(x: 450, y: 250, width: 300, height: 300))
    }
    return AvatarCropView(image: sample, onCancel: {}, onChoose: { _ in })
}
