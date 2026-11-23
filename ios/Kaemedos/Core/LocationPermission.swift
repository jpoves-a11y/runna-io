import CoreLocation
import Observation
import UIKit

/// The app's permission to use the location, shared by the map's "my location" button and the
/// tour. Asks for it when it hasn't been asked yet, and says when it was refused (or the iPhone's
/// Location Services are off, which reports the same way) so the screen can point to Settings.
@MainActor
@Observable
final class LocationPermission: NSObject, CLLocationManagerDelegate {
    static let shared = LocationPermission()

    private(set) var status: CLAuthorizationStatus
    @ObservationIgnored private let manager: CLLocationManager
    @ObservationIgnored private var waiting: [CheckedContinuation<CLAuthorizationStatus, Never>] = []

    override init() {
        let manager = CLLocationManager()
        self.manager = manager
        status = manager.authorizationStatus
        super.init()
        manager.delegate = self
    }

    var isAllowed: Bool { status == .authorizedWhenInUse || status == .authorizedAlways }
    /// Refused, restricted, or Location Services turned off: only Settings can change it.
    var isDenied: Bool { status == .denied || status == .restricted }

    /// Asks for "while using the app" if it hasn't been asked yet; returns the answer.
    @discardableResult
    func request() async -> CLAuthorizationStatus {
        status = manager.authorizationStatus
        guard status == .notDetermined else { return status }
        return await withCheckedContinuation { continuation in
            waiting.append(continuation)
            manager.requestWhenInUseAuthorization()
        }
    }

    static func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in self.update(status) }
    }

    private func update(_ newStatus: CLAuthorizationStatus) {
        status = newStatus
        guard newStatus != .notDetermined else { return }
        let resumed = waiting
        waiting.removeAll()
        for continuation in resumed {
            continuation.resume(returning: newStatus)
        }
    }
}
