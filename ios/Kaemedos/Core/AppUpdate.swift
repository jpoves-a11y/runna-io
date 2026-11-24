import Foundation
import Observation
import StoreKit
import UIKit

/// Keeps the app on the latest App Store version.
///
/// When the App Store has a newer version (Apple's lookup service, by bundle id, in the device's
/// store) it's announced, and once it has been out for `graceHours` the app can't be used until
/// it's updated: right after a release the App Store app may not offer it everywhere yet, so for
/// those first hours the notice can be closed. Never in TestFlight or debug builds, never while a
/// run is being recorded (RootView waits for it to end), and not when the new version needs a
/// newer iOS than the device has (it couldn't be installed).
@MainActor
@Observable
final class AppUpdate {
    static let shared = AppUpdate()

    enum State: Equatable {
        case upToDate
        /// Out, can still wait: a notice that can be closed.
        case available(version: String, url: URL)
        /// Out long enough: the app waits for the update.
        case required(version: String, url: URL)
    }

    private(set) var state: State = .upToDate
    /// The notice of this version was closed (this launch).
    var dismissedVersion: String?

    /// How long a new version can be skipped after it comes out.
    private static let graceHours: Double = 24
    /// Not more often than this when coming back to the app.
    private static let interval: TimeInterval = 30 * 60
    @ObservationIgnored private var lastCheck: Date?
    @ObservationIgnored private var isChecking = false

    var installedVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
    }

    func check(force: Bool = false) async {
        if !force, let lastCheck, Date().timeIntervalSince(lastCheck) < Self.interval { return }
        guard !isChecking else { return }
        isChecking = true
        defer { isChecking = false }
        #if DEBUG
        return
        #else
        guard await Self.isAppStoreBuild() else { return }
        lastCheck = Date()
        guard let release = await Self.latestRelease() else { return }
        guard Self.isNewer(release.version, than: installedVersion), Self.canInstall(release) else {
            state = .upToDate
            return
        }
        let hoursOut = release.releasedAt.map { Date().timeIntervalSince($0) / 3600 } ?? Self.graceHours
        state = hoursOut >= Self.graceHours
            ? .required(version: release.version, url: release.url)
            : .available(version: release.version, url: release.url)
        Analytics.track("app_update_shown", ["version": release.version, "required": hoursOut >= Self.graceHours])
        #endif
    }

    func openStore() {
        switch state {
        case .available(_, let url), .required(_, let url):
            UIApplication.shared.open(Self.storeURL(url))
        case .upToDate:
            break
        }
    }

    // MARK: App Store

    private struct Release {
        let version: String
        let url: URL
        let releasedAt: Date?
        let minimumOS: String?
    }

    private struct Lookup: Decodable {
        struct Result: Decodable {
            let version: String
            let trackViewUrl: String
            let currentVersionReleaseDate: String?
            let minimumOsVersion: String?
        }
        let results: [Result]
    }

    /// The version on sale in the device's store (then Spain's, where KM2 is).
    private static func latestRelease() async -> Release? {
        guard let bundleId = Bundle.main.bundleIdentifier else { return nil }
        var countries: [String] = []
        if let region = Locale.current.region?.identifier.lowercased(), region.count == 2 { countries.append(region) }
        if !countries.contains("es") { countries.append("es") }
        for country in countries {
            var components = URLComponents(string: "https://itunes.apple.com/lookup")
            components?.queryItems = [
                URLQueryItem(name: "bundleId", value: bundleId),
                URLQueryItem(name: "country", value: country),
                // The answer is cached by Apple's CDN: ask for a fresh one
                URLQueryItem(name: "t", value: String(Int(Date().timeIntervalSince1970)))
            ]
            guard let url = components?.url else { continue }
            var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 15)
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            guard let (data, _) = try? await URLSession.shared.data(for: request),
                  let lookup = try? JSONDecoder().decode(Lookup.self, from: data),
                  let result = lookup.results.first,
                  let page = URL(string: result.trackViewUrl) else { continue }
            let formatter = ISO8601DateFormatter()
            return Release(
                version: result.version,
                url: page,
                releasedAt: result.currentVersionReleaseDate.flatMap { formatter.date(from: $0) },
                minimumOS: result.minimumOsVersion
            )
        }
        return nil
    }

    /// Opens the App Store app straight on KM2's page.
    private static func storeURL(_ page: URL) -> URL {
        guard var components = URLComponents(url: page, resolvingAgainstBaseURL: false) else { return page }
        components.scheme = "itms-apps"
        return components.url ?? page
    }

    /// "1.10" is newer than "1.9"; "1.2" is the same as "1.2.0".
    static func isNewer(_ candidate: String, than installed: String) -> Bool {
        let a = candidate.split(separator: ".").map { Int($0) ?? 0 }
        let b = installed.split(separator: ".").map { Int($0) ?? 0 }
        for index in 0..<max(a.count, b.count) {
            let x = index < a.count ? a[index] : 0
            let y = index < b.count ? b[index] : 0
            if x != y { return x > y }
        }
        return false
    }

    private static func canInstall(_ release: Release) -> Bool {
        guard let minimum = release.minimumOS else { return true }
        return !isNewer(minimum, than: UIDevice.current.systemVersion)
    }

    /// Installed from the App Store (not TestFlight, not Xcode).
    private static func isAppStoreBuild() async -> Bool {
        if let result = try? await AppTransaction.shared, case .verified(let transaction) = result {
            return transaction.environment == .production
        }
        // Without an answer from StoreKit: TestFlight builds carry a sandbox receipt
        return Bundle.main.appStoreReceiptURL?.lastPathComponent != "sandboxReceipt"
    }
}
