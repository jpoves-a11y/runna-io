import SwiftUI
import UIKit

// MARK: - Shape

/// Outline of a club crest. Insettable so the outline can be drawn inside the frame.
struct CrestShape: InsettableShape {
    let kind: String
    var inset: CGFloat = 0

    func inset(by amount: CGFloat) -> CrestShape {
        CrestShape(kind: kind, inset: inset + amount)
    }

    func path(in frame: CGRect) -> Path {
        let rect = frame.insetBy(dx: inset, dy: inset)
        var path = Path()
        let w = rect.width
        let h = rect.height
        let x = rect.minX
        let y = rect.minY
        func p(_ px: CGFloat, _ py: CGFloat) -> CGPoint { CGPoint(x: x + w * px, y: y + h * py) }
        switch kind {
        case "round":
            path.addEllipse(in: rect)
        case "rounded":
            path.addRoundedRect(in: rect, cornerSize: CGSize(width: w * 0.24, height: w * 0.24), style: .continuous)
        case "hex":
            path.move(to: p(0.5, 0))
            path.addLine(to: p(1, 0.25))
            path.addLine(to: p(1, 0.75))
            path.addLine(to: p(0.5, 1))
            path.addLine(to: p(0, 0.75))
            path.addLine(to: p(0, 0.25))
            path.closeSubpath()
        case "octagon":
            let c: CGFloat = 0.293
            path.move(to: p(c, 0))
            path.addLine(to: p(1 - c, 0))
            path.addLine(to: p(1, c))
            path.addLine(to: p(1, 1 - c))
            path.addLine(to: p(1 - c, 1))
            path.addLine(to: p(c, 1))
            path.addLine(to: p(0, 1 - c))
            path.addLine(to: p(0, c))
            path.closeSubpath()
        case "diamond":
            path.move(to: p(0.5, 0))
            path.addQuadCurve(to: p(1, 0.5), control: p(0.8, 0.22))
            path.addQuadCurve(to: p(0.5, 1), control: p(0.8, 0.78))
            path.addQuadCurve(to: p(0, 0.5), control: p(0.2, 0.78))
            path.addQuadCurve(to: p(0.5, 0), control: p(0.2, 0.22))
            path.closeSubpath()
        case "banner":
            // Hanging pennant: a rod at the top, straight sides and a swallowtail
            path.move(to: p(0, 0.04))
            path.addQuadCurve(to: p(0.5, 0.04), control: p(0.25, 0))
            path.addQuadCurve(to: p(1, 0.04), control: p(0.75, 0))
            path.addLine(to: p(1, 1))
            path.addLine(to: p(0.5, 0.82))
            path.addLine(to: p(0, 1))
            path.closeSubpath()
        case "pointed":
            // French shield: square top, rounded lower corners and a small point in the middle
            path.move(to: p(0, 0))
            path.addLine(to: p(1, 0))
            path.addLine(to: p(1, 0.7))
            path.addQuadCurve(to: p(0.62, 0.9), control: p(1, 0.9))
            path.addQuadCurve(to: p(0.5, 1), control: p(0.54, 0.92))
            path.addQuadCurve(to: p(0.38, 0.9), control: p(0.46, 0.92))
            path.addQuadCurve(to: p(0, 0.7), control: p(0, 0.9))
            path.closeSubpath()
        default:
            // Classic heater shield: flat top, straight sides, curved point at the bottom
            path.move(to: p(0, 0))
            path.addLine(to: p(1, 0))
            path.addLine(to: p(1, 0.45))
            path.addQuadCurve(to: p(0.5, 1), control: p(1, 0.85))
            path.addQuadCurve(to: p(0, 0.45), control: p(0, 0.85))
            path.closeSubpath()
        }
        return path
    }
}

/// How each shape frames its content: height / width, icon size and where the visual centre sits.
struct CrestMetrics {
    let aspect: CGFloat
    let iconScale: CGFloat
    let centerOffset: CGFloat

    init(shape: String) {
        switch shape {
        case "round": (aspect, iconScale, centerOffset) = (1, 0.42, 0)
        case "rounded": (aspect, iconScale, centerOffset) = (1, 0.44, 0)
        case "hex": (aspect, iconScale, centerOffset) = (1.1, 0.4, 0)
        case "octagon": (aspect, iconScale, centerOffset) = (1, 0.42, 0)
        case "diamond": (aspect, iconScale, centerOffset) = (1.18, 0.3, 0)
        case "banner": (aspect, iconScale, centerOffset) = (1.28, 0.4, -0.07)
        case "pointed": (aspect, iconScale, centerOffset) = (1.12, 0.4, -0.04)
        default: (aspect, iconScale, centerOffset) = (1.14, 0.4, -0.07)
        }
    }
}

