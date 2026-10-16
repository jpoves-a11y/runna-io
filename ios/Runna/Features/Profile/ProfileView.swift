import SwiftUI
import UIKit
import PhotosUI
import UserNotifications

struct ProfileView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    @State private var conquest: ConquestStats?
    @State private var showEdit = false
    @State private var avatarItem: PhotosPickerItem?
    @State private var isUploadingAvatar = false
    @State private var notificationStatus: UNAuthorizationStatus = .notDetermined
    @State private var confirmLogout = false
    @State private var confirmDelete = false
    @State private var confirmRemoveAvatar = false
    @State private var isDeleting = false
    @State private var isSendingTest = false
    @State private var info: String?
    @State private var errorMessage: String?
    @State private var avatarUploads = 0
    @AppStorage(AppAppearance.storageKey) private var appearance: AppAppearance = .system

    var body: some View {
        NavigationStack {
            list
                .navigationTitle("Perfil")
                .refreshable { await reload() }
                .task(id: router.reloadSignal) { await reload() }
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
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
    }

    // MARK: - Stats

    private func statsSection(_ user: AppUser) -> some View {
        Section {
            ProfileStatsCard(user: user, conquest: conquest)
                .listRowBackground(Color.surface)
        } header: {
            SocialSectionHeader(title: "Tus números", systemImage: "chart.bar.fill")
        }
    }

    @ViewBuilder
    private var rivalriesSection: some View {
        if let conquest {
            Section {
                ProfileRivalriesContent(conquest: conquest)
                    .listRowBackground(Color.surface)
            } header: {
                SocialSectionHeader(title: "Rivalidades", systemImage: "flame.fill", tint: .steal)
            }
        }
    }

    // MARK: - Settings

    private var notificationsSection: some View {
        Section {
            switch notificationStatus {
            case .authorized, .provisional, .ephemeral:
                HStack {
                    SocialSettingsLabel(title: "Notificaciones activadas", systemImage: "bell.badge.fill", tint: .steal)
                    Spacer()
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.brand)
                        .accessibilityHidden(true)
                }
                Button {
                    sendTestNotification()
                } label: {
                    HStack {
                        SocialSettingsLabel(title: "Enviar notificación de prueba", systemImage: "paperplane.fill", tint: .sky)
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
                    SocialSettingsLabel(title: "Activar notificaciones en Ajustes", systemImage: "bell.slash.fill", tint: .secondary)
                }
            default:
                Button {
                    Task {
                        await PushManager.shared.requestPermissionAndRegister()
                        notificationStatus = await PushManager.shared.authorizationStatus()
                    }
                } label: {
                    SocialSettingsLabel(title: "Activar notificaciones", systemImage: "bell.fill", tint: .steal)
                }
            }
        } header: {
            SocialSectionHeader(title: "Notificaciones", systemImage: "bell.fill", tint: .steal)
        } footer: {
            Text("Te avisamos cuando te roban territorio, cuando un amigo corre o te comenta.")
        }
        .listRowBackground(Color.surface)
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
            SocialSectionHeader(title: "Apariencia", systemImage: "circle.lefthalf.filled", tint: .grape)
        }
        .listRowBackground(Color.surface)
    }

    private var privacySection: some View {
        Section {
            NavigationLink {
                BlockedUsersView()
            } label: {
                SocialSettingsLabel(title: "Usuarios bloqueados", systemImage: "hand.raised.fill", tint: .steal)
            }
        } header: {
            SocialSectionHeader(title: "Privacidad y seguridad", systemImage: "lock.fill", tint: .sky)
        } footer: {
            Text("Las personas que bloquees no podrán ver tu actividad ni comentarte, y tú no verás la suya.")
        }
        .listRowBackground(Color.surface)
    }

    private var aboutSection: some View {
        Section {
            Link(destination: AppConfig.privacyURL) {
                SocialSettingsLabel(title: "Política de privacidad", systemImage: "hand.raised.fill", tint: .sky)
            }
            Link(destination: AppConfig.termsURL) {
                SocialSettingsLabel(title: "Términos de uso", systemImage: "doc.text.fill", tint: .grape)
            }
            Link(destination: AppConfig.supportURL) {
                SocialSettingsLabel(title: "Ayuda y soporte", systemImage: "questionmark.circle.fill", tint: .brand)
            }
            if let mail = AppConfig.supportMailURL {
                Link(destination: mail) {
                    SocialSettingsLabel(title: "Contactar con soporte", systemImage: "envelope.fill", tint: .gold, value: AppConfig.supportEmail)
                }
            }
            SocialSettingsLabel(title: "Versión", systemImage: "info.circle.fill", tint: .secondary, value: Bundle.main.appVersion)
        } header: {
            SocialSectionHeader(title: "Información", systemImage: "info.circle.fill", tint: .secondary)
        }
        .listRowBackground(Color.surface)
    }

    private var accountSection: some View {
        Section {
            Button {
                confirmLogout = true
            } label: {
                SocialSettingsLabel(title: "Cerrar sesión", systemImage: "rectangle.portrait.and.arrow.right", tint: .secondary)
            }
            Button(role: .destructive) {
                confirmDelete = true
            } label: {
                HStack(spacing: 12) {
                    SocialIconTile(systemImage: "trash.fill", tint: .red)
                    Text("Borrar cuenta")
                        .foregroundStyle(Color.red)
                }
            }
        } header: {
            SocialSectionHeader(title: "Cuenta", systemImage: "person.crop.circle.fill", tint: .secondary)
        } footer: {
            VStack(alignment: .leading, spacing: 12) {
                Text("Borrar la cuenta elimina todos tus datos de Runna.io de forma permanente.")
                Text("Runna.io · Corre. Conquista. Repite.")
                    .font(.system(.caption, design: .rounded, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)
            }
        }
        .listRowBackground(Color.surface)
    }

    // MARK: - Actions

    private func reload() async {
        await session.refreshUser()
        notificationStatus = await PushManager.shared.authorizationStatus()
        if let userId = session.userId {
            conquest = try? await APIClient.shared.request("GET", "/api/conquest-stats/\(userId)", as: ConquestStats.self)
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
            } catch let error as APIError where error.status == 404 {
                info = "Este iPhone todavía no está registrado para recibir notificaciones. Inténtalo de nuevo en unos segundos."
            } catch {
                errorMessage = error.localizedDescription
            }
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
                        .font(.system(.body, design: .rounded, weight: .semibold))
                } header: {
                    SocialSectionHeader(title: "Nombre", systemImage: "person.fill")
                }
                .listRowBackground(Color.surface)
                Section {
                    colorGrid
                        .padding(.vertical, 8)
                } header: {
                    SocialSectionHeader(title: "Color de tu territorio", systemImage: "paintpalette.fill", tint: Color(hex: color))
                } footer: {
                    Text("Tu color es tu identidad en el mapa. Los que tienen un icono ya los usa alguno de tus amigos.")
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
                size: 96
            )
            .shadow(color: Color(hex: color).opacity(0.4), radius: 14, x: 0, y: 6)
            .animation(.snappy, value: color)
            Text(name.isEmpty ? "Tu nombre" : name)
                .font(.system(.title3, design: .rounded, weight: .bold))
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
                Circle().fill(Color(hex: option).gradient)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.headline.weight(.heavy))
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
            .scaleEffect(selected ? 1.06 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.6), value: selected)
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
