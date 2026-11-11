import SwiftUI
import CoreLocation

/// Profile section of the game: global map, home city (country / city rankings), streak and title.
struct GameProfileSection: View {
    @State private var season = SeasonStore.shared
    @State private var detected: DetectedCity?
    @State private var isLocating = false
    @State private var errorMessage: String?
    @State private var showInventory = false
    @State private var locator: OneShotLocation?

    var body: some View {
        Section {
            if let me = season.globalMe {
                HStack {
                    SocialSettingsLabel(title: "Mapa global", systemImage: "globe.europe.africa")
                    Spacer()
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(Format.area(me.area))
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                        if let rank = me.worldRank {
                            Text("Puesto \(rank) del mundo")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                if me.monthArea > 0 {
                    HStack {
                        SocialSettingsLabel(title: "Este mes", systemImage: "calendar")
                        Spacer()
                        Text(monthText(me))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                }
                Button {
                    locate()
                } label: {
                    HStack {
                        SocialSettingsLabel(title: "Ciudad base", systemImage: "mappin.and.ellipse")
                        Spacer()
                        if isLocating {
                            ProgressView()
                        } else {
                            Text(cityText(me))
                                .font(.subheadline)
                                .foregroundStyle(me.city == nil ? Color.brand : Color.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                .disabled(isLocating)
                if me.streakDays > 0 {
                    HStack {
                        SocialSettingsLabel(title: "Racha", systemImage: "flame")
                        Spacer()
                        Text(me.streakDays == 1 ? "1 día" : "\(me.streakDays) días seguidos")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                Button {
                    showInventory = true
                } label: {
                    HStack {
                        SocialSettingsLabel(title: "Inventario y título", systemImage: "bag")
                        Spacer()
                        Text(GameTitle.name(me.title) ?? "Sin título")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                HStack {
                    SocialSettingsLabel(title: "Mapa global", systemImage: "globe.europe.africa")
                    Spacer()
                    ProgressView()
                }
            }
        } header: {
            SocialSectionHeader(title: "Juego")
        } footer: {
            Text("Tu ciudad base decide los rankings de país y ciudad. Puedes cambiarla una vez cada 30 días. Nadie ve dónde vives: los rankings solo muestran el área total.")
        }
        .listRowBackground(Color.surface)
        .task { await season.load(force: false) }
        .sheet(isPresented: $showInventory, onDismiss: { Task { await season.load(force: true) } }) {
            InventorySheet()
        }
        .confirmationDialog(
            confirmTitle,
            isPresented: Binding(get: { detected != nil }, set: { if !$0 { detected = nil } }),
            titleVisibility: .visible
        ) {
            Button("Guardar") {
                if let detected { save(detected) }
            }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("La usaremos para los rankings de tu país y tu ciudad y para los cofres de los clubes.")
        }
        .errorAlert($errorMessage)
    }

    private func monthText(_ me: GlobalMe) -> String {
        let area = Format.area(me.monthArea)
        guard let rank = me.monthRank else { return area }
        return "\(area) · \(rank)º"
    }

    private func cityText(_ me: GlobalMe) -> String {
        guard let city = me.city else { return "Elegir" }
        guard let country = me.countryName else { return city }
        return "\(city), \(country)"
    }

    private var confirmTitle: String {
        guard let detected else { return "" }
        return "¿Tu ciudad base es \(detected.city) (\(detected.countryName))?"
    }

    private func locate() {
        isLocating = true
        Task {
            defer { isLocating = false }
            do {
                let finder = OneShotLocation()
                locator = finder
                let location = try await finder.current()
                locator = nil
                let placemarks = try await CLGeocoder().reverseGeocodeLocation(location, preferredLocale: Locale(identifier: "es_ES"))
                guard let placemark = placemarks.first,
                      let city = placemark.locality ?? placemark.subAdministrativeArea,
                      let code = placemark.isoCountryCode else {
                    errorMessage = "No hemos podido saber en qué ciudad estás. Inténtalo con mejor cobertura."
                    return
                }
                detected = DetectedCity(
                    city: city,
                    countryCode: code,
                    countryName: placemark.country ?? code,
                    latitude: location.coordinate.latitude,
                    longitude: location.coordinate.longitude
                )
            } catch let error as OneShotLocation.Failure {
                locator = nil
                errorMessage = error.message
            } catch {
                locator = nil
                errorMessage = "No hemos podido obtener tu ubicación. \(error.localizedDescription)"
            }
        }
    }

    private func save(_ city: DetectedCity) {
        Task {
            do {
                try await APIClient.shared.send("PATCH", "/api/users/me/location", body: [
                    "city": city.city,
                    "countryCode": city.countryCode,
                    "countryName": city.countryName,
                    "lat": city.latitude,
                    "lng": city.longitude,
                ])
                Haptics.success()
                await season.load(force: true)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct DetectedCity {
    let city: String
    let countryCode: String
    let countryName: String
    let latitude: Double
    let longitude: Double
}

/// One location fix (approximate is enough: it only tells the city), asking for permission if needed.
@MainActor
final class OneShotLocation: NSObject, CLLocationManagerDelegate {
    struct Failure: Error {
        let message: String
    }

    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation, Error>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
    }

    func current() async throws -> CLLocation {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<CLLocation, Error>) in
            self.continuation = continuation
            switch manager.authorizationStatus {
            case .notDetermined:
                manager.requestWhenInUseAuthorization()
            case .denied, .restricted:
                finish(.failure(Failure(message: "Runna no tiene permiso para usar tu ubicación. Actívalo en Ajustes.")))
            default:
                manager.requestLocation()
            }
        }
    }

    private func finish(_ result: Result<CLLocation, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
    }

    private func authorizationChanged() {
        guard continuation != nil else { return }
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            manager.requestLocation()
        case .denied, .restricted:
            finish(.failure(Failure(message: "Runna no tiene permiso para usar tu ubicación. Actívalo en Ajustes.")))
        default:
            break
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        MainActor.assumeIsolated {
            self.finish(.success(location))
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        MainActor.assumeIsolated {
            self.finish(.failure(error))
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        MainActor.assumeIsolated {
            self.authorizationChanged()
        }
    }
}