// MARK: - Crest

/// A club crest: shape, background pattern, icon and initials in their own colour, and an outline.
struct CrestView: View {
    let crest: Crest
    var size: CGFloat = 44

    private var primary: Color { Color(hex: crest.primary) }
    private var secondary: Color { Color(hex: crest.secondary) }
    private var iconColor: Color { Color(hex: crest.iconColor) }
    private var trim: Color { Color(hex: crest.trim) }
    private var metrics: CrestMetrics { CrestMetrics(shape: crest.shape) }
    private var shape: CrestShape { CrestShape(kind: crest.shape) }
    private var outline: CGFloat { max(1.2, size / 24) }

    var body: some View {
        let height = size * metrics.aspect
        ZStack {
            CrestPatternView(pattern: crest.pattern, primary: primary, secondary: secondary)
            if crest.pattern == "border" {
                shape.strokeBorder(secondary, lineWidth: size * 0.1)
            }
            // Soft light from the top so the crest doesn't look flat
            LinearGradient(colors: [Color.white.opacity(0.16), Color.clear, Color.black.opacity(0.1)], startPoint: .top, endPoint: .bottom)
            emblem
                .offset(y: height * metrics.centerOffset)
        }
        .frame(width: size, height: height)
        .clipShape(shape)
        .overlay(shape.strokeBorder(trim, lineWidth: outline))
        .overlay(shape.strokeBorder(Color.black.opacity(0.12), lineWidth: DS.Stroke.hairline))
        .accessibilityHidden(true)
    }

    private var emblem: some View {
        let iconSize = size * metrics.iconScale * (crest.initials.isEmpty ? 1 : 0.8)
        return VStack(spacing: size * 0.015) {
            Image(systemName: crest.icon)
                .font(.system(size: iconSize, weight: .semibold))
            if !crest.initials.isEmpty {
                Text(crest.initials)
                    .font(.system(size: size * metrics.iconScale * 0.42, weight: .heavy, design: .rounded))
                    .tracking(size * 0.01)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
            }
        }
        .foregroundStyle(iconColor)
        .frame(maxWidth: size * 0.72)
        .shadow(color: Color.black.opacity(size > 30 ? 0.28 : 0.18), radius: size / 60, x: 0, y: size / 90)
    }
}

/// Background pattern of a crest (drawn in its frame, clipped by the crest shape).
private struct CrestPatternView: View {
    let pattern: String
    let primary: Color
    let secondary: Color

