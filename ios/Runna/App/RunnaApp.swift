import SwiftUI

@main
struct RunnaApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var session = SessionStore()
    @State private var router = AppRouter.shared
    @State private var runTracker = RunTracker()
    @AppStorage(AppAppearance.storageKey) private var appearance: AppAppearance = .system

    init() {
        #if DEBUG
        // e2e tests open a screen at launch (simctl openurl shows a confirmation prompt instead)
        if let link = ProcessInfo.processInfo.environment["RUNNA_TEST_DEEP_LINK"], let url = URL(string: link) {
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
