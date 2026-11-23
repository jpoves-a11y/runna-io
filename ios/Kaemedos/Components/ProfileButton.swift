import SwiftUI

/// My avatar: opens "Perfil y ajustes". Lives at the top of every tab (there's no Profile tab).
struct ProfileButton: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    var size: CGFloat = 32

    var body: some View {
        Button {
            router.showProfile = true
        } label: {
            if let user = session.user {
                AvatarView(name: user.name, avatar: user.avatar, color: user.color, size: size)
            } else {
                Image(systemName: "person.crop.circle")
                    .font(.system(size: size * 0.8))
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Perfil y ajustes")
    }
}

/// Toolbar slot for `ProfileButton` (top left).
struct ProfileToolbarItem: ToolbarContent {
    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            ProfileButton()
        }
    }
}
