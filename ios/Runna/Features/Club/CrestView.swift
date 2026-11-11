import SwiftUI

/// Outline of a club crest.
struct CrestShape: Shape {
    let kind: String

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.width
        let h = rect.height
        let x = rect.minX
        let y = rect.minY
        switch kind {
        case "round":
            path.addEllipse(in: rect)
        case "hex":
            path.move(to: CGPoint(x: x + w * 0.5, y: y))
            path.addLine(to: CGPoint(x: x + w, y: y + h * 0.25))
            path.addLine(to: CGPoint(x: x + w, y: y + h * 0.75))
            path.addLine(to: CGPoint(x: x + w * 0.5, y: y + h))
            path.addLine(to: CGPoint(x: x, y: y + h * 0.75))
            path.addLine(to: CGPoint(x: x, y: y + h * 0.25))
            path.closeSubpath()
        case "diamond":
            path.move(to: CGPoint(x: x + w * 0.5, y: y))
            path.addLine(to: CGPoint(x: x + w, y: y + h * 0.5))
            path.addLine(to: CGPoint(x: x + w * 0.5, y: y + h))
            path.addLine(to: CGPoint(x: x, y: y + h * 0.5))
            path.closeSubpath()
        case "banner":
            path.move(to: CGPoint(x: x, y: y))
            path.addLine(to: CGPoint(x: x + w, y: y))
            path.addLine(to: CGPoint(x: x + w, y: y + h))
            path.addLine(to: CGPoint(x: x + w * 0.5, y: y + h * 0.78))
            path.addLine(to: CGPoint(x: x, y: y + h))
            path.closeSubpath()
        default:
            // Classic heater shield: flat top, straight sides, curved point at the bottom
            path.move(to: CGPoint(x: x, y: y))
            path.addLine(to: CGPoint(x: x + w, y: y))
            path.addLine(to: CGPoint(x: x + w, y: y + h * 0.45))
            path.addQuadCurve(to: CGPoint(x: x + w * 0.5, y: y + h), control: CGPoint(x: x + w, y: y + h * 0.85))
            path.addQuadCurve(to: CGPoint(x: x, y: y + h * 0.45), control: CGPoint(x: x, y: y + h * 0.85))
            path.closeSubpath()
        }
        return path
    }
}

/// A club crest: shape, background pattern in two colours, icon and initials.
struct CrestView: View {
    let crest: Crest
    var size: CGFloat = 44

    private var primary: Color { Color(hex: crest.primary) }
    private var secondary: Color { Color(hex: crest.secondary) }

    var body: some View {
        ZStack {
            CrestPattern(pattern: crest.pattern, primary: primary, secondary: secondary)
            VStack(spacing: size * 0.02) {
                Image(systemName: crest.icon)
                    .font(.system(size: size * (crest.initials.isEmpty ? 0.42 : 0.32), weight: .semibold))
                    .foregroundStyle(secondary)
                if !crest.initials.isEmpty {
                    Text(crest.initials)
                        .font(.system(size: size * 0.18, weight: .bold))
                        .foregroundStyle(secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                }
            }
            .padding(.bottom, crest.shape == "classic" || crest.shape == "banner" ? size * 0.1 : 0)
            .shadow(color: Color.black.opacity(0.25), radius: 1, x: 0, y: 0.5)
        }
        .frame(width: size, height: size * (crest.shape == "round" ? 1 : 1.12))
        .clipShape(CrestShape(kind: crest.shape))
        .overlay(CrestShape(kind: crest.shape).stroke(secondary.opacity(0.9), lineWidth: max(1, size / 30)))
        .overlay(CrestShape(kind: crest.shape).stroke(Color.hairline, lineWidth: DS.Stroke.hairline))
        .accessibilityHidden(true)
    }
}

/// Background pattern of a crest (drawn in its frame, clipped by the crest shape).
private struct CrestPattern: View {
    let pattern: String
    let primary: Color
    let secondary: Color

