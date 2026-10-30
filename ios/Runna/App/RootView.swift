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

/// Launch screen while the session loads: plain system background, wordmark and a quiet spinner.
struct SplashView: View {
    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground)
                .ignoresSafeArea()
            VStack(spacing: DS.Spacing.s) {
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    Text("Runna")
                        .foregroundStyle(Color.primary)
                    Text(".io")
                        .foregroundStyle(Color.brand)
                }
                .font(.system(size: 40, weight: .bold))
                .tracking(-1)
                Text("Corre. Conquista. Repite.")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            VStack {
                Spacer()
                ProgressView()
                    .controlSize(.regular)
                    .padding(.bottom, DS.Spacing.xxxl)
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
                .tabItem { Label("Mapa", systemImage: "map") }
                .tag(AppRouter.Tab.map)
            RankingsView()
                .tabItem { Label("Ranking", systemImage: "list.number") }
                .tag(AppRouter.Tab.rankings)
            ActivityView()
                .tabItem { Label("Actividad", systemImage: "rectangle.stack") }
                .tag(AppRouter.Tab.activity)
            FriendsView()
                .tabItem { Label("Amigos", systemImage: "person.2") }
                .tag(AppRouter.Tab.friends)
            ProfileView()
                .tabItem { Label("Perfil", systemImage: "person.crop.circle") }
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
        #if DEBUG
        .overlay {
            if let page = router.widgetGalleryPage {
                WidgetGalleryView(page: page)
            }
        }
        #endif
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