    var body: some View {
        Canvas { context, size in
            let w = size.width
            let h = size.height
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(primary))
            let accent: GraphicsContext.Shading = .color(secondary)
            func polygon(_ points: [CGPoint]) -> Path {
                var path = Path()
                path.addLines(points)
                path.closeSubpath()
                return path
            }
            switch pattern {
            case "halves":
                context.fill(Path(CGRect(x: w / 2, y: 0, width: w / 2, height: h)), with: accent)
            case "bend":
                context.fill(polygon([CGPoint(x: w, y: 0), CGPoint(x: w, y: h), CGPoint(x: 0, y: h)]), with: accent)
            case "stripes":
                let band = w / 7
                for index in stride(from: 1, to: 7, by: 2) {
                    context.fill(Path(CGRect(x: band * CGFloat(index), y: 0, width: band, height: h)), with: accent)
                }
            case "chevron":
                context.fill(polygon([
                    CGPoint(x: 0, y: h * 0.62), CGPoint(x: w * 0.5, y: h * 0.32), CGPoint(x: w, y: h * 0.62),
                    CGPoint(x: w, y: h * 0.8), CGPoint(x: w * 0.5, y: h * 0.5), CGPoint(x: 0, y: h * 0.8),
                ]), with: accent)
            case "diagonal":
                context.fill(polygon([
                    CGPoint(x: 0, y: 0), CGPoint(x: w * 0.32, y: 0), CGPoint(x: w, y: h * 0.68),
                    CGPoint(x: w, y: h), CGPoint(x: w * 0.68, y: h), CGPoint(x: 0, y: h * 0.32),
                ]), with: accent)
            case "quartered":
                context.fill(Path(CGRect(x: w / 2, y: 0, width: w / 2, height: h / 2)), with: accent)
                context.fill(Path(CGRect(x: 0, y: h / 2, width: w / 2, height: h / 2)), with: accent)
            case "checkers":
                let columns = 4
                let cell = w / CGFloat(columns)
                let rows = Int((h / cell).rounded(.up))
                for row in 0..<rows {
                    for column in 0..<columns where (row + column) % 2 == 1 {
                        context.fill(Path(CGRect(x: cell * CGFloat(column), y: cell * CGFloat(row), width: cell, height: cell)), with: accent)
                    }
                }
            case "cross":
                let thickness = w * 0.2
                context.fill(Path(CGRect(x: (w - thickness) / 2, y: 0, width: thickness, height: h)), with: accent)
                context.fill(Path(CGRect(x: 0, y: h * 0.42 - thickness / 2, width: w, height: thickness)), with: accent)
            case "saltire":
                var path = Path()
                path.move(to: .zero)
                path.addLine(to: CGPoint(x: w, y: h))
                path.move(to: CGPoint(x: w, y: 0))
                path.addLine(to: CGPoint(x: 0, y: h))
                context.stroke(path, with: accent, lineWidth: w * 0.2)
            case "rings":
                let center = CGPoint(x: w / 2, y: h / 2)
                let step = w * 0.16
                for index in 1...4 {
                    let radius = step * CGFloat(index) + step * 0.2
                    let ring = Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
                    context.stroke(ring, with: accent, lineWidth: step * 0.45)
                }
            case "waves":
                let rows = 4
                let gap = h / CGFloat(rows)
                for row in 0..<rows {
                    var wave = Path()
                    let base = gap * (CGFloat(row) + 0.55)
                    wave.move(to: CGPoint(x: -w * 0.1, y: base))
                    let segments = 3
                    let length = w * 1.2 / CGFloat(segments)
                    for segment in 0..<segments {
                        let start = -w * 0.1 + length * CGFloat(segment)
                        wave.addQuadCurve(
                            to: CGPoint(x: start + length, y: base),
                            control: CGPoint(x: start + length / 2, y: base + (segment % 2 == 0 ? -gap * 0.35 : gap * 0.35))
                        )
                    }
                    context.stroke(wave, with: accent, lineWidth: gap * 0.28)
                }
            case "stars":
                var star = context.resolve(Image(systemName: "star.fill"))
                star.shading = .color(secondary.opacity(0.6))
                let step = w / 4
                let rows = Int((h / step).rounded(.up))
                for row in 0..<rows {
                    for column in 0..<4 {
                        let offset: CGFloat = row % 2 == 0 ? 0 : step / 2
                        let center = CGPoint(x: step * CGFloat(column) + step / 2 + offset, y: step * CGFloat(row) + step / 2)
                        context.draw(star, in: CGRect(x: center.x - step * 0.18, y: center.y - step * 0.18, width: step * 0.36, height: step * 0.36))
                    }
                }
            default:
                break
            }
        }
    }
}

// MARK: - Editor

/// Crest editor: big live preview, then tabs for shape, background, colours, icon and initials.
struct CrestEditor: View {
    @Binding var crest: Crest
    /// Cosmetic item ids that unlock pieces (owned by me or my club).
    let unlocked: Set<String>
    /// Called when the initials are edited by hand (so they stop following the club name).
    var onInitialsEdited: () -> Void = {}

    enum Tab: String, CaseIterable, Identifiable {
        case shape = "Forma"
        case pattern = "Fondo"
        case colors = "Colores"
        case icon = "Icono"
        case text = "Texto"
        var id: String { rawValue }
    }

    enum ColorTarget: String, CaseIterable, Identifiable {
        case background = "Fondo"
        case pattern = "Dibujo"
        case icon = "Icono"
        case trim = "Borde"
        var id: String { rawValue }
    }

    @State private var tab: Tab = .shape
    @State private var target: ColorTarget = .icon

