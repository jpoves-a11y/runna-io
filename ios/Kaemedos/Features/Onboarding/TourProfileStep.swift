import SwiftUI

/// Content of the tour's "Completa tu perfil" step: the base city (required to join a club; found
/// with the location and confirmed here) and the territory colour.
///
/// "Siguiente" stays locked until the city is saved. Without location permission the card explains why
/// it's needed and insists once (Ajustes); after that "Lo haré luego" lets the tour go on, and the Club
/// tab keeps asking for it.
struct TourProfileStep: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.scenePhase) private var scenePhase
    @State private var season = SeasonStore.shared
    @State private var tour = TourController.shared
    @State private var locator = BaseCityLocator()
    @State private var color = ""
    /// We already insisted on the permission once (opened Ajustes or tried again).
    @State private var insisted = false
    @State private var colorSave: Task<Void, Never>?

    private var city: String? { season.globalMe?.city }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.l) {
            citySection
            colorSection
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task {
            color = session.user?.color ?? ""
            if season.globalMe == nil { await season.load(force: false) }
            syncReady()
        }
        .onChange(of: city) { _, _ in syncReady() }
        .onChange(of: scenePhase) { _, phase in
            // Back from Ajustes with the permission granted: find the city right away
            if phase == .active, locator.phase == .denied, !BaseCityLocator.isDenied {
                Task { await locator.locate() }
            }
        }
        .onChange(of: color) { _, newColor in saveColor(newColor) }
    }

    private func syncReady() {
        if city != nil { tour.markProfileReady() }
    }

    // MARK: City

    private var citySection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            label("Ciudad base")
            if let city {
                Label {
                    Text(season.globalMe?.countryName.map { "\(city), \($0)" } ?? city)
                        .font(.body.weight(.semibold))
                } icon: {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.brand)
                }
                .transition(.opacity)
            } else {
                cityFinder
            }
        }
        .animation(.snappy, value: locator.phase)
        .animation(.snappy, value: city)
    }

    @ViewBuilder
    private var cityFinder: some View {
        switch locator.phase {
        case .idle, .failed:
            Button {
                Task { await locator.locate() }
            } label: {
                Label("Detectar mi ciudad", systemImage: "location.fill")
            }
            .buttonStyle(SecondaryButtonStyle(tint: .brand))
            if case .failed(let message) = locator.phase {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(Color.steal)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .locating, .saving:
            HStack(spacing: DS.Spacing.s) {
                ProgressView()
                Text(locator.phase == .saving ? "Guardando…" : "Buscando tu ciudad…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(minHeight: 36)
        case .confirm(let detected):
            Text("¿Tu ciudad base es **\(detected.city)** (\(detected.countryName))?")
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: DS.Spacing.s) {
                Button("Sí, guardar") {
                    Task { await locator.save(detected) }
                }
                .buttonStyle(SecondaryButtonStyle(tint: .brand))
                Button("No") { locator.reset() }
                    .buttonStyle(SecondaryButtonStyle(tint: .primary))
            }
        case .denied:
            Text("Sin tu ubicación no podemos saber en qué ciudad corres, y la necesitas para unirte a un club. Dale permiso en Ajustes → KM2 → Ubicación.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: DS.Spacing.s) {
                Button {
                    insisted = true
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Label("Abrir Ajustes", systemImage: "gear")
                }
                .buttonStyle(SecondaryButtonStyle(tint: .brand))
                Button("Reintentar") {
                    insisted = true
                    Task { await locator.locate() }
                }
                .buttonStyle(SecondaryButtonStyle(tint: .primary))
            }
            if insisted && !tour.profileReady {
                Button("Lo haré luego") {
                    Haptics.tap()
                    tour.markProfileReady()
                }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .transition(.opacity)
            }
        }
    }

    // MARK: Colour

    private var colorSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            label("Color de tu territorio")
            TerritoryColorPicker(selection: $color, swatchSize: 28, spacing: 8)
        }
    }

    /// Saved a moment after the last tap.
    private func saveColor(_ newColor: String) {
        colorSave?.cancel()
        guard !newColor.isEmpty, newColor.uppercased() != session.user?.color.uppercased() else { return }
        colorSave = Task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            guard !Task.isCancelled else { return }
            try? await session.updateProfile(color: newColor)
        }
    }

    private func label(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .tracking(1.2)
            .foregroundStyle(.secondary)
    }
}
