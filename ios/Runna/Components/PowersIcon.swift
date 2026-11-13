import SwiftUI

/// The Poderes icon: the silhouette of one of the game's chests, in the current foreground colour.
struct PowersIcon: View {
    static let asset = "chest_epic"
    var size: CGFloat = 20

    var body: some View {
        Image(Self.asset)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
