import SwiftUI
import UIKit
import PhotosUI
import UserNotifications

struct ProfileView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    @State private var model = ProfileModel.shared
    @State private var showEdit = false
    @State private var avatarItem: PhotosPickerItem?
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

    private var conquest: ConquestStats? { model.conquest }

    var body: some View {
        NavigationStack {
            list
                .navigationTitle("Perfil")
                .refreshable { await QuickRefresh.run { await reload(force: true) } }
                .task(id: router.reloadSignal) {
                    await reload(force: model.reloadTracker.consume(router.reloadSignal))
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { notificationStatus = await PushManager.shared.authorizationStatus() } }
                }
                .onChange(of: avatarItem) { _, item in
                    if let item { uploadAvatar(item) }
                }
                .sheet(isPresented: $showEdit) {
                    EditProfileView()
                }
                .confirmationDialog("¿Cerrar sesión?", isPresented: $confirmLogout, titleVisibility: .visible) {
                    Button("Cerrar sesión", role: .destructive) {
                        Task { await session.logout() }
                    }
                } message: {
                    let pending = PendingRuns.pendingCount
                    if pending > 0 {
                        Text(pending == 1
                             ? "Tienes 1 carrera sin subir. Intentaremos subirla antes de salir; si no hay conexión, se borrará de este iPhone."
                             : "Tienes \(pending) carreras sin subir. Intentaremos subirlas antes de salir; si no hay conexión, se borrarán de este iPhone.")
                    }
                }
                .confirmationDialog("¿Quitar tu foto de perfil?", isPresented: $confirmRemoveAvatar, titleVisibility: .visible) {
                    Button("Quitar foto", role: .destructive) { removeAvatar() }
                } message: {
                    Text("Volverás a aparecer con tu inicial sobre tu color de territorio.")
                }
                .alert("¿Borrar tu cuenta?", isPresented: $confirmDelete) {
                    Button("Borrar definitivamente", role: .destructive) { deleteAccount() }
                    Button("Cancelar", role: .cancel) {}
                } message: {
                    Text("Se borrarán tu perfil, tus carreras, tu territorio y tus amigos. No se puede deshacer.")
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
                statsSection(user)
                rivalriesSection
            }
            IntegrationsSection()
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
                NavigationLink {
                    NotificationPreferencesView()
                } label: {
                    SocialSettingsLabel(title: "Tipos de notificaciones", systemImage: "slider.horizontal.3")
                }
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
            Text("Te avisamos cuando te roban territorio y cuando un amigo corre o te comenta. En \"Tipos de notificaciones\" eliges cuáles.")
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

    private var privacySection: some View {
        Section {
            NavigationLink {
                BlockedUsersView()
            } label: {
                SocialSettingsLabel(title: "Usuarios bloqueados", systemImage: "hand.raised")
            }
        } header: {
            SocialSectionHeader(title: "Privacidad y seguridad")
        } footer: {
            Text("Las personas que bloquees no podrán ver tu actividad ni comentarte, y tú no verás la suya.")
        }
        .listRowBackground(Color.surface)
    }

    private var aboutSection: some View {
        Section {
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
                Text("Borrar la cuenta elimina todos tus datos de Runna.io de forma permanente.")
                Text("Runna.io · Corre. Conquista. Repite.")
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

    private func uploadAvatar(_ item: PhotosPickerItem) {
        isUploadingAvatar = true
        Task {
            defer {
                isUploadingAvatar = false
                avatarItem = nil
            }
            do {
                guard let data = try await item.loadTransferable(type: Data.self),
                      let image = UIImage(data: data),
                      let jpeg = image.squareCropped().resized(maxDimension: 512).jpegData(compressionQuality: 0.8) else {
                    errorMessage = "No se ha podido leer la imagen."
                    return
                }
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
    @State private var takenColors: Set<String> = []
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
                    Text("Tu color te identifica en el mapa. Los colores con un icono ya los usa alguno de tus amigos.")
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
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: 6), spacing: 14) {
            ForEach(AppConfig.userColors, id: \.self) { option in
                colorSwatch(option)
            }
        }
    }

    private func colorSwatch(_ option: String) -> some View {
        let taken = takenColors.contains(option.uppercased()) && option.uppercased() != session.user?.color.uppercased()
        let selected = option.uppercased() == color.uppercased()
        return Button {
            color = option
        } label: {
            ZStack {
                Circle().fill(Color(hex: option))
                if selected {
                    Image(systemName: "checkmark")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(Color.white)
                } else if taken {
                    Image(systemName: "person.fill")
                        .font(.caption)
                        .foregroundStyle(Color.white.opacity(0.9))
                }
            }
            .frame(height: 40)
            .padding(3)
            .overlay {
                Circle().strokeBorder(Color(hex: option), lineWidth: selected ? 2.5 : 0)
            }
            .animation(.snappy, value: selected)
            .opacity(taken ? 0.35 : 1)
        }
        .buttonStyle(.plain)
        .disabled(taken)
        .accessibilityLabel(AppConfig.userColorNames[option] ?? option)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func load() async {
        name = session.user?.name ?? ""
        color = session.user?.color ?? ""
        if let userId = session.userId,
           let friends = try? await APIClient.shared.request("GET", "/api/friends/\(userId)", as: [AppUser].self) {
            takenColors = Set(friends.map { $0.color.uppercased() })
        }
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

extension UIImage {
    /// Centre square crop (avatars are shown in circles).
    func squareCropped() -> UIImage {
        let side = min(size.width, size.height)
        let origin = CGPoint(x: (size.width - side) / 2, y: (size.height - side) / 2)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = scale
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            draw(at: CGPoint(x: -origin.x, y: -origin.y))
        }
    }
}

/// Conquest stats of the Profile tab, kept across tab switches (stale-while-revalidate).
@MainActor
@Observable
final class ProfileModel {
    static let shared = ProfileModel()

    private(set) var conquest: ConquestStats?
    var reloadTracker = ReloadSignalTracker()

    private var ownerId: String?
    private var resource: CachedResource<ConquestStats>?

    func reset() {
        ownerId = nil
        resource = nil
        conquest = nil
        reloadTracker = ReloadSignalTracker()
    }

    func load(userId: String, force: Bool) async {
        if ownerId != userId {
            reset()
            ownerId = userId
            resource = CachedResource("/api/conquest-stats/\(userId)")
        }
        guard let resource else { return }
        if let cached = await resource.loadCached() {
            conquest = cached
        }
        if !force && conquest != nil && resource.isFresh { return }
        // On failure the last known stats stay on screen
        if let loaded = try? await resource.fetch() {
            conquest = loaded
        }
    }
}