    var body: some View {
        VStack(spacing: DS.Spacing.l) {
            preview
            Picker("Sección", selection: $tab.animation(.snappy)) {
                ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            Group {
                switch tab {
                case .shape: shapeGrid
                case .pattern: patternGrid
                case .colors: colorsPanel
                case .icon: iconPanel
                case .text: textPanel
                }
            }
            .transition(.opacity)
        }
    }

    // MARK: Preview

    private var preview: some View {
        VStack(spacing: DS.Spacing.m) {
            ZStack {
                Circle()
                    .fill(RadialGradient(colors: [Color(hex: crest.primary).opacity(0.35), Color.clear], center: .center, startRadius: 10, endRadius: 110))
                    .frame(width: 220, height: 220)
                CrestView(crest: crest, size: 124)
                    .shadow(color: Color.black.opacity(0.22), radius: 12, x: 0, y: 6)
                    .animation(.snappy, value: crest)
            }
            .frame(height: 190)
            if let warning = contrastWarning {
                Label(warning, systemImage: "eye.trianglebadge.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(Color.steal)
                    .multilineTextAlignment(.center)
            }
            HStack(spacing: DS.Spacing.s) {
                Button {
                    withAnimation(.snappy) { randomize() }
                    Haptics.tap()
                } label: {
                    Label("Sorpréndeme", systemImage: "dice.fill")
                }
                .buttonStyle(.bordered)
                .tint(Color.brand)
                Button {
                    withAnimation(.snappy) {
                        let background = crest.primary
                        crest.primary = crest.secondary
                        crest.secondary = background
                    }
                } label: {
                    Label("Invertir fondo", systemImage: "arrow.left.arrow.right")
                }
                .buttonStyle(.bordered)
                .tint(.secondary)
            }
            .font(.subheadline.weight(.medium))
        }
        .frame(maxWidth: .infinity)
    }

    /// The icon is hard to see when its colour is too close to the background.
    private var contrastWarning: String? {
        let ratio = CrestColor.contrast(crest.iconColor, crest.primary)
        let patternRatio = CrestColor.contrast(crest.iconColor, crest.secondary)
        if ratio < 1.5 && crest.pattern == "plain" { return "El icono apenas se ve sobre el fondo: cambia su color en Colores › Icono." }
        if ratio < 1.5 && patternRatio < 1.5 { return "El icono apenas se ve: cambia su color en Colores › Icono." }
        return nil
    }

    // MARK: Shape & pattern

    private var tileColumns: [GridItem] { Array(repeating: GridItem(.flexible(), spacing: 10), count: 4) }

    private var shapeGrid: some View {
        LazyVGrid(columns: tileColumns, spacing: 10) {
            ForEach(CrestCatalog.shapes) { piece in
                tile(label: piece.label, selected: crest.shape == piece.id, locked: isLocked(piece)) {
                    CrestView(crest: crest.with(shape: piece.id), size: 42)
                } action: {
                    crest.shape = piece.id
                }
            }
        }
    }

    private var patternGrid: some View {
        LazyVGrid(columns: tileColumns, spacing: 10) {
            ForEach(CrestCatalog.patterns) { piece in
                tile(label: piece.label, selected: crest.pattern == piece.id, locked: isLocked(piece)) {
                    CrestView(crest: crest.with(pattern: piece.id), size: 42)
                } action: {
                    crest.pattern = piece.id
                }
            }
        }
    }

    private func tile<Content: View>(
        label: String, selected: Bool, locked: Bool,
        @ViewBuilder content: () -> Content, action: @escaping () -> Void
    ) -> some View {
        Button {
            guard !locked else { return }
            withAnimation(.snappy) { action() }
        } label: {
            VStack(spacing: 6) {
                content()
                    .frame(height: 54)
                    .overlay(alignment: .topTrailing) {
                        if locked {
                            Image(systemName: "lock.fill")
                                .font(.caption2.weight(.bold))
                                .padding(4)
                                .background(.regularMaterial, in: Circle())
                        }
                    }
                Text(label)
                    .font(.caption2.weight(selected ? .semibold : .regular))
                    .foregroundStyle(selected ? Color.primary : Color.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(selected ? Color.brand.opacity(0.12) : Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous)
                    .strokeBorder(selected ? Color.brand : Color.clear, lineWidth: 2)
            )
            .opacity(locked ? 0.5 : 1)
        }
        .buttonStyle(.pressable)
        .sensoryFeedback(.selection, trigger: selected)
        .accessibilityLabel(locked ? "\(label), bloqueado" : label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: Colours

    private var colorsPanel: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.l) {
            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                SectionLabel("Combinaciones")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(CrestCatalog.palettes) { palette in
                            Button {
                                withAnimation(.snappy) { apply(palette) }
                            } label: {
                                VStack(spacing: 4) {
                                    CrestView(crest: applying(palette, to: crest), size: 40)
                                    Text(palette.name)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .buttonStyle(.pressable)
                            .accessibilityLabel("Combinación \(palette.name)")
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                SectionLabel("Qué quieres pintar")
                HStack(spacing: 8) {
                    ForEach(ColorTarget.allCases) { item in
                        targetButton(item)
                    }
                }
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 7), spacing: 10) {
                ForEach(CrestCatalog.colors, id: \.self) { hex in
                    swatch(hex)
                }
            }
            ColorPicker(selection: Binding(
                get: { Color(hex: color(of: target)) },
                set: { setColor(CrestColor.hex(of: $0), for: target) }
            ), supportsOpacity: false) {
                Label("Color personalizado", systemImage: "eyedropper")
                    .font(.subheadline.weight(.medium))
            }
            .padding(.horizontal, DS.Spacing.m)
            .padding(.vertical, 10)
            .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous))
        }
    }

    private func targetButton(_ item: ColorTarget) -> some View {
        let selected = target == item
        return Button {
            withAnimation(.snappy) { target = item }
        } label: {
            VStack(spacing: 6) {
                Circle()
                    .fill(Color(hex: color(of: item)))
                    .frame(width: 26, height: 26)
                    .overlay(Circle().strokeBorder(Color.hairline, lineWidth: 1))
                Text(item.rawValue)
                    .font(.caption.weight(selected ? .semibold : .regular))
                    .foregroundStyle(selected ? Color.primary : Color.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(selected ? Color.brand.opacity(0.12) : Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous)
                    .strokeBorder(selected ? Color.brand : Color.clear, lineWidth: 2)
            )
        }
        .buttonStyle(.pressable)
        .accessibilityLabel("Color de \(item.rawValue.lowercased())")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func swatch(_ hex: String) -> some View {
        let selected = color(of: target).uppercased() == hex.uppercased()
        return Button {
            withAnimation(.snappy) { setColor(hex, for: target) }
        } label: {
            Circle()
                .fill(Color(hex: hex))
                .aspectRatio(1, contentMode: .fit)
                .overlay(Circle().strokeBorder(Color.hairline, lineWidth: 1))
                .overlay {
                    if selected {
                        Image(systemName: "checkmark")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(CrestColor.luminance(hex) > 0.6 ? Color.black : Color.white)
                    }
                }
                .overlay(Circle().strokeBorder(Color.primary, lineWidth: selected ? 2 : 0).padding(-3))
        }
        .buttonStyle(.pressable)
        .accessibilityLabel(hex)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func color(of target: ColorTarget) -> String {
        switch target {
        case .background: return crest.primary
        case .pattern: return crest.secondary
        case .icon: return crest.iconColor
        case .trim: return crest.trim
        }
    }

    private func setColor(_ hex: String, for target: ColorTarget) {
        switch target {
        case .background: crest.primary = hex
        case .pattern: crest.secondary = hex
        case .icon: crest.iconColor = hex
        case .trim: crest.trim = hex
        }
    }

    private func applying(_ palette: CrestCatalog.Palette, to crest: Crest) -> Crest {
        var copy = crest
        copy.primary = palette.primary
        copy.secondary = palette.secondary
        copy.iconColor = palette.icon
        copy.trim = palette.trim
        return copy
    }

    private func apply(_ palette: CrestCatalog.Palette) {
        crest = applying(palette, to: crest)
    }

    // MARK: Icon

    private var iconPanel: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.l) {
            ForEach(CrestCatalog.iconGroups) { group in
                VStack(alignment: .leading, spacing: DS.Spacing.s) {
                    SectionLabel(group.title)
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 6), spacing: 8) {
                        ForEach(group.icons) { piece in
                            iconButton(piece)
                        }
                    }
                }
            }
            if CrestCatalog.icons.contains(where: isLocked) {
                Text("Los iconos con candado se desbloquean con cofres y retos de cualquier miembro del club.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func iconButton(_ piece: CrestCatalog.Piece) -> some View {
        let locked = isLocked(piece)
        let selected = crest.icon == piece.id
        return Button {
            guard !locked else { return }
            withAnimation(.snappy) { crest.icon = piece.id }
        } label: {
            Image(systemName: piece.id)
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(selected ? Color(hex: crest.iconColor) : Color.primary)
                .frame(maxWidth: .infinity)
                .frame(height: 46)
                .background(
                    selected ? Color(hex: crest.primary) : Color.surfaceRaised,
                    in: RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous)
                        .strokeBorder(selected ? Color.brand : Color.clear, lineWidth: 2)
                )
                .overlay(alignment: .topTrailing) {
                    if locked {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 9, weight: .bold))
                            .padding(3)
                            .background(.regularMaterial, in: Circle())
                            .offset(x: 3, y: -3)
                    }
                }
                .opacity(locked ? 0.45 : 1)
        }
        .buttonStyle(.pressable)
        .sensoryFeedback(.selection, trigger: selected)
        .accessibilityLabel(locked ? "\(piece.label), bloqueado" : piece.label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: Text

    private var textPanel: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionLabel("Iniciales bajo el icono")
            TextField("Hasta 3 letras o números", text: Binding(
                get: { crest.initials },
                set: {
                    crest.initials = String($0.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(3))
                    onInitialsEdited()
                }
            ))
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .submitLabel(.done)
            .font(.title3.weight(.bold))
            .padding(.horizontal, DS.Spacing.m)
            .padding(.vertical, 12)
            .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous))
            Text("Déjalo vacío para que el icono ocupe todo el escudo. Su color es el del icono.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: Helpers

    private func isLocked(_ piece: CrestCatalog.Piece) -> Bool {
        guard let unlock = piece.unlock else { return false }
        return !unlocked.contains(unlock)
    }

    private func randomize() {
        let palette = CrestCatalog.palettes.randomElement()!
        crest = applying(palette, to: crest)
        crest.shape = CrestCatalog.shapes.filter { !isLocked($0) }.randomElement()?.id ?? crest.shape
        crest.pattern = CrestCatalog.patterns.filter { !isLocked($0) }.randomElement()?.id ?? crest.pattern
        crest.icon = CrestCatalog.icons.filter { !isLocked($0) }.randomElement()?.id ?? crest.icon
    }
}

extension Crest {
    func with(shape: String? = nil, pattern: String? = nil) -> Crest {
        var copy = self
        if let shape { copy.shape = shape }
        if let pattern { copy.pattern = pattern }
        return copy
    }
}

// MARK: - Colour maths

enum CrestColor {
    /// Relative luminance (0 black … 1 white) of "#RRGGBB".
    static func luminance(_ hex: String) -> Double {
        var text = hex.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return 0.5 }
        func channel(_ shift: UInt32) -> Double {
            let c = Double((value >> shift) & 0xFF) / 255
            return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
    }

    /// WCAG contrast ratio between two colours (1 = identical, 21 = black on white).
    static func contrast(_ a: String, _ b: String) -> Double {
        let la = luminance(a)
        let lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    /// "#RRGGBB" of a colour picked with the system colour picker.
    static func hex(of color: Color) -> String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a)
        func byte(_ v: CGFloat) -> Int { Int((max(0, min(1, v)) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", byte(r), byte(g), byte(b))
    }
}

// MARK: - Keyboard

extension View {
    /// Tapping anywhere outside a text field hides the keyboard (taps still reach buttons).
    func dismissesKeyboardOnTapOutside() -> some View {
        background(KeyboardDismissInstaller().frame(width: 0, height: 0))
    }
}

/// Puts a tap recogniser on the window while the view is on screen. It never cancels touches and
/// ignores taps on text fields, so it only ends editing when the tap lands somewhere else.
private struct KeyboardDismissInstaller: UIViewRepresentable {
    func makeUIView(context: Context) -> InstallerView { InstallerView() }
    func updateUIView(_ uiView: InstallerView, context: Context) {}

    final class InstallerView: UIView, UIGestureRecognizerDelegate {
        private var recognizer: UITapGestureRecognizer?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let recognizer {
                recognizer.view?.removeGestureRecognizer(recognizer)
                self.recognizer = nil
            }
            guard let window else { return }
            let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
            tap.cancelsTouchesInView = false
            tap.delegate = self
            window.addGestureRecognizer(tap)
            recognizer = tap
        }

        @objc private func tapped() {
            window?.endEditing(true)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            var view = touch.view
            while let current = view {
                if current is UITextField || current is UITextView { return false }
                view = current.superview
            }
            return true
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }
    }
}
