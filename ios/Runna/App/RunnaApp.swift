import SwiftUI

@main
struct RunnaApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var session = SessionStore()
    @State private var router = AppRouter.shared
    @State private var runTracker = RunTracker()

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
