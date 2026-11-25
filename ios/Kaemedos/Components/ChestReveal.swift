import SwiftUI

/// What a chest had inside. The map never shows it: it appears once the chest is opened.
struct ChestContent: Equatable {
    let itemId: String
    let name: String
    let rarity: String
    /// What it does (or its scope)
    var detail: String?
}

/// Full screen: the chest opens in 3D, then what was inside rises into view.
struct ChestRevealOverlay: View {
    let content: ChestContent
    var buttonTitle = "Recoger"
    let onDone: () -> Void

    @State private var revealed = false

    var body: some View {
        ZStack(alignment: .bottom) {
            ChestOpening3DView(rarity: content.rarity) {
                withAnimation(.spring(response: 0.55, dampingFraction: 0.78)) { revealed = true }
            }
            .ignoresSafeArea()

            if revealed {
                VStack(spacing: DS.Spacing.m) {
                    PowerArt(itemId: content.itemId, rarity: content.rarity, size: 128)
                    Text(content.name)
                        .font(.title2.weight(.semibold))
                        .multilineTextAlignment(.center)
                    RarityPill(rarity: content.rarity)
                    if let detail = content.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Button(buttonTitle, action: onDone)
                        .buttonStyle(PrimaryButtonStyle())
                        .padding(.top, DS.Spacing.s)
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, DS.Spacing.screen)
                .padding(.bottom, DS.Spacing.xxl)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .environment(\.colorScheme, .dark)
    }
}

/// Chests already opened on this iPhone: their power is shown at once, without the animation again.
enum RevealedChests {
    private static let key = "revealedChestIds"
    private static let limit = 300

    static func contains(_ id: String) -> Bool {
        (UserDefaults.standard.stringArray(forKey: key) ?? []).contains(id)
    }

    static func insert(_ id: String) {
        var ids = UserDefaults.standard.stringArray(forKey: key) ?? []
        guard !ids.contains(id) else { return }
        ids.append(id)
        UserDefaults.standard.set(Array(ids.suffix(limit)), forKey: key)
    }
}
