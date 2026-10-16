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

/// Launch screen while the session loads: brand gradient, pulsing rings and the runner.
struct SplashView: View {
    @State private var animate = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Rectangle()
                .fill(.brandGradient)
                .ignoresSafeArea()
            rings
            VStack(spacing: 18) {
                logo
                VStack(spacing: 6) {
                    Text("Runna.io")
                        .font(.system(size: 40, weight: .heavy, design: .rounded))
                    Text("Corre. Conquista. Repite.")
                        .font(.system(.headline, design: .rounded, weight: .semibold))
                        .opacity(0.85)
                }
                .foregroundStyle(.white)
                ProgressView()
                    .tint(.white)
                    .padding(.top, 8)
            }
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeOut(duration: 2.2).repeatForever(autoreverses: false)) {
                animate = true
            }
        }
    }

    private var logo: some View {
        Image(systemName: "figure.run")
            .font(.system(size: 54, weight: .bold))
            .foregroundStyle(Color.brandDeep)
            .frame(width: 112, height: 112)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 32, style: .continuous))
            .shadow(color: .black.opacity(0.18), radius: 20, x: 0, y: 10)
            .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
    }

    private var rings: some View {
        ZStack {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .stroke(Color.white.opacity(0.35), lineWidth: 2)
                    .frame(width: 140, height: 140)
                    .scaleEffect(animate ? 2.6 + CGFloat(index) * 0.6 : 1)
                    .opacity(animate ? 0 : 0.8)
                    .offset(y: -44)
            }
        }
        .accessibilityHidden(true)
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
                .tabItem { Label("Actividad", systemImage: "flame.fill") }
                .tag(AppRouter.Tab.activity)
            FriendsView()
                .tabItem { Label("Amigos", systemImage: "person.2.fill") }
                .tag(AppRouter.Tab.friends)
            ProfileView()
                .tabItem { Label("Perfil", systemImage: "person.crop.circle.fill") }
                .tag(AppRouter.Tab.profile)
        }
        .tint(Color.brand)
        .modifier(TabBarMinimizeOnScroll())
        .sensoryFeedback(.selection, trigger: router.selectedTab)
        .fullScreenCover(isPresented: Binding(
            get: { tracker.isPresented },
            set: { tracker.isPresented = $0 }
        )) {
            RunView()
        }
        .fullScreenCover(isPresented: Binding(
            // Shown once, after the first login on this device (never on top of a run being recorded)
            get: { !onboardingDone && !tracker.isPresented && !OnboardingView.isDisabledForTests },
            set: { if !$0 { onboardingDone = true } }
        )) {
            OnboardingView {
                onboardingDone = true
            }
        }
        .modifier(PendingPhotosModifier())
    }
}

/// iOS 26: the Liquid Glass tab bar shrinks while scrolling down lists.
private struct TabBarMinimizeOnScroll: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            content
        }
    }
}
