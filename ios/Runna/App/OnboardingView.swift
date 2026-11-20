import Foundation

/// First-launch settings shared by the guided tour (Features/Onboarding/GuidedTour.swift) and the
/// pop-ups that wait for it (conquest results, season results). The old four-page presentation was
/// replaced by the guided tour over the real app.
enum OnboardingView {
    /// UserDefaults flag: the first-login tour was completed on this device.
    static let doneKey = "onboardingDone"

    /// e2e tests start logged in and take screenshots: the tour would cover them.
    static var isDisabledForTests: Bool {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        return environment["RUNNA_TEST_TOKEN"] != nil && environment["RUNNA_TEST_ONBOARDING"] == nil
        #else
        return false
        #endif
    }
}
