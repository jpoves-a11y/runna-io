import SwiftUI

struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.scenePhase) private var scenePhase

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
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { session.appBecameActive() }
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
    @AppStorage(OnboardingView.doneKey) private var onboardingDone = false

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
        .fullScreenCover(isPresented: Binding(
            // Shown once, after the first login on this device (never on top of a run being recorded)
            get: { !onboardingDone && !tracker.isPresented },
            set: { if !$0 { onboardingDone = true } }
        )) {
            OnboardingView {
                onboardingDone = true
            }
        }
        .modifier(PendingPhotosModifier())
    }
}
