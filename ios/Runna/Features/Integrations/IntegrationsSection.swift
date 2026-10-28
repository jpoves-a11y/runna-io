import SwiftUI
import AuthenticationServices

/// Strava, Polar, Suunto, Garmin, COROS and Apple Health connections.
struct IntegrationsSection: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession

    @State private var strava: StravaConnection?
    @State private var polar: PolarConnection?
    @State private var suunto: SuuntoConnection?
    @State private var garmin: GarminConnection?
    @State private var coros: CorosConnection?
    @State private var busyProvider: String?
    @State private var progressText: String?
    @State private var message: String?
    @State private var showStravaConsent = false
    @State private var providerToDisconnect: String?
    @State private var health = HealthImporter.shared
    @State private var healthAutoImport = HealthImporter.shared.autoImport

    private static let stravaOrange = IntegrationBrandMark.stravaOrange

    var body: some View {
        Section {
            stravaRow
            if strava?.connected == true {
                NavigationLink {
                    ImportedActivitiesView(provider: "strava")
                } label: {
                    activitiesLinkLabel(failed: strava?.failedActivities ?? 0)
                }
            }
            providerRow(
                name: "Polar",
                mark: .polar,
                connected: polar?.connected == true,
                detail: polarDetail,
                provider: "polar"
            )
            if polar?.connected == true {
                NavigationLink {
                    ImportedActivitiesView(provider: "polar")
                } label: {
                    activitiesLinkLabel(failed: polar?.failedActivities ?? 0)
                }
            }
            // Hidden until the server has the Suunto API keys (status says configured: false)
            if showSuunto {
                providerRow(
                    name: "Suunto",
                    mark: .suunto,
                    connected: suunto?.connected == true,
                    detail: suuntoDetail,
                    provider: "suunto"
                )
                if suunto?.connected == true {
                    NavigationLink {
                        ImportedActivitiesView(provider: "suunto")
                    } label: {
                        activitiesLinkLabel(failed: suunto?.failedActivities ?? 0)
                    }
                }
            }
            // Hidden until the server has the Garmin API keys (status says configured: false)
            if showGarmin {
                providerRow(
                    name: "Garmin",
                    mark: .garmin,
                    connected: garmin?.connected == true,
                    detail: garminDetail,
                    provider: "garmin"
                )
                if garmin?.connected == true {
                    NavigationLink {
                        ImportedActivitiesView(provider: "garmin")
                    } label: {
                        activitiesLinkLabel(failed: garmin?.failedActivities ?? 0)
                    }
                }
            }
            // Hidden until the server has the COROS API keys (status says configured: false)
            if showCoros {
                providerRow(
                    name: "COROS",
                    mark: .coros,
                    connected: coros?.connected == true,
                    detail: corosDetail,
                    provider: "coros"
                )
                if coros?.connected == true {
                    NavigationLink {
                        ImportedActivitiesView(provider: "coros")
                    } label: {
                        activitiesLinkLabel(failed: coros?.failedActivities ?? 0)
                    }
                }
            }
            if HealthImporter.isAvailable {
                healthRow
            }
        } header: {
            SocialSectionHeader(title: "Servicios conectados")
        } footer: {
            VStack(alignment: .leading, spacing: 8) {
                Text(footerText)
                if let url = URL(string: "https://www.strava.com") {
                    Link(destination: url) {
                        HStack(spacing: 4) {
                            Text("Powered by")
                                .foregroundStyle(.secondary)
                            Text("STRAVA").fontWeight(.heavy).foregroundStyle(Self.stravaOrange)
                        }
                        .font(.caption)
                    }
                    .accessibilityLabel("Powered by Strava")
                }
            }
        }
        .listRowBackground(Color.surface)
        .task(id: router.reloadSignal) { await loadStatus() }
        .alert("Integraciones", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(message ?? "")
        }
        .alert("Conectar con Strava", isPresented: $showStravaConsent) {
            Button("Acepto y conectar") {
                Task { await connect("strava") }
            }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("""
            Al conectar Strava:
            • Importaremos tus carreras de Strava a Runna.io.
            • Tus rutas se convertirán en territorio visible para tus amigos en el mapa.
            • Tu nombre de usuario aparecerá en el feed y en los rankings.
            • Puedes desconectar Strava cuando quieras desde tu perfil.

            Más información en la política de privacidad (Perfil > Información).
            """)
        }
        .confirmationDialog(
            "¿Desconectar \(providerToDisconnect.map(Self.displayName) ?? "")?",
            isPresented: Binding(get: { providerToDisconnect != nil }, set: { if !$0 { providerToDisconnect = nil } }),
            titleVisibility: .visible,
            presenting: providerToDisconnect
        ) { provider in
            Button("Desconectar", role: .destructive) {
                Task { await disconnect(provider) }
            }
            Button("Cancelar", role: .cancel) {}
        } message: { _ in
            Text("Ya no se importarán tus actividades nuevas. Tus rutas y territorios existentes no se borrarán.")
        }
    }

    // MARK: - Rows

    /// Width of the leading brand mark; detail lines below a row are indented by this plus the spacing.
    private static let markSize: CGFloat = 32
    private static let detailIndent: CGFloat = markSize + 12

    private var stravaRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                stravaIcon
                VStack(alignment: .leading, spacing: 2) {
                    Text("Strava")
                        .font(.body.weight(.semibold))
                    statusLine(connected: strava?.connected == true, detail: stravaDetail)
                    if let place = strava?.athlete?.place, strava?.connected == true {
                        Text(place)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                Spacer(minLength: 8)
                providerActions(name: "Strava", connected: strava?.connected == true, provider: "strava", tint: Self.stravaOrange)
            }
            if strava?.connected == true, let athleteId = strava?.athlete?.id,
               let url = URL(string: "https://www.strava.com/athletes/\(athleteId)") {
                Link(destination: url) {
                    HStack(spacing: 4) {
                        Text("Ver mi perfil en Strava")
                        Image(systemName: "arrow.up.right")
                            .font(.caption2.weight(.semibold))
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Self.stravaOrange)
                }
                .buttonStyle(.borderless)
                .padding(.leading, Self.detailIndent)
            }
            progressLine(for: "strava")
        }
        .padding(.vertical, 2)
    }

    /// Strava athlete photo when connected (with the Strava mark as a corner badge), else the mark.
    @ViewBuilder
    private var stravaIcon: some View {
        if let avatar = strava?.athlete?.profileMedium, let url = URL(string: avatar), strava?.connected == true {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    IntegrationBrandMark(brand: .strava, size: Self.markSize)
                }
            }
            .frame(width: Self.markSize, height: Self.markSize)
            .clipShape(Circle())
            .overlay(alignment: .bottomTrailing) {
                IntegrationBrandMark(brand: .strava, size: 14)
                    .offset(x: 3, y: 3)
            }
            .accessibilityHidden(true)
        } else {
            IntegrationBrandMark(brand: .strava, size: Self.markSize)
        }
    }

    /// Small dot + detail when connected, "No conectado" otherwise.
    private func statusLine(connected: Bool, detail: String?) -> some View {
        HStack(spacing: 5) {
            if connected {
                Circle()
                    .fill(Color.brand)
                    .frame(width: 6, height: 6)
            }
            Text(detail ?? "No conectado")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    @ViewBuilder
    private func progressLine(for provider: String) -> some View {
        if busyProvider == provider, let progressText {
            HStack(spacing: 6) {
                ProgressView()
                    .controlSize(.mini)
                Text(progressText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.leading, Self.detailIndent)
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

    private var footerText: String {
        var names = ["Strava", "Polar"]
        if showSuunto { names.append("Suunto") }
        if showGarmin { names.append("Garmin") }
        if showCoros { names.append("COROS") }
        let services = names.joined(separator: ", ")
        return "Las carreras que registres en \(services) o en el Apple Watch (Apple Salud) se convierten en territorio."
    }

    private var showSuunto: Bool {
        guard let suunto else { return false }
        return suunto.configured || suunto.connected
    }

    private var suuntoDetail: String? {
        guard let suunto, suunto.connected else { return nil }
        if let last = APIDate.parse(suunto.lastSyncAt) {
            return "Sincronizado \(Format.relative(last))"
        }
        if let username = suunto.username, !username.isEmpty {
            return username
        }
        return "Conectado"
    }

    private var showGarmin: Bool {
        guard let garmin else { return false }
        return garmin.configured || garmin.connected
    }

    private var garminDetail: String? {
        guard let garmin, garmin.connected else { return nil }
        if !garmin.activityExport {
            return "Sin permiso de actividades"
        }
        if let last = APIDate.parse(garmin.lastWebhookAt) {
            return "Última carrera recibida \(Format.relative(last))"
        }
        return "Conectado"
    }

    private var showCoros: Bool {
        guard let coros else { return false }
        return coros.configured || coros.connected
    }

    private var corosDetail: String? {
        guard let coros, coros.connected else { return nil }
        // The newest of the last push and the last sync
        let last = [APIDate.parse(coros.lastWebhookAt), APIDate.parse(coros.lastSyncAt)].compactMap { $0 }.max()
        if let last {
            return "Sincronizado \(Format.relative(last))"
        }
        return "Conectado"
    }

    private func activitiesLinkLabel(failed: Int) -> some View {
        HStack(spacing: 12) {
            Color.clear
                .frame(width: Self.markSize, height: 1)
            Text("Actividades importadas")
                .font(.subheadline)
                .foregroundStyle(Color.primary)
            Spacer(minLength: 8)
            if failed > 0 {
                Text("\(failed) sin territorio")
                    .font(.footnote.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(Color.steal)
            }
        }
    }

    private func providerRow(name: String, mark: IntegrationBrandMark.Brand, connected: Bool, detail: String?, provider: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                IntegrationBrandMark(brand: mark, size: Self.markSize)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(.body.weight(.semibold))
                    statusLine(connected: connected, detail: detail)
                }
                Spacer(minLength: 8)
                providerActions(name: name, connected: connected, provider: provider, tint: .brand)
            }
            progressLine(for: provider)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func providerActions(name: String, connected: Bool, provider: String, tint: Color) -> some View {
        if busyProvider == provider {
            ProgressView()
        } else if connected {
            Menu {
                Button("Sincronizar ahora", systemImage: "arrow.triangle.2.circlepath") {
                    Task { await sync(provider) }
                }
                Button("Desconectar", systemImage: "link.badge.minus", role: .destructive) {
                    providerToDisconnect = provider
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Opciones de \(name)")
        } else {
            Button("Conectar") {
                if provider == "strava" {
                    showStravaConsent = true
                } else {
                    Task { await connect(provider) }
                }
            }
            .buttonStyle(SecondaryButtonStyle(tint: tint))
            .disabled(busyProvider != nil)
            .accessibilityLabel("Conectar \(name)")
        }
    }

    private var healthRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                IntegrationBrandMark(brand: .appleHealth, size: Self.markSize)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Apple Salud")
                        .font(.body.weight(.semibold))
                    Text("Carreras del Apple Watch y otras apps")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if health.isImporting {
                    ProgressView()
                } else {
                    Button("Importar") {
                        Task { await importFromHealth() }
                    }
                    .buttonStyle(SecondaryButtonStyle(tint: .brand))
                }
            }
            Toggle("Importar automáticamente", isOn: $healthAutoImport)
                .font(.subheadline)
                .tint(Color.brand)
                .padding(.leading, Self.detailIndent)
                .onChange(of: healthAutoImport) { _, enabled in
                    health.autoImport = enabled
                    if enabled { Task { await importFromHealth() } }
                }
        }
        .onAppear {
            // The setting is reset on logout
            healthAutoImport = health.autoImport
        }
        .padding(.vertical, 2)
    }

    // MARK: - Actions

    private func loadStatus() async {
        guard let userId = session.userId else { return }
        async let stravaStatus = try? APIClient.shared.request("GET", "/api/strava/status/\(userId)", as: StravaConnection.self)
        async let polarStatus = try? APIClient.shared.request("GET", "/api/polar/status/\(userId)", as: PolarConnection.self)
        async let suuntoStatus = try? APIClient.shared.request("GET", "/api/suunto/status/\(userId)", as: SuuntoConnection.self)
        async let garminStatus = try? APIClient.shared.request("GET", "/api/garmin/status/\(userId)", as: GarminConnection.self)
        async let corosStatus = try? APIClient.shared.request("GET", "/api/coros/status/\(userId)", as: CorosConnection.self)
        strava = await stravaStatus
        polar = await polarStatus
        suunto = await suuntoStatus
        garmin = await garminStatus
        coros = await corosStatus
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
                // Some errors still leave the account linked (e.g. no activity permission)
                await loadStatus()
            } else {
                Haptics.success()
                await loadStatus()
                busyProvider = nil
                await sync(provider, connectedNow: true)
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
            message = "\(Self.displayName(provider)) desconectado."
        } catch {
            message = error.localizedDescription
        }
    }

    /// Pulls new activities from the provider, then turns them into territory.
    private func sync(_ provider: String, connectedNow: Bool = false) async {
        guard let userId = session.userId, busyProvider == nil else { return }
        busyProvider = provider
        progressText = "Buscando actividades nuevas…"
        defer {
            busyProvider = nil
            progressText = nil
        }
        do {
            let outcome = try await ProviderSync.run(provider: provider, userId: userId, pull: true) { remaining in
                progressText = remaining > 0 ? "Procesando actividades… (\(remaining) pendientes)" : "Procesando actividades…"
            }
            await loadStatus()
            router.reloadSignal += 1
            let name = Self.displayName(provider)
            if outcome.processed > 0 {
                let count = outcome.processed == 1 ? "1 actividad nueva" : "\(outcome.processed) actividades nuevas"
                message = "\(connectedNow ? "\(name) conectado. " : "")Se han importado \(count). Ve al mapa para ver lo que has conquistado."
            } else if connectedNow {
                message = "\(name) conectado. Tus próximas carreras se importarán automáticamente."
            } else {
                message = outcome.message ?? "No hay actividades nuevas."
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

    static func displayName(_ provider: String) -> String {
        switch provider {
        case "strava": return "Strava"
        case "polar": return "Polar"
        case "suunto": return "Suunto"
        case "garmin": return "Garmin"
        case "coros": return "COROS"
        default: return provider.capitalized
        }
    }

    private static func describe(error: String, provider: String) -> String {
        let name = displayName(provider)
        switch error {
        case "denied": return "Has cancelado la conexión con \(name)."
        case "already_linked": return "Esa cuenta de \(name) ya está conectada a otro usuario de Runna.io."
        case "invalid_state": return "La conexión ha caducado. Inténtalo de nuevo."
        case "registration": return "Error al registrar tu usuario en Polar AccessLink. Inténtalo de nuevo."
        case "token_exchange": return "\(name) no ha aceptado la autorización. Inténtalo de nuevo."
        case "invalid_user": return "No se ha podido leer tu cuenta de \(name). Inténtalo de nuevo."
        case "no_activity_permission": return "\(name) conectado, pero sin permiso para compartir actividades. Desconecta y vuelve a conectar activando «Actividades»."
        default: return "No se ha podido conectar con \(name) (\(error))."
        }
    }
}

// MARK: - Sync

/// Strava/Polar/Suunto/Garmin/COROS import: /sync pulls new activities from the provider (in chunks, `hasMore`),
/// /process turns them into territory one at a time (`remaining`).
@MainActor
enum ProviderSync {
    struct Outcome {
        var processed = 0
        var routeIds: [String] = []
        var message: String?
    }

    private static let maxSyncCalls = 5
    private static let maxProcessCalls = 60

    /// - Parameters:
    ///   - pull: call /sync first (false after a retry: the activity is already on the server).
    ///   - onProgress: called with the number of activities still waiting.
    static func run(provider: String, userId: String, pull: Bool, onProgress: (Int) -> Void = { _ in }) async throws -> Outcome {
        var outcome = Outcome()

        if pull {
            var calls = 0
            repeat {
                let synced = try await APIClient.shared.request(
                    "POST", "/api/\(provider)/sync/\(userId)", body: [:], as: ProviderSyncResponse.self
                )
                calls += 1
                outcome.message = synced.message ?? outcome.message
                if synced.hasMore != true { break }
            } while calls < maxSyncCalls
        }

        var previousRemaining = Int.max
        var stalledCalls = 0
        for _ in 0..<maxProcessCalls {
            let result = try await APIClient.shared.request(
                "POST", "/api/\(provider)/process/\(userId)", body: [:], as: ProviderSyncResponse.self
            )
            outcome.processed += result.processed ?? 0
            for routeId in result.routeIds where !outcome.routeIds.contains(routeId) {
                outcome.routeIds.append(routeId)
            }
            // A skipped activity (no GPS, bad date…) answers processed = 0 while others are still waiting:
            // keep going until nothing remains. Without a count (older server), stop when nothing was processed.
            guard let remaining = result.remaining else {
                if (result.processed ?? 0) == 0 { break }
                continue
            }
            if remaining <= 0 { break }
            onProgress(remaining)
            // Safety net: stop if the server makes no progress
            if remaining >= previousRemaining {
                stalledCalls += 1
                if stalledCalls >= 3 { break }
            } else {
                stalledCalls = 0
            }
            previousRemaining = remaining
        }

        // Show what was conquered (presented on the map, one after another)
        for routeId in outcome.routeIds {
            ConquestInbox.shared.enqueue(routeId: routeId)
        }
        return outcome
    }
}

// MARK: - API shapes

/// Response of POST /api/{strava|polar|suunto|garmin|coros}/sync and /process.
struct ProviderSyncResponse: Decodable {
    let imported: Int?
    let processed: Int?
    let remaining: Int?
    let hasMore: Bool?
    let message: String?
    let routeIds: [String]

    private struct Result: Decodable {
        let routeId: String?

        enum CodingKeys: String, CodingKey { case routeId }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            routeId = c.string(.routeId)
        }
    }

    enum CodingKeys: String, CodingKey { case imported, processed, remaining, hasMore, message, results }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        imported = c.int(.imported)
        processed = c.int(.processed)
        remaining = c.int(.remaining)
        hasMore = c.bool(.hasMore)
        message = c.string(.message)
        let results = (try? c.decodeIfPresent([Result].self, forKey: .results)) ?? []
        routeIds = results.compactMap { $0.routeId }.filter { !$0.isEmpty }
    }
}

/// GET /api/strava/status/:userId
struct StravaConnection: Decodable {
    struct Athlete: Decodable {
        let id: String?
        let firstname: String?
        let lastname: String?
        let profileMedium: String?
        let city: String?
        let country: String?

        var place: String? {
            let parts = [city, country].compactMap { $0?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            return parts.isEmpty ? nil : parts.joined(separator: ", ")
        }

        enum CodingKeys: String, CodingKey {
            case id, firstname, lastname, city, country
            case profileMedium = "profile_medium"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = c.string(.id)
            firstname = c.string(.firstname)
            lastname = c.string(.lastname)
            let avatar = c.string(.profileMedium)
            // Strava sends a placeholder path ("avatar/athlete/medium.png") when there's no photo
            profileMedium = (avatar?.hasPrefix("http") ?? false) ? avatar : nil
            city = c.string(.city)
            country = c.string(.country)
        }
    }

    let connected: Bool
    let athlete: Athlete?
    let lastSyncAt: String?
    let failedActivities: Int

    enum CodingKeys: String, CodingKey { case connected, athleteData, lastSyncAt, failedActivities }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connected = c.bool(.connected) ?? false
        athlete = c.embedded(Athlete.self, .athleteData)
        lastSyncAt = c.string(.lastSyncAt)
        failedActivities = c.int(.failedActivities) ?? 0
    }
}

/// GET /api/polar/status/:userId
struct PolarConnection: Decodable {
    let connected: Bool
    let lastSyncAt: String?
    let totalActivities: Int?
    let pendingActivities: Int?
    let failedActivities: Int

    enum CodingKeys: String, CodingKey { case connected, lastSyncAt, totalActivities, pendingActivities, failedActivities }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connected = c.bool(.connected) ?? false
        lastSyncAt = c.string(.lastSyncAt)
        totalActivities = c.int(.totalActivities)
        pendingActivities = c.int(.pendingActivities)
        failedActivities = c.int(.failedActivities) ?? 0
    }
}

/// GET /api/garmin/status/:userId
struct GarminConnection: Decodable {
    /// The server has the Garmin API keys; when false the row is hidden.
    let configured: Bool
    let connected: Bool
    /// False when the user didn't share activities on Garmin's consent screen.
    let activityExport: Bool
    let lastSyncAt: String?
    let lastWebhookAt: String?
    let failedActivities: Int

    enum CodingKeys: String, CodingKey {
        case configured, connected, activityExport, lastSyncAt, lastWebhookAt, failedActivities
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        configured = c.bool(.configured) ?? false
        connected = c.bool(.connected) ?? false
        activityExport = c.bool(.activityExport) ?? true
        lastSyncAt = c.string(.lastSyncAt)
        lastWebhookAt = c.string(.lastWebhookAt)
        failedActivities = c.int(.failedActivities) ?? 0
    }
}

/// GET /api/coros/status/:userId
struct CorosConnection: Decodable {
    /// The server has the COROS API keys; when false the row is hidden.
    let configured: Bool
    let connected: Bool
    let lastSyncAt: String?
    let lastWebhookAt: String?
    let failedActivities: Int

    enum CodingKeys: String, CodingKey {
        case configured, connected, lastSyncAt, lastWebhookAt, failedActivities
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        configured = c.bool(.configured) ?? false
        connected = c.bool(.connected) ?? false
        lastSyncAt = c.string(.lastSyncAt)
        lastWebhookAt = c.string(.lastWebhookAt)
        failedActivities = c.int(.failedActivities) ?? 0
    }
}

/// GET /api/suunto/status/:userId
struct SuuntoConnection: Decodable {
    /// The server has the Suunto API keys; when false the row is hidden.
    let configured: Bool
    let connected: Bool
    let username: String?
    let lastSyncAt: String?
    let totalActivities: Int?
    let pendingActivities: Int?
    let failedActivities: Int

    enum CodingKeys: String, CodingKey {
        case configured, connected, suuntoUsername, lastSyncAt, totalActivities, pendingActivities, failedActivities
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        configured = c.bool(.configured) ?? false
        connected = c.bool(.connected) ?? false
        username = c.string(.suuntoUsername)
        lastSyncAt = c.string(.lastSyncAt)
        totalActivities = c.int(.totalActivities)
        pendingActivities = c.int(.pendingActivities)
        failedActivities = c.int(.failedActivities) ?? 0
    }
}

/// A row of GET /api/{strava|polar|suunto|garmin|coros}/activities/:userId.
struct ProviderActivity: Decodable, Identifiable, Hashable {
    let id: String
    /// Strava activity id / Polar exercise id / Suunto workout key / Garmin summary id / COROS labelId.
    let externalId: String?
    let name: String
    let activityType: String?
    let distance: Double
    let duration: Int
    let startDate: Date?
    let processed: Bool
    let skipReason: String?
    let routeId: String?

    enum Status { case imported, pending, skipped }

    var status: Status {
        if routeId != nil { return .imported }
        return processed ? .skipped : .pending
    }

    var skipReasonText: String? {
        let reason = skipReason ?? ""
        switch reason {
        case "before_competition": return "Anterior a la competición"
        case "excluded_type": return "Tipo de actividad excluido"
        case "distance_too_short": return "Distancia demasiado corta"
        case "duration_too_short": return "Duración demasiado corta"
        case "no_gps": return "Sin GPS"
        case "bad_date": return "Fecha no válida"
        case "fit_unavailable", "fit_error": return "No se ha podido descargar el entrenamiento"
        case "deleted_by_user": return "Eliminada por ti"
        case "": return status == .skipped ? "Sin ruta GPS o no válida" : nil
        default: return reason
        }
    }

    enum CodingKeys: String, CodingKey {
        case id, stravaActivityId, polarExerciseId, workoutKey, summaryId, corosWorkoutId, name, activityType, distance, duration, startDate, processed, skipReason, routeId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id) ?? UUID().uuidString
        externalId = c.string(.stravaActivityId) ?? c.string(.polarExerciseId) ?? c.string(.workoutKey) ?? c.string(.summaryId)
            ?? c.string(.corosWorkoutId)
        let rawName = c.string(.name)?.trimmingCharacters(in: .whitespaces) ?? ""
        name = rawName.isEmpty ? "Actividad" : rawName
        activityType = c.string(.activityType)
        distance = c.double(.distance) ?? 0
        duration = c.int(.duration) ?? 0
        startDate = Self.date(c.string(.startDate))
        processed = c.bool(.processed) ?? false
        skipReason = c.string(.skipReason)
        let route = c.string(.routeId)
        routeId = (route?.isEmpty ?? true) ? nil : route
    }

    /// ISO / SQLite text, or epoch seconds or milliseconds.
    private static func date(_ text: String?) -> Date? {
        guard let text else { return nil }
        if let number = Double(text) {
            return Date(timeIntervalSince1970: number > 100_000_000_000 ? number / 1000 : number)
        }
        return APIDate.parse(text)
    }
}

// MARK: - Imported activities

/// Activities imported from Strava, Polar, Suunto, Garmin or COROS, with their status, the reason when they gave no territory,
/// and retry / delete.
struct ImportedActivitiesView: View {
    let provider: String

    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router

    @State private var activities: [ProviderActivity] = []
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var errorMessage: String?
    @State private var info: String?
    @State private var busyIds: Set<String> = []
    @State private var activityToDelete: ProviderActivity?

    private var providerName: String { IntegrationsSection.displayName(provider) }

    var body: some View {
        List {
            if !activities.isEmpty {
                summarySection
                Section {
                    ForEach(activities) { activity in
                        row(activity)
                            .listRowBackground(Color.surface)
                    }
                } footer: {
                    if provider == "strava" {
                        Text("Datos de actividad de Strava.")
                    }
                }
            }
        }
        .overlay {
            if isLoading && activities.isEmpty {
                ProgressView()
            } else if let loadError, activities.isEmpty {
                ErrorView(message: loadError) { Task { await load() } }
            } else if activities.isEmpty {
                EmptyStateView(
                    systemImage: "tray",
                    title: "Sin actividades importadas",
                    message: "Todavía no hay actividades importadas de \(providerName). Usa \"Sincronizar ahora\" en tu perfil."
                )
            }
        }
        .listStyle(.insetGrouped)
        .listBackground()
        .navigationTitle("Actividades de \(providerName)")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .errorAlert($errorMessage)
        .alert(providerName, isPresented: Binding(get: { info != nil }, set: { if !$0 { info = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(info ?? "")
        }
        .confirmationDialog(
            "¿Eliminar actividad de \(providerName)?",
            isPresented: Binding(get: { activityToDelete != nil }, set: { if !$0 { activityToDelete = nil } }),
            titleVisibility: .visible,
            presenting: activityToDelete
        ) { activity in
            Button("Eliminar", role: .destructive) { delete(activity) }
            Button("Cancelar", role: .cancel) {}
        } message: { _ in
            Text("Se borrará la carrera y su territorio se recalculará. No se puede deshacer.")
        }
    }

    private var summarySection: some View {
        let imported = activities.filter { $0.status == .imported }.count
        let pending = activities.filter { $0.status == .pending }.count
        let skipped = activities.filter { $0.status == .skipped }.count
        return Section {
            HStack(spacing: 0) {
                StatTile(value: "\(imported)", label: "Importadas")
                StatDivider()
                StatTile(value: "\(pending)", label: "Pendientes")
                StatDivider()
                StatTile(value: "\(skipped)", label: "Omitidas", tint: skipped > 0 ? Color.steal : Color.primary)
            }
            .padding(.vertical, 8)
            .listRowBackground(Color.surface)
        }
    }

    private func row(_ activity: ProviderActivity) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(activity.name)
                    .font(.body.weight(.semibold))
                    .lineLimit(2)
                Spacer()
                if busyIds.contains(activity.id) {
                    ProgressView()
                } else {
                    statusBadge(activity.status)
                }
            }
            Text(details(activity))
                .font(.caption)
                .foregroundStyle(.secondary)
            if activity.status == .skipped, let reason = activity.skipReasonText {
                Label("Motivo: \(reason)", systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(Color.steal)
            }
            if provider == "strava", let externalId = activity.externalId,
               let url = URL(string: "https://www.strava.com/activities/\(externalId)") {
                Link(destination: url) {
                    Text("Ver en Strava")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color(hex: "#FC4C02"))
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.vertical, 2)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if canDelete(activity) {
                Button("Eliminar", systemImage: "trash", role: .destructive) {
                    activityToDelete = activity
                }
            }
            if activity.status == .skipped {
                Button("Reintentar", systemImage: "arrow.clockwise") {
                    retry(activity)
                }
                .tint(Color.sky)
            }
        }
        .contextMenu {
            if activity.status == .skipped {
                Button("Reintentar", systemImage: "arrow.clockwise") { retry(activity) }
            }
            if canDelete(activity) {
                Button("Eliminar", systemImage: "trash", role: .destructive) { activityToDelete = activity }
            }
        }
    }

    /// Polar, Suunto, Garmin and COROS imports can be deleted here (Strava activities are managed in Strava).
    private func canDelete(_ activity: ProviderActivity) -> Bool {
        switch provider {
        case "polar": return true
        case "suunto", "garmin", "coros": return activity.status == .imported
        default: return false
        }
    }

    private func details(_ activity: ProviderActivity) -> String {
        var parts: [String] = []
        if let date = activity.startDate { parts.append(Format.day(date)) }
        if activity.distance > 0 { parts.append(Format.distance(activity.distance)) }
        if activity.duration > 0 { parts.append(Format.duration(activity.duration)) }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func statusBadge(_ status: ProviderActivity.Status) -> some View {
        switch status {
        case .imported: badge("Importada", color: Color.secondary)
        case .pending: badge("Pendiente", color: Color.secondary)
        case .skipped: badge("Omitida", color: Color.steal)
        }
    }

    /// Plain status text (no tinted capsule).
    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.footnote.weight(.medium))
            .foregroundStyle(color)
    }

    // MARK: - Actions

    private func load() async {
        guard let userId = session.userId else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            activities = try await APIClient.shared.request(
                "GET", "/api/\(provider)/activities/\(userId)", as: [ProviderActivity].self
            )
            loadError = nil
        } catch is CancellationError {
            return
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func retry(_ activity: ProviderActivity) {
        guard let userId = session.userId, !busyIds.contains(activity.id) else { return }
        busyIds.insert(activity.id)
        Task {
            defer { busyIds.remove(activity.id) }
            do {
                try await APIClient.shared.send("POST", "/api/\(provider)/retry/\(activity.id)", body: [:])
                let outcome = try await ProviderSync.run(provider: provider, userId: userId, pull: false)
                await load()
                router.reloadSignal += 1
                if outcome.processed > 0 {
                    Haptics.success()
                    info = "Actividad procesada. Ve al mapa para ver lo que has conquistado."
                } else if let updated = activities.first(where: { $0.id == activity.id }), updated.status == .skipped {
                    info = "La actividad se ha vuelto a omitir: \(updated.skipReasonText ?? "no es válida para conquistar territorio")."
                } else {
                    info = "Actividad desbloqueada. Se procesará en breve."
                }
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func delete(_ activity: ProviderActivity) {
        guard let userId = session.userId, !busyIds.contains(activity.id) else { return }
        busyIds.insert(activity.id)
        Task {
            defer { busyIds.remove(activity.id) }
            do {
                try await APIClient.shared.send("DELETE", "/api/\(provider)/activities/\(userId)/\(activity.id)")
                if provider == "suunto" || provider == "garmin" || provider == "coros" {
                    // The workout stays in the list as skipped ("Reintentar" brings it back)
                    await load()
                } else {
                    activities.removeAll { $0.id == activity.id }
                }
                router.reloadSignal += 1
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

// MARK: - Brand marks

/// Third-party service marks for the connected-services rows: the brand's own colour tile with a
/// white glyph (Strava peaks, Polar, Suunto, Garmin, COROS), or Apple Health's white tile with the pink heart.
struct IntegrationBrandMark: View {
    enum Brand {
        case strava, polar, suunto, garmin, coros, appleHealth
    }

    let brand: Brand
    var size: CGFloat = 32

    static let stravaOrange = Color(hex: "#FC4C02")
    static let polarRed = Color(hex: "#D10027")
    static let suuntoBlack = Color(hex: "#16181A")
    static let garminBlue = Color(hex: "#007CC3")
    static let corosRed = Color(hex: "#E2231A")
    static let healthPink = Color(hex: "#FF2D55")

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
    }

    var body: some View {
        ZStack {
            switch brand {
            case .strava:
                shape.fill(Self.stravaOrange)
                StravaPeaksShape()
                    .fill(Color.white)
                    .frame(width: size * 0.62, height: size * 0.62)
            case .polar:
                shape.fill(Self.polarRed)
                Text("P")
                    .font(.system(size: size * 0.56, weight: .heavy))
                    .italic()
                    .foregroundStyle(Color.white)
            case .suunto:
                shape.fill(Self.suuntoBlack)
                // Hairline so the dark tile keeps its edge on dark backgrounds
                shape.strokeBorder(Color.white.opacity(0.18), lineWidth: DS.Stroke.hairline)
                Text("S")
                    .font(.system(size: size * 0.54, weight: .bold))
                    .tracking(size * 0.02)
                    .foregroundStyle(Color.white)
            case .garmin:
                shape.fill(Self.garminBlue)
                Text("G")
                    .font(.system(size: size * 0.54, weight: .bold))
                    .foregroundStyle(Color.white)
            case .coros:
                shape.fill(Self.corosRed)
                Text("C")
                    .font(.system(size: size * 0.54, weight: .heavy))
                    .foregroundStyle(Color.white)
            case .appleHealth:
                shape.fill(Color.white)
                shape.strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline)
                Image(systemName: "heart.fill")
                    .font(.system(size: size * 0.5, weight: .regular))
                    .foregroundStyle(Self.healthPink)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Simplified Strava mark: a large peak with a smaller inverted peak at its lower right.
private struct StravaPeaksShape: Shape {
    func path(in rect: CGRect) -> Path {
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * rect.width, y: rect.minY + y * rect.height)
        }
        var path = Path()
        // Large peak
        path.move(to: point(0.42, 0.04))
        path.addLine(to: point(0.72, 0.64))
        path.addLine(to: point(0.56, 0.64))
        path.addLine(to: point(0.42, 0.36))
        path.addLine(to: point(0.28, 0.64))
        path.addLine(to: point(0.12, 0.64))
        path.closeSubpath()
        // Small inverted peak, continuing the large peak's right edge
        path.move(to: point(0.60, 0.70))
        path.addLine(to: point(0.72, 0.70))
        path.addLine(to: point(0.74, 0.74))
        path.addLine(to: point(0.76, 0.70))
        path.addLine(to: point(0.88, 0.70))
        path.addLine(to: point(0.74, 0.98))
        path.closeSubpath()
        return path
    }
}