    var body: some View {
        Canvas { context, size in
            let rect = CGRect(origin: .zero, size: size)
            context.fill(Path(rect), with: .color(primary))
            let accent: GraphicsContext.Shading = .color(secondary.opacity(0.85))
            switch pattern {
            case "stripes":
                let band = size.width / 7
                for index in stride(from: 1, to: 7, by: 2) {
                    context.fill(Path(CGRect(x: band * CGFloat(index), y: 0, width: band, height: size.height)), with: accent)
                }
            case "chevron":
                var path = Path()
                path.move(to: CGPoint(x: 0, y: size.height * 0.55))
                path.addLine(to: CGPoint(x: size.width * 0.5, y: size.height * 0.25))
                path.addLine(to: CGPoint(x: size.width, y: size.height * 0.55))
                path.addLine(to: CGPoint(x: size.width, y: size.height * 0.75))
                path.addLine(to: CGPoint(x: size.width * 0.5, y: size.height * 0.45))
                path.addLine(to: CGPoint(x: 0, y: size.height * 0.75))
                path.closeSubpath()
                context.fill(path, with: accent)
            case "diagonal":
                var path = Path()
                path.move(to: CGPoint(x: 0, y: 0))
                path.addLine(to: CGPoint(x: size.width * 0.35, y: 0))
                path.addLine(to: CGPoint(x: size.width, y: size.height * 0.65))
                path.addLine(to: CGPoint(x: size.width, y: size.height))
                path.addLine(to: CGPoint(x: size.width * 0.65, y: size.height))
                path.addLine(to: CGPoint(x: 0, y: size.height * 0.35))
                path.closeSubpath()
                context.fill(path, with: accent)
            case "quartered":
                context.fill(Path(CGRect(x: size.width / 2, y: 0, width: size.width / 2, height: size.height / 2)), with: accent)
                context.fill(Path(CGRect(x: 0, y: size.height / 2, width: size.width / 2, height: size.height / 2)), with: accent)
            case "cross":
                let thickness = size.width * 0.2
                context.fill(Path(CGRect(x: (size.width - thickness) / 2, y: 0, width: thickness, height: size.height)), with: accent)
                context.fill(Path(CGRect(x: 0, y: size.height * 0.4 - thickness / 2, width: size.width, height: thickness)), with: accent)
            case "stars":
                var star = context.resolve(Image(systemName: "star.fill"))
                star.shading = .color(secondary.opacity(0.5))
                let step = size.width / 4
                for row in 0..<5 {
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

/// Crest editor: shape, background, colours, icon and initials. Locked pieces show a lock.
struct CrestEditor: View {
    @Binding var crest: Crest
    /// Cosmetic item ids that unlock pieces (owned by me or my club).
    let unlocked: Set<String>

    var body: some View {
        Section {
            HStack {
                Spacer()
                CrestView(crest: crest, size: 96)
                Spacer()
            }
            .padding(.vertical, DS.Spacing.s)
            .listRowBackground(Color.clear)
        }
        Section {
            pieceRow(title: "Forma", pieces: CrestCatalog.shapes, selection: crest.shape) { crest.shape = $0 }
            pieceRow(title: "Fondo", pieces: CrestCatalog.patterns, selection: crest.pattern) { crest.pattern = $0 }
            iconGrid
        } header: {
            Text("Escudo")
        } footer: {
            Text("Las piezas con candado se desbloquean con cofres y retos de cualquier miembro del club.")
        }
        Section {
            colorRow(title: "Color principal", selection: crest.primary) { crest.primary = $0 }
            colorRow(title: "Color secundario", selection: crest.secondary) { crest.secondary = $0 }
            TextField("Iniciales (hasta 3)", text: Binding(
                get: { crest.initials },
                set: { crest.initials = String($0.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(3)) }
            ))
            .textInputAutocapitalization(.characters)
        } header: {
            Text("Colores e iniciales")
        }
    }

    private func isLocked(_ piece: CrestCatalog.Piece) -> Bool {
        guard let unlock = piece.unlock else { return false }
        return !unlocked.contains(unlock)
    }

    private func pieceRow(title: String, pieces: [CrestCatalog.Piece], selection: String, onSelect: @escaping (String) -> Void) -> some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Text(title)
                .font(.subheadline.weight(.medium))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(pieces) { piece in
                        let locked = isLocked(piece)
                        ChipToggle(
                            title: piece.label,
                            isOn: selection == piece.id,
                            systemImage: locked ? "lock" : nil
                        ) {
                            if !locked { onSelect(piece.id) }
                        }
                        .opacity(locked ? 0.5 : 1)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private var iconGrid: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Text("Icono")
                .font(.subheadline.weight(.medium))
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 5), spacing: 8) {
                ForEach(CrestCatalog.icons) { piece in
                    let locked = isLocked(piece)
                    Button {
                        if !locked { crest.icon = piece.id }
                    } label: {
                        Image(systemName: locked ? "lock" : piece.id)
                            .font(.system(size: 18, weight: .medium))
                            .foregroundStyle(crest.icon == piece.id ? Color.onBrand : (locked ? Color.secondary : Color.primary))
                            .frame(width: 44, height: 44)
                            .background(
                                crest.icon == piece.id ? Color.brand : Color.surfaceRaised,
                                in: RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous)
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(locked ? "\(piece.label), bloqueado" : piece.label)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func colorRow(title: String, selection: String, onSelect: @escaping (String) -> Void) -> some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Text(title)
                .font(.subheadline.weight(.medium))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(CrestCatalog.colors, id: \.self) { hex in
                        Button {
                            onSelect(hex)
                        } label: {
                            Circle()
                                .fill(Color(hex: hex))
                                .frame(width: 30, height: 30)
                                .overlay(Circle().strokeBorder(Color.hairline, lineWidth: 1))
                                .overlay(
                                    Circle()
                                        .strokeBorder(Color.primary, lineWidth: selection.uppercased() == hex.uppercased() ? 2.5 : 0)
                                        .padding(-4)
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(hex)
                    }
                }
                .padding(6)
            }
        }
    }
}
