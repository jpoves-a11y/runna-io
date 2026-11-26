import SwiftUI

@main
struct KaemedosApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var session = SessionStore()
    @State private var router = AppRouter.shared
    @State private var runTracker = RunTracker()
    @AppStorage(AppAppearance.storageKey) private var appearance: AppAppearance = .system

    init() {
        // Avatars and other remote images survive relaunches (the default cache is tiny)
        URLCache.shared = URLCache(memoryCapacity: 16 * 1024 * 1024, diskCapacity: 150 * 1024 * 1024, directory: nil)
        // Unread chat messages on the Club tab: a green sphere, like the rest of the app's counts
        let badge = UITabBarItem.appearance()
        badge.badgeColor = UIColor(Color.brand)
        badge.setBadgeTextAttributes([.foregroundColor: UIColor(Color.onBrand), .font: UIFont.systemFont(ofSize: 12, weight: .bold)], for: .normal)
        #if DEBUG
        // e2e tests open a screen at launch (simctl openurl shows a confirmation prompt instead)
        if let link = ProcessInfo.processInfo.environment["KAEMEDOS_TEST_DEEP_LINK"], let url = URL(string: link) {
            AppRouter.shared.handle(url: url)
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .environment(router)
                .environment(runTracker)
                .tint(.brand)
                .preferredColorScheme(appearance.colorScheme)
                .onOpenURL { url in
                    router.handle(url: url)
                }
                // Universal links (invites shared as https links) when the scene gets them as an activity
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { router.handle(url: url) }
                }
        }
    }
}

/// Light / dark mode chosen in Profile ("Sistema" follows the iPhone setting).
enum AppAppearance: String, CaseIterable, Identifiable {
    case system, light, dark

    static let storageKey = "appearance"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "Sistema"
        case .light: return "Claro"
        case .dark: return "Oscuro"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}
