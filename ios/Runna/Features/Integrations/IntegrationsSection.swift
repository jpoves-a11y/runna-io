import SwiftUI
import AuthenticationServices

/// Strava, Polar and Apple Health connections.
struct IntegrationsSection: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession

    @State private var strava: StravaStatus?
    @State private var polar: PolarStatus?
    @State private var busyProvider: String?
    @State private var message: String?
    @State private var health = HealthImporter.shared
    @State private var healthAutoImport = HealthImporter.shared.autoImport

    var body: some View {
        Section {
            providerRow(
                name: "Strava",
                systemImage: "bolt.horizontal.circle.fill",
                tint: Color(hex: "#FC4C02"),
                connected: strava?.connected == true,
                detail: stravaDetail,
                provider: "strava"
            )
            providerRow(
                name: "Polar",
                systemImage: "heart.circle.fill",
                tint: Color(hex: "#D10027"),
                connected: polar?.connected == true,
                detail: polarDetail,
                provider: "polar"
            )
            if HealthImporter.isAvailable {
                healthRow
            }
        } header: {
            Text("Conectar dispositivos")
        } footer: {
            Text("Las carreras que registres en Strava, Polar o en el Apple Watch (Apple Salud) se convierten en territorio.")
        }
        .task(id: router.reloadSignal) { await loadStatus() }
        .alert("Integraciones", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(message ?? "")
        }
    }

    private var stravaDetail: String? {
        guard let strava, strava.connected else { return nil }
        let name = [strava.athlete?.firstname, strava.athlete?.lastname].compactMap { $0 }.joined(separator: " ")
        return name.isEmpty ? "Conectado" : name
    }

    private var polarDetail: String? {
        guard let polar, polar.connected else { return nil }
        if let last = APIDate.parse(polar.lastSyncAt) {
            return "Sincronizado \(Format.relative(last))"
        }
        return "Conectado"
    }

    private func providerRow(name: String, systemImage: String, tint: Color, connected: Bool, detail: String?, provider: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.title2)
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.body.weight(.medium))
                Text(detail ?? "No conectado")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if busyProvider == provider {
                ProgressView()
            } else if connected {
                Menu {
                    Button("Sincronizar ahora", systemImage: "arrow.triangle.2.circlepath") {
                        Task { await sync(provider) }
                    }
                    Button("Desconectar", systemImage: "link.badge.minus", role: .destructive) {
                        Task { await disconnect(provider) }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.title3)
                }
                .accessibilityLabel("Opciones de \(name)")
            } else {
                Button("Conectar") {
                    Task { await connect(provider) }
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private var healthRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Image(systemName: "heart.text.square.fill")
                    .font(.title2)
                    .foregroundStyle(.pink)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Apple Salud").font(.body.weight(.medium))
                    Text("Carreras del Apple Watch y otras apps")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if health.isImporting {
                    ProgressView()
                } else {
                    Button("Importar") {
                        Task { await importFromHealth() }
                    }
                    .buttonStyle(.bordered)
                }
            }
            Toggle("Importar automáticamente", isOn: $healthAutoImport)
                .font(.subheadline)
                .onChange(of: healthAutoImport) { _, enabled in
                    health.autoImport = enabled
                    if enabled { Task { await importFromHealth() } }
                }
        }
    }

    // MARK: - Actions

    private func loadStatus() async {
        guard let userId = session.userId else { return }
        async let stravaStatus = try? APIClient.shared.request("GET", "/api/strava/status/\(userId)", as: StravaStatus.self)
        async let polarStatus = try? APIClient.shared.request("GET", "/api/polar/status/\(userId)", as: PolarStatus.self)
        strava = await stravaStatus
        polar = await polarStatus
    }

    private func connect(_ provider: String) async {
        busyProvider = provider
        defer { busyProvider = nil }
        do {
            let response = try await APIClient.shared.request(
                "GET", "/api/\(provider)/connect", query: ["client": "ios"], as: AuthURLResponse.self
            )
            guard let url = URL(string: response.authUrl) else { return }
            let callback = try await webAuthenticationSession.authenticate(
                using: url,
                callbackURLScheme: AppConfig.urlScheme,
                preferredBrowserSession: .shared
            )
            let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
            if let error = query.first(where: { $0.name == "\(provider)_error" })?.value {
                message = Self.describe(error: error, provider: provider)
            } else {
                Haptics.success()
                message = "\(provider.capitalized) conectado. Importando tus actividades…"
                await loadStatus()
                await sync(provider, quiet: true)
            }
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            return
        } catch {
            message = error.localizedDescription
        }
    }

    private func disconnect(_ provider: String) async {
        busyProvider = provider
        defer { busyProvider = nil }
        do {
            try await APIClient.shared.send("POST", "/api/\(provider)/disconnect", body: [:])
            await loadStatus()
        } catch {
            message = error.localizedDescription
        }
    }

    /// Pulls new activities from the provider, then turns them into territory (in batches).
    private func sync(_ provider: String, quiet: Bool = false) async {
        guard let userId = session.userId else { return }
        busyProvider = provider
        defer { busyProvider = nil }
        do {
            let synced = try await APIClient.shared.request("POST", "/api/\(provider)/sync/\(userId)", body: [:], as: SyncResponse.self)
            var processed = 0
            for _ in 0..<10 {
                let result = try await APIClient.shared.request("POST", "/api/\(provider)/process/\(userId)", body: [:], as: SyncResponse.self)
                processed += result.processed ?? 0
                if (result.remaining ?? 0) == 0 || (result.processed ?? 0) == 0 { break }
            }
            await loadStatus()
            router.reloadSignal += 1
            if !quiet || processed > 0 {
                message = processed > 0
                    ? "Se han procesado \(processed) actividad(es) nuevas."
                    : (synced.message ?? "No hay actividades nuevas.")
            }
        } catch {
            message = error.localizedDescription
        }
    }

    private func importFromHealth() async {
        do {
            let summary = try await health.importRecentRuns(days: 30)
            if summary.imported > 0 { router.reloadSignal += 1 }
            message = summary.message
        } catch {
            message = error.localizedDescription
        }
    }

    private static func describe(error: String, provider: String) -> String {
        switch error {
        case "denied": return "Has cancelado la conexión con \(provider.capitalized)."
        case "already_linked": return "Esa cuenta de \(provider.capitalized) ya está conectada a otro usuario de Runna.io."
        case "invalid_state": return "La conexión ha caducado. Inténtalo de nuevo."
        default: return "No se ha podido conectar con \(provider.capitalized) (\(error))."
        }
    }
}
