import SwiftUI

@main
struct RunnaApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var session = SessionStore()
    @State private var router = AppRouter.shared
    @State private var runTracker = RunTracker()

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
                .onOpenURL { url in
                    router.handle(url: url)
                }
        }
    }
}
