import SwiftUI
import UIKit

/// The 3D artwork of a power (asset "power_<id>", rendered models), on a soft glow of its rarity.
/// Items without artwork (titles, crest pieces) fall back to their SF Symbol.
struct PowerArt: View {
    let itemId: String
    let rarity: String
    var size: CGFloat
    var glow = true

    private var image: UIImage? { UIImage(named: "power_\(itemId)") }

    var body: some View {
        ZStack {
            if glow {
                Circle()
                    .fill(RadialGradient(
                        colors: [Self.glowColor(rarity).opacity(0.5), Self.glowColor(rarity).opacity(0)],
                        center: .center, startRadius: 0, endRadius: size * 0.62
                    ))
                    .frame(width: size * 1.25, height: size * 1.25)
            }
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .frame(width: size, height: size)
                    .shadow(color: .black.opacity(0.25), radius: size * 0.04, y: size * 0.03)
            } else {
                Image(systemName: PowerSymbol.name(itemId))
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(Rarity.color(rarity))
                    .frame(width: size, height: size)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// Glow behind the artwork: copper, steel blue, purple and diamond blue.
    static func glowColor(_ rarity: String) -> Color {
        switch rarity {
        case "rare": return Color(red: 0.45, green: 0.66, blue: 1)
        case "epic": return Color(red: 0.69, green: 0.45, blue: 1)
        case "legendary": return Color(red: 0.3, green: 0.76, blue: 1)
        default: return Color(red: 1, green: 0.6, blue: 0.3)
        }
    }
}

/// Where a power counts, as an icon: the globe (global map), two flags (club competition) or a gift
/// (rest days). Tap it to read what it means.
struct PowerScopeBadge: View {
    let scope: String
    var size: CGFloat = 26

    @State private var showInfo = false

    private var symbol: String {
        switch scope {
        case "global": return "globe.europe.africa.fill"
        case "rest": return "gift.fill"
        case "cosmetic": return "paintbrush.fill"
        default: return "flag.2.crossed.fill"
        }
    }

    private var title: String {
        switch scope {
        case "global": return "Global"
        case "rest": return "Descanso"
        case "cosmetic": return "Cosmético"
        default: return "Competición"
        }
    }

    private var explanation: String {
        switch scope {
        case "global": return "Suma en tu mapa global, con tope: como mucho 1 km² extra por carrera."
        case "rest": return "Para encontrar y abrir cofres (salen todos los días)."
        case "cosmetic": return "Para siempre: un título o una pieza para el escudo de tu club."
        default: return "Solo cuenta en la competición de tu club."
        }
    }

    var body: some View {
        Button {
            showInfo = true
        } label: {
            Image(systemName: symbol)
                .font(.system(size: size * 0.5, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: size, height: size)
                .background(Color.secondary.opacity(0.12), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityHint(explanation)
        .popover(isPresented: $showInfo) {
            VStack(alignment: .leading, spacing: 4) {
                Label(title, systemImage: symbol)
                    .font(.subheadline.weight(.semibold))
                Text(explanation)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(DS.Spacing.m)
            .frame(width: 260, alignment: .leading)
            .presentationCompactAdaptation(.popover)
        }
    }
}
