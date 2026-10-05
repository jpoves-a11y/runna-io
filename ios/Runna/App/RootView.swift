import SwiftUI

struct RootView: View {
    @Environment(SessionStore.self) private var session

    var body: some View {
        Group {
            switch session.state {
            case .loading:
                SplashView()
            case .loggedOut:
                AuthView()
            case .loggedIn:
                MainTabView()
            }
        }
        .animation(.easeInOut(duration: 0.25), value: session.state)
        .task {
            await session.bootstrap()
        }
    }
}

struct SplashView: View {
    var body: some View {
        ZStack {
            Color.brand.ignoresSafeArea()
            VStack(spacing: 16) {
                Image(systemName: "figure.run")
                    .font(.system(size: 64, weight: .bold))
                    .foregroundStyle(.white)
                Text("Runna.io")
                    .font(.largeTitle.bold())
                    .foregroundStyle(.white)
                ProgressView()
                    .tint(.white)
            }
        }
    }
}

struct MainTabView: View {
    @Environment(AppRouter.self) private var router
    @Environment(RunTracker.self) private var tracker

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.selectedTab) {
            MapScreen()
                .tabItem { Label("Mapa", systemImage: "map.fill") }
                .tag(AppRouter.Tab.map)
            RankingsView()
                .tabItem { Label("Ranking", systemImage: "trophy.fill") }
                .tag(AppRouter.Tab.rankings)
            ActivityView()
                .tabItem { Label("Actividad", systemImage: "figure.run") }
                .tag(AppRouter.Tab.activity)
            FriendsView()
                .tabItem { Label("Amigos", systemImage: "person.2.fill") }
                .tag(AppRouter.Tab.friends)
            ProfileView()
                .tabItem { Label("Perfil", systemImage: "person.crop.circle.fill") }
                .tag(AppRouter.Tab.profile)
        }
        .fullScreenCover(isPresented: Binding(
            get: { tracker.isPresented },
            set: { tracker.isPresented = $0 }
        )) {
            RunView()
        }
        .modifier(PendingPhotosModifier())
    }
}
