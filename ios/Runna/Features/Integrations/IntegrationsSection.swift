import SwiftUI
import AuthenticationServices

/// Strava, Polar and Apple Health connections.
struct IntegrationsSection: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession

    @State private var strava: StravaConnection?
    @State private var polar: PolarConnection?
    @State private var busyProvider: String?
    @State private var progressText: String?
    @State private var message: String?
    @State private var showStravaConsent = false
    @State private var providerToDisconnect: String?
    @State private var health = HealthImporter.shared
    @State private var healthAutoImport = HealthImporter.shared.autoImport

    private static let stravaOrange = Color(hex: "#FC4C02")

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
                systemImage: "heart.circle.fill",
                tint: Color(hex: "#D10027"),
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
            if HealthImporter.isAvailable {
                healthRow
            }
        } header: {
            Text("Conectar dispositivos")
        } footer: {
            VStack(alignment: .leading, spacing: 8) {
                Text("Las carreras que registres en Strava, Polar o en el Apple Watch (Apple Salud) se convierten en territorio.")
                if let url = URL(string: "https://www.strava.com") {
                    Link(destination: url) {
                        HStack(spacing: 4) {
                            Text("Powered by")
                            Text("STRAVA").fontWeight(.heavy).foregroundStyle(Self.stravaOrange)
                        }
                        .font(.caption)
                    }
                    .accessibilityLabel("Powered by Strava")
                }
            }
        }
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

    private var stravaRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                if let avatar = strava?.athlete?.profileMedium, let url = URL(string: avatar), strava?.connected == true {
                    AsyncImage(url: url) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFill()
                        } else {
                            Image(systemName: "bolt.horizontal.circle.fill")
                                .font(.title2)
                                .foregroundStyle(Self.stravaOrange)
                        }
                    }
                    .frame(width: 32, height: 32)
                    .clipShape(Circle())
                    .accessibilityHidden(true)
                } else {
                    Image(systemName: "bolt.horizontal.circle.fill")
                        .font(.title2)
                        .foregroundStyle(Self.stravaOrange)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Strava").font(.body.weight(.medium))
                    Text(stravaDetail ?? "No conectado")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let place = strava?.athlete?.place, strava?.connected == true {
                        Text(place)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                providerActions(name: "Strava", connected: strava?.connected == true, provider: "strava")
            }
            if strava?.connected == true, let athleteId = strava?.athlete?.id,
               let url = URL(string: "https://www.strava.com/athletes/\(athleteId)") {
                Link(destination: url) {
                    Label("Ver mi perfil en Strava", systemImage: "arrow.up.right.square")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Self.stravaOrange)
                }
                .buttonStyle(.borderless)
            }
            if busyProvider == "strava", let progressText {
                Text(progressText).font(.caption).foregroundStyle(.secondary)
            }
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

    private func activitiesLinkLabel(failed: Int) -> some View {
        HStack {
            Label("Actividades importadas", systemImage: "list.bullet.rectangle")
                .font(.subheadline)
            Spacer()
            if failed > 0 {
                Text("\(failed) sin territorio")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
    }

    private func providerRow(name: String, systemImage: String, tint: Color, connected: Bool, detail: String?, provider: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
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
                providerActions(name: name, connected: connected, provider: provider)
            }
            if busyProvider == provider, let progressText {
                Text(progressText).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func providerActions(name: String, connected: Bool, provider: String) -> some View {
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
                Image(systemName: "ellipsis.circle")
                    .font(.title3)
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
            .buttonStyle(.bordered)
            .disabled(busyProvider != nil)
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
        .onAppear {
            // The setting is reset on logout
            healthAutoImport = health.autoImport
        }
    }

    // MARK: - Actions

    private func loadStatus() async {
        guard let userId = session.userId else { return }
        async let stravaStatus = try? APIClient.shared.request("GET", "/api/strava/status/\(userId)", as: StravaConnection.self)
        async let polarStatus = try? APIClient.shared.request("GET", "/api/polar/status/\(userId)", as: PolarConnection.self)
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
        default: return "No se ha podido conectar con \(name) (\(error))."
        }
    }
}

// MARK: - Sync

/// Strava/Polar import: /sync pulls new activities from the provider (in chunks, `hasMore`),
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

/// Response of POST /api/{strava|polar}/sync and /process.
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

/// A row of GET /api/{strava|polar}/activities/:userId.
struct ProviderActivity: Decodable, Identifiable, Hashable {
    let id: String
    /// Strava activity id / Polar exercise id.
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
        case "": return status == .skipped ? "Sin ruta GPS o no válida" : nil
        default: return reason
        }
    }

    enum CodingKeys: String, CodingKey {
        case id, stravaActivityId, polarExerciseId, name, activityType, distance, duration, startDate, processed, skipReason, routeId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id) ?? UUID().uuidString
        externalId = c.string(.stravaActivityId) ?? c.string(.polarExerciseId)
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

/// Activities imported from Strava or Polar, with their status, the reason when they gave no territory,
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
                    title: "Sin actividades",
                    message: "Todavía no hay actividades importadas de \(providerName). Usa \"Sincronizar ahora\" en tu perfil."
                )
            }
        }
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
            HStack {
                StatTile(value: "\(imported)", label: "Importadas", tint: .green)
                StatTile(value: "\(pending)", label: "Pendientes", tint: .blue)
                StatTile(value: "\(skipped)", label: "Omitidas", tint: .orange)
            }
            .padding(.vertical, 4)
        }
    }

    private func row(_ activity: ProviderActivity) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(activity.name)
                    .font(.body.weight(.medium))
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
                Text("Motivo: \(reason)")
                    .font(.caption)
                    .foregroundStyle(.orange)
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
            if provider == "polar" {
                Button("Eliminar", systemImage: "trash", role: .destructive) {
                    activityToDelete = activity
                }
            }
            if activity.status == .skipped {
                Button("Reintentar", systemImage: "arrow.clockwise") {
                    retry(activity)
                }
                .tint(.blue)
            }
        }
        .contextMenu {
            if activity.status == .skipped {
                Button("Reintentar", systemImage: "arrow.clockwise") { retry(activity) }
            }
            if provider == "polar" {
                Button("Eliminar", systemImage: "trash", role: .destructive) { activityToDelete = activity }
            }
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
        case .imported: badge("Importada", color: .green)
        case .pending: badge("Pendiente", color: .blue)
        case .skipped: badge("Omitida", color: .orange)
        }
    }

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
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
                try await APIClient.shared.send("DELETE", "/api/polar/activities/\(userId)/\(activity.id)")
                activities.removeAll { $0.id == activity.id }
                router.reloadSignal += 1
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
