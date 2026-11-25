import SwiftUI

/// A segmented switch whose segments can carry a count: a small green sphere at the top right of the
/// title, like a notification badge (unread chat messages). Used for Club · Chat · Amigos and for
/// the two chats of a competition (Competición · Mi equipo).
struct BadgedSwitch<ID: Hashable>: View {
    struct Segment: Identifiable {
        let id: ID
        let title: String
        var badge: Int = 0
    }

    let segments: [Segment]
    @Binding var selection: ID

    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 2) {
            ForEach(segments) { segment in
                let selected = segment.id == selection
                Button {
                    guard !selected else { return }
                    Haptics.tap()
                    withAnimation(.snappy(duration: 0.25)) { selection = segment.id }
                } label: {
                    Text(segment.title)
                        .font(.subheadline.weight(selected ? .semibold : .medium))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .foregroundStyle(selected ? Color.primary : Color.secondary)
                        .padding(.horizontal, DS.Spacing.m)
                        .padding(.vertical, 6)
                        .frame(maxWidth: .infinity)
                        .overlay(alignment: .topTrailing) {
                            if segment.badge > 0 {
                                CountBadge(count: segment.badge)
                                    .offset(x: 2, y: -7)
                                    .transition(.scale.combined(with: .opacity))
                            }
                        }
                        .background {
                            if selected {
                                Capsule()
                                    .fill(Color.surfaceRaised)
                                    .shadow(color: .black.opacity(0.12), radius: 3, y: 1)
                                    .matchedGeometryEffect(id: "thumb", in: thumb)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(segment.badge > 0 ? "\(segment.title), \(segment.badge) sin leer" : segment.title)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Color.primary.opacity(0.07), in: Capsule())
        .animation(.snappy(duration: 0.25), value: segments.map(\.badge))
    }
}

/// The green notification sphere with a count (99+ at most).
struct CountBadge: View {
    let count: Int

    var body: some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(.system(size: 11, weight: .bold).monospacedDigit())
            .foregroundStyle(Color.onBrand)
            .padding(.horizontal, count > 9 ? 5 : 0)
            .frame(minWidth: 18, minHeight: 18)
            .background(Color.brand, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.canvas, lineWidth: 1.5))
            .fixedSize()
    }
}
