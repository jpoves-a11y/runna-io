import SwiftUI
import UIKit
import PhotosUI
import UserNotifications

struct ProfileView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    @Environment(\.dismiss) private var dismiss
    /// Shown as a sheet from my avatar (there's no Profile tab any more)
    var isSheet = false

    @State private var model = ProfileModel.shared
    @State private var showEdit = false
    @State private var avatarItem: PhotosPickerItem?
    /// Photo picked from the library, waiting to be framed in the circle.
    @State private var photoToCrop: PhotoToCrop?
    @State private var isUploadingAvatar = false
    @State private var notificationStatus: UNAuthorizationStatus = .notDetermined
    @State private var confirmLogout = false
    @State private var confirmDelete = false
    @State private var confirmRemoveAvatar = false
    @State private var isDeleting = false
    @State private var isSendingTest = false
    /// What the server knows about notifications for this account (GET /api/push/status).
    @State private var pushStatus: PushServerStatus?
    @State private var isRetryingRegistration = false
    @State private var info: String?
    @State private var errorMessage: String?
    @State private var avatarUploads = 0
    @AppStorage(AppAppearance.storageKey) private var appearance: AppAppearance = .system
    @AppStorage(VoiceCoach.enabledKey) private var voiceCues = true
    @State private var voiceSample = VoiceCoach()
    @State private var privacyZone = false
    @State private var isSavingPrivacyZone = false

    private var conquest: ConquestStats? { model.conquest }

    /// Under "¿Cerrar sesión?" only when there are runs still to upload.
    private var logoutMessage: String? {
        let pending = PendingRuns.pendingCount
        if pending == 0 { return nil }
        return pending == 1
            ? "Tienes 1 carrera sin subir. Intentaremos subirla antes de salir; si no hay conexión, se quedará en este iPhone y se subirá cuando vuelvas a entrar con tu cuenta."
            : "Tienes \(pending) carreras sin subir. Intentaremos subirlas antes de salir; si no hay conexión, se quedarán en este iPhone y se subirán cuando vuelvas a entrar con tu cuenta."
    }

    var body: some View {
        NavigationStack {
            list
                .navigationTitle("Perfil y ajustes")
                .navigationBarTitleDisplayMode(isSheet ? .inline : .large)
                .toolbar {
                    if isSheet {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Cerrar") { dismiss() }
                        }
                    }
                }
                .refreshable { await QuickRefresh.run { await reload(force: true) } }
                .task(id: router.reloadSignal) {
                    await reload(force: model.reloadTracker.consume(router.reloadSignal))
                }
                #if DEBUG
                .task {
                    guard router.logoutConfirmDemo else { return }
                    router.logoutConfirmDemo = false
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    confirmLogout = true
                }
                #endif
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { notificationStatus = await PushManager.shared.authorizationStatus() } }
                }
                .onChange(of: avatarItem) { _, item in
                    if let item { loadPhotoToCrop(item) }
                }
                .fullScreenCover(item: $photoToCrop) { photo in
                    AvatarCropView(
                        image: photo.image,
                        onCancel: { photoToCrop = nil },
                        onChoose: { cropped in
                            photoToCrop = nil
                            uploadAvatar(cropped)
                        }
                    )
                }
                .sheet(isPresented: $showEdit) {
                    EditProfileView()
                }
                .km2Confirm("¿Cerrar sesión?", isPresented: $confirmLogout, message: logoutMessage) {
                    Task { await session.logout() }
                }
                .km2Confirm("¿Quitar tu foto de perfil?", isPresented: $confirmRemoveAvatar,
                            message: "Volverás a aparecer con tu inicial sobre tu color de territorio.") {
                    removeAvatar()
                }
                .km2Confirm("¿Borrar tu cuenta?", isPresented: $confirmDelete,
                            message: "Se borrarán tu perfil, tus carreras, tu territorio y tus amigos. No se puede deshacer.") {
                    deleteAccount()
                }
                .errorAlert($errorMessage)
                .alert("Notificaciones", isPresented: Binding(get: { info != nil }, set: { if !$0 { info = nil } })) {
                    Button("OK", role: .cancel) {}
                } message: {
                    Text(info ?? "")
                }
                .sensoryFeedback(.success, trigger: avatarUploads)
                .overlay {
                    if isDeleting {
                        ProgressView("Borrando cuenta…")
                            .padding(DS.Spacing.xl)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
                    }
                }
        }
    }

    private var list: some View {
        List {
            if let user = session.user {
                heroSection(user)
                GameProfileSection()
                statsSection(user)
                ProfileAwardsSection(awards: model.awards)
                rivalriesSection
            }
            IntegrationsSection()
            runSection
            notificationsSection
            appearanceSection
            privacySection
            aboutSection
            accountSection
        }
        .listStyle(.insetGrouped)
        .listBackground()
        .listSectionSpacing(DS.Spacing.l)
    }

    // MARK: - Hero

    private func heroSection(_ user: AppUser) -> some View {
        Section {
            ProfileHeroCard(
                user: user,
                avatarItem: $avatarItem,
                isUploadingAvatar: isUploadingAvatar,
                onEdit: { showEdit = true },
                onRemoveAvatar: { confirmRemoveAvatar = true }
            )
            .listRowInsets(EdgeInsets(top: DS.Spacing.xs, leading: DS.Spacing.xs, bottom: DS.Spacing.xs, trailing: DS.Spacing.xs))
            .listRowBackground(Color.clear)
        }
    }

    // MARK: - Stats

    private func statsSection(_ user: AppUser) -> some View {
        Section {
            ProfileStatsCard(user: user, conquest: conquest)
                .listRowInsets(EdgeInsets(top: DS.Spacing.m, leading: DS.Spacing.s, bottom: DS.Spacing.m, trailing: DS.Spacing.s))
                .listRowBackground(Color.surface)
        } header: {
            SocialSectionHeader(title: "Estadísticas")
        }
    }

    @ViewBuilder
    private var rivalriesSection: some View {
        if let conquest {
            Section {
                ProfileRivalriesContent(conquest: conquest)
                    .listRowBackground(Color.surface)
            } header: {
                SocialSectionHeader(title: "Rivalidades")
            }
        }
    }

    // MARK: - Settings

    private var notificationsSection: some View {
        Section {
            switch notificationStatus {
            case .authorized, .provisional, .ephemeral:
                notificationStatusRow
                Button {
                    sendTestNotification()
                } label: {
                    HStack {
                        SocialSettingsLabel(title: "Enviar notificación de prueba", systemImage: "paperplane")
                        if isSendingTest {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(isSendingTest)
            case .denied:
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                } label: {
                    SocialSettingsLabel(title: "Activar notificaciones en Ajustes", systemImage: "bell.slash")
                }
            default:
                Button {
                    Task {
                        await PushManager.shared.requestPermissionAndRegister()
                        notificationStatus = await PushManager.shared.authorizationStatus()
                    }
                } label: {
                    SocialSettingsLabel(title: "Activar notificaciones", systemImage: "bell")
                }
            }
        } header: {
            SocialSectionHeader(title: "Notificaciones")
        } footer: {
            Text("Te avisamos de tu competición y tu club, de los cofres cercanos y cuando un amigo corre o te comenta.")
        }
        .listRowBackground(Color.surface)
    }

    /// "Activadas", or what is wrong: the server has no APNs keys, or this iPhone isn't registered.
    @ViewBuilder
    private var notificationStatusRow: some View {
        let serverOff = pushStatus.map { !$0.apnsConfigured } ?? false
        let notRegistered = pushStatus.map { $0.apnsConfigured && !PushManager.shared.isRegistered(in: $0) } ?? false
        HStack {
            SocialSettingsLabel(title: "Notificaciones", systemImage: serverOff || notRegistered ? "bell.badge" : "bell")
            Spacer()
            if serverOff {
                Text("Notificaciones del servidor no configuradas")
                    .font(.footnote)
                    .foregroundStyle(Color.steal)
                    .multilineTextAlignment(.trailing)
            } else if notRegistered {
                Text("Este iPhone no está registrado")
                    .font(.footnote)
                    .foregroundStyle(Color.steal)
                    .multilineTextAlignment(.trailing)
            } else {
                Text("Activadas")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        if notRegistered && !serverOff {
            Button {
                retryRegistration()
            } label: {
                HStack {
                    SocialSettingsLabel(title: "Reintentar registro", systemImage: "arrow.clockwise")
                    if isRetryingRegistration {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(isRetryingRegistration)
        }
        if let problem = notificationProblem {
            Text(problem)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    /// The last error Apple returned for this account's devices, or why iOS / the server refused the registration.
    private var notificationProblem: String? {
        if let error = PushManager.shared.registrationError { return error }
        guard let status = pushStatus, status.apnsConfigured else { return nil }
        if let topic = status.apnsTopic, let bundleId = Bundle.main.bundleIdentifier, topic != bundleId {
            return "El servidor envía las notificaciones para «\(topic)», pero esta app es «\(bundleId)» (APNS_BUNDLE_ID)."
        }
        if let error = status.lastError {
            return "Último error de Apple: \(error)"
        }
        return nil
    }

    private var appearanceSection: some View {
        Section {
            Picker("Tema", selection: $appearance) {
                ForEach(AppAppearance.allCases) { option in
                    Text(option.title).tag(option)
                }
            }
            .pickerStyle(.segmented)
            .padding(.vertical, 4)
        } header: {
            SocialSectionHeader(title: "Apariencia")
        }
        .listRowBackground(Color.surface)
    }

    private var runSection: some View {
        Section {
            Toggle(isOn: $voiceCues) {
                SocialSettingsLabel(title: "Avisos por voz", systemImage: "speaker.wave.2")
            }
            .tint(Color.brand)
            .onChange(of: voiceCues) { _, enabled in
                Analytics.track("voice_toggled", ["on": enabled])
            }
            if voiceCues {
                NavigationLink {
                    VoicePickerView()
                } label: {
                    SocialSettingsLabel(title: "Voz", systemImage: "waveform", value: VoiceCoach.selectedVoice().map { "\($0.name) · \(VoicePickerView.qualityName($0.quality))" })
                }
                Button {
                    voiceSample.sample()
                } label: {
                    SocialSettingsLabel(title: "Probar voz", systemImage: "play.circle")
                }
            }
        } header: {
            SocialSectionHeader(title: "Durante la carrera")
        } footer: {
            Text("Te avisa de cada kilómetro, de cuándo entras en territorio que puedes robar y de los cofres cercanos, también con la pantalla bloqueada. La música baja mientras habla. En «Voz» puedes elegir otra y descargar una más natural.")
        }
        .listRowBackground(Color.surface)
    }

    private var privacySection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { privacyZone },
                set: { enabled in
                    privacyZone = enabled
                    savePrivacyZone(enabled)
                }
            )) {
                SocialSettingsLabel(title: "Ocultar el inicio y el final de mis carreras", systemImage: "house.circle")
            }
            .tint(Color.brand)
            .disabled(isSavingPrivacyZone || session.user == nil)
            .onAppear { privacyZone = session.user?.hasPrivacyZone ?? false }
            .onChange(of: session.user?.privacyZoneM) { _, _ in
                if !isSavingPrivacyZone { privacyZone = session.user?.hasPrivacyZone ?? false }
            }
            NavigationLink {
                BlockedUsersView()
            } label: {
                SocialSettingsLabel(title: "Usuarios bloqueados", systemImage: "hand.raised")
            }
        } header: {
            SocialSectionHeader(title: "Privacidad y seguridad")
        } footer: {
            Text("Zona privada: los primeros y últimos 200 m de tus carreras nuevas no los ve nadie más ni cuentan como territorio, para que no se sepa dónde vives. Tú sigues viendo la ruta entera.\n\nLas personas que bloquees no podrán ver tu actividad ni comentarte, y tú no verás la suya.")
        }
        .listRowBackground(Color.surface)
    }

    /// Closes the profile and walks through the app again (this time it can be closed).
    private func replayTour() {
        let firstName = session.user?.name.split(separator: " ").first.map(String.init)
        router.showProfile = false
        if isSheet { dismiss() }
        Task {
            // After the sheet has gone
            try? await Task.sleep(nanoseconds: 450_000_000)
            TourController.shared.start(firstName: firstName, replay: true)
        }
    }

    private func savePrivacyZone(_ enabled: Bool) {
        isSavingPrivacyZone = true
        Task {
            defer { isSavingPrivacyZone = false }
            do {
                try await session.setPrivacyZone(enabled)
            } catch {
                privacyZone = !enabled
                errorMessage = error.localizedDescription
            }
        }
    }

    private var aboutSection: some View {
        Section {
            Button {
                replayTour()
            } label: {
                SocialSettingsLabel(title: "Ver tutorial", systemImage: "sparkles")
            }
            NavigationLink {
                ChestOpeningTestView()
            } label: {
                SocialSettingsLabel(title: "Probar apertura de cofres", systemImage: "shippingbox")
            }
            Link(destination: AppConfig.privacyURL) {
                SocialSettingsLabel(title: "Política de privacidad", systemImage: "lock")
            }
            Link(destination: AppConfig.termsURL) {
                SocialSettingsLabel(title: "Términos de uso", systemImage: "doc.text")
            }
            Link(destination: AppConfig.supportURL) {
                SocialSettingsLabel(title: "Ayuda y soporte", systemImage: "questionmark.circle")
            }
            if let mail = AppConfig.supportMailURL {
                Link(destination: mail) {
                    SocialSettingsLabel(title: "Contactar con soporte", systemImage: "envelope", value: AppConfig.supportEmail)
                }
            }
            SocialSettingsLabel(title: "Versión", systemImage: "info.circle", value: Bundle.main.appVersion)
        } header: {
            SocialSectionHeader(title: "Información")
        }
        .listRowBackground(Color.surface)
    }

    private var accountSection: some View {
        Section {
            Button {
                confirmLogout = true
            } label: {
                SocialSettingsLabel(title: "Cerrar sesión", systemImage: "rectangle.portrait.and.arrow.right")
            }
            Button(role: .destructive) {
                confirmDelete = true
            } label: {
                HStack(spacing: 12) {
                    SocialIconTile(systemImage: "trash", tint: .steal, size: 28)
                    Text("Borrar cuenta")
                        .foregroundStyle(Color.steal)
                }
            }
        } header: {
            SocialSectionHeader(title: "Cuenta")
        } footer: {
            VStack(alignment: .leading, spacing: 12) {
                Text("Borrar la cuenta elimina todos tus datos de KM2 de forma permanente.")
                Text("KM2 · Corre. Conquista. Repite.")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)
            }
        }
        .listRowBackground(Color.surface)
    }

    // MARK: - Actions

    /// Cached stats first; the account and the stats are refetched in parallel when they aren't fresh (or `force`).
    private func reload(force: Bool = false) async {
        guard let userId = session.userId else { return }
        let account: SessionStore = session
        let profile: ProfileModel = model
        async let user: Void = account.refreshUser(force: force)
        async let stats: Void = profile.load(userId: userId, force: force)
        notificationStatus = await PushManager.shared.authorizationStatus()
        await refreshPushStatus()
        await user
        await stats
    }

    /// Asks the server whether it can send notifications and whether it knows this iPhone.
    private func refreshPushStatus() async {
        switch notificationStatus {
        case .authorized, .provisional, .ephemeral:
            if let status = try? await PushManager.shared.fetchStatus() {
                pushStatus = status
            }
        default:
            pushStatus = nil
        }
    }

    private func retryRegistration() {
        isRetryingRegistration = true
        Task {
            defer { isRetryingRegistration = false }
            await PushManager.shared.retryRegistration()
            await refreshPushStatus()
            if let status = pushStatus, status.apnsConfigured, !PushManager.shared.isRegistered(in: status) {
                errorMessage = PushManager.shared.registrationError
                    ?? "Este iPhone sigue sin estar registrado. Comprueba la conexión y vuelve a intentarlo en unos segundos."
            }
        }
    }

    private func sendTestNotification() {
        isSendingTest = true
        Task {
            defer { isSendingTest = false }
            // Make sure this iPhone is registered before asking for the test
            await PushManager.shared.registerIfAuthorized()
            do {
                try await PushManager.shared.sendTestNotification()
                info = "Notificación enviada. Debería llegarte en unos segundos."
            } catch {
                // The server explains why nothing could be sent (APNs keys missing, iPhone not
                // registered, Apple's rejection reason…)
                errorMessage = error.localizedDescription
            }
            await refreshPushStatus()
        }
    }

    /// Loads the picked photo (scaled down to 2048 px) and opens "Mover y ajustar".
    private func loadPhotoToCrop(_ item: PhotosPickerItem) {
        isUploadingAvatar = true
        Task {
            defer {
                isUploadingAvatar = false
                avatarItem = nil
            }
            do {
                guard let data = try await item.loadTransferable(type: Data.self),
                      let image = UIImage(data: data) else {
                    errorMessage = "No se ha podido leer la imagen."
                    return
                }
                let prepared = await Task.detached(priority: .userInitiated) {
                    image.resized(maxDimension: 2048)
                }.value
                photoToCrop = PhotoToCrop(image: prepared)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Uploads the square framed in `AvatarCropView` (already 512×512).
    private func uploadAvatar(_ image: UIImage) {
        guard let jpeg = image.jpegData(compressionQuality: 0.8) else {
            errorMessage = "No se ha podido leer la imagen."
            return
        }
        isUploadingAvatar = true
        Task {
            defer { isUploadingAvatar = false }
            do {
                try await session.uploadAvatar(jpegData: jpeg)
                avatarUploads += 1
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func removeAvatar() {
        Task {
            do {
                try await session.removeAvatar()
                Haptics.tap()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func deleteAccount() {
        isDeleting = true
        Task {
            do {
                try await session.deleteAccount()
            } catch {
                errorMessage = error.localizedDescription
            }
            isDeleting = false
        }
    }
}

/// Edit name and territory colour.
struct EditProfileView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var color = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    preview
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                Section {
                    TextField("Tu nombre", text: $name)
                        .textContentType(.name)
                        .font(.body.weight(.medium))
                } header: {
                    SocialSectionHeader(title: "Nombre")
                }
                .listRowBackground(Color.surface)
                Section {
                    colorGrid
                        .padding(.vertical, 8)
                } header: {
                    SocialSectionHeader(title: "Color de tu territorio")
                } footer: {
                    Text("Tu color te identifica en el mapa. Puedes elegir cualquiera: si alguien cerca de ti tiene uno parecido, tu mapa los distingue solo.")
                }
                .listRowBackground(Color.surface)
            }
            .listBackground()
            .navigationTitle("Editar perfil")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Guardar") { save() }
                            .fontWeight(.bold)
                            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .errorAlert($errorMessage)
            .task { await load() }
        }
        .presentationCornerRadius(28)
    }

    private var preview: some View {
        VStack(spacing: 10) {
            AvatarView(
                name: name.isEmpty ? (session.user?.name ?? "?") : name,
                avatar: session.user?.avatar,
                color: color.isEmpty ? (session.user?.color ?? "#16A34A") : color,
                size: 88
            )
            .animation(.snappy, value: color)
            Text(name.isEmpty ? "Tu nombre" : name)
                .font(.title3.weight(.bold))
                .lineLimit(1)
            if !color.isEmpty {
                SocialColorChip(color: color)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, DS.Spacing.l)
    }

    private var colorGrid: some View {
        TerritoryColorPicker(selection: $color)
    }

    private func load() async {
        name = session.user?.name ?? ""
        color = session.user?.color ?? ""
    }

    private func save() {
        guard let user = session.user else { return }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        isSaving = true
        Task {
            do {
                try await session.updateProfile(
                    name: trimmed == user.name ? nil : trimmed,
                    color: color.uppercased() == user.color.uppercased() ? nil : color
                )
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSaving = false
        }
    }
}

extension Bundle {
    var appVersion: String {
        let version = infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }
}

/// A photo from the library on its way to the crop screen.
private struct PhotoToCrop: Identifiable {
    let id = UUID()
    let image: UIImage
}

/// Conquest stats of the Profile tab, kept across tab switches (stale-while-revalidate).
@MainActor
@Observable
final class ProfileModel {
    static let shared = ProfileModel()

    private(set) var conquest: ConquestStats?
    /// Awards won at the close of competitions (showcase).
    private(set) var awards: [AwardInfo] = []
    var reloadTracker = ReloadSignalTracker()

    private var ownerId: String?
    private var resource: CachedResource<ConquestStats>?
    private var statsResource: CachedResource<UserStats>?

    func reset() {
        ownerId = nil
        resource = nil
        statsResource = nil
        conquest = nil
        awards = []
        reloadTracker = ReloadSignalTracker()
    }

    func load(userId: String, force: Bool) async {
        if ownerId != userId {
            reset()
            ownerId = userId
            resource = CachedResource("/api/conquest-stats/\(userId)")
            statsResource = CachedResource("/api/users/\(userId)/stats")
        }
        guard let resource, let statsResource else { return }
        if let cached = await resource.loadCached() {
            conquest = cached
        }
        if let cached = await statsResource.loadCached() {
            awards = cached.awards
        }
        if !force && conquest != nil && resource.isFresh && statsResource.isFresh { return }
        // On failure the last known stats stay on screen
        if let loaded = try? await resource.fetch() {
            conquest = loaded
        }
        if let loaded = try? await statsResource.fetch() {
            awards = loaded.awards
        }
    }
}

/// The territory colours to choose from (Editar perfil, and the "Completa tu perfil" step of the tour).
struct TerritoryColorPicker: View {
    @Binding var selection: String
    var swatchSize: CGFloat = 40
    var spacing: CGFloat = 14

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: spacing), count: 6), spacing: spacing) {
            ForEach(AppConfig.userColors, id: \.self) { option in
                swatch(option)
            }
        }
    }

    private func swatch(_ option: String) -> some View {
        let selected = option.uppercased() == selection.uppercased()
        return Button {
            selection = option
        } label: {
            ZStack {
                Circle().fill(Color(hex: option))
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: swatchSize * 0.36, weight: .bold))
                        .foregroundStyle(Color.white)
                }
            }
            .frame(height: swatchSize)
            .padding(3)
            .overlay {
                Circle().strokeBorder(Color(hex: option), lineWidth: selected ? 2.5 : 0)
            }
            .animation(.snappy, value: selected)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(AppConfig.userColorNames[option] ?? option)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
