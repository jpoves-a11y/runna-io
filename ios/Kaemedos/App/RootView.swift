import SwiftUI

struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.scenePhase) private var scenePhase
    /// The KM2 → KM² intro plays once per launch, over whatever is loading behind it.
    @State private var introDone = false

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
        // A newer version in the App Store: announced, and required after a day (AppUpdate)
        .appUpdateGate()
        .overlay {
            if !introDone {
                KM2IntroView {
                    withAnimation(.easeOut(duration: 0.35)) { introDone = true }
                }
                .transition(.opacity)
            }
        }
        .task {
            await session.bootstrap()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { session.appBecameActive() }
        }
    }
}

/// While the session loads (after the intro, if it takes longer): the KM² logo on black, as the
/// launch screen and the intro, with a quiet spinner.
struct SplashView: View {
    var body: some View {
        ZStack {
            Color.black
                .ignoresSafeArea()
            KM2Logo(size: 96, onDark: true, tagline: true)
            VStack {
                Spacer()
                ProgressView()
                    .controlSize(.regular)
                    .tint(.white)
                    .padding(.bottom, DS.Spacing.xxxl)
            }
        }
    }
}

struct MainTabView: View {
    @Environment(AppRouter.self) private var router
    @Environment(RunTracker.self) private var tracker
    @Environment(SessionStore.self) private var session
    @AppStorage(OnboardingView.doneKey) private var onboardingDone = false
    /// First-login guided tour over the real app (GuidedTour.swift)
    @State private var tour = TourController.shared
    /// For the unread chat messages on the Club tab
    @State private var clubModel = ClubModel.shared

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
            ClubTabView()
                .tabItem { Label("Club", systemImage: "shield.lefthalf.filled") }
                .badge(clubModel.chatUnread)
                .tag(AppRouter.Tab.club)
        }
        .tint(Color.brand)
        .modifier(TabBarMinimizeOnScroll())
        // The guided tour covers everything, tab bar included
        .overlay {
            if tour.isActive {
                GuidedTourOverlay()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: tour.isActive)
        .sheet(isPresented: $router.showProfile) {
            ProfileView(isSheet: true)
        }
        .sensoryFeedback(.selection, trigger: router.selectedTab)
        .fullScreenCover(isPresented: Binding(
            get: { tracker.isPresented },
            set: { tracker.isPresented = $0 }
        )) {
            RunView()
        }
        .modifier(PendingPhotosModifier())
        // Results of activities imported from a watch, shown on entering the app whatever the tab
        .conquestInbox()
        #if DEBUG
        .fullScreenCover(item: Binding(
            get: { router.weatherDemo.map { WeatherDemoKind(id: $0) } },
            set: { _ in router.weatherDemo = nil }
        )) { demo in
            WeatherDemoView(kind: demo.id)
        }
        .sheet(isPresented: Binding(get: { router.showClubFormDemo }, set: { router.showClubFormDemo = $0 })) {
            ClubFormView(mode: .create)
        }
        #endif
        .seasonResultsInbox()
        // My club (and its unread chat messages) on launch and whenever something changes
        .task(id: router.reloadSignal) { await clubModel.load() }
        // "Empezar una carrera" (Siri, Shortcuts, Control Center, runnaio://run/start)
        .onAppear {
            openRunIfRequested()
            Analytics.track("app_open")
            startTourIfNeeded()
        }
        .onChange(of: tracker.isPresented) { _, presented in
            if !presented { startTourIfNeeded() }
        }
        // Another account signed in on this device, or the account was refreshed from the server
        .onChange(of: session.user?.id) { _, _ in startTourIfNeeded() }
        .onReceive(NotificationCenter.default.publisher(for: StartRunRequest.notification)) { _ in
            openRunIfRequested()
        }
        .onChange(of: self.router.selectedTab) { _, tab in
            Analytics.track("tab_view", ["tab": String(describing: tab)])
        }
    }

    /// Once per device, after the first login: never on top of a run being recorded.
    private func startTourIfNeeded() {
        guard TourController.shouldShow(for: session.user), !TourController.isDisabledForTests, !tracker.isPresented, !tour.isActive else { return }
        let firstName = session.user?.name.split(separator: " ").first.map(String.init)
        tour.start(firstName: firstName, replay: false)
    }

    private func openRunIfRequested() {
        guard let source = StartRunRequest.consume() else { return }
        Analytics.track("start_run_intent", ["source": source])
        router.showProfile = false
        guard !tracker.isPresented else { return }
        tracker.autoStartRequested = true
        tracker.isPresented = true
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
