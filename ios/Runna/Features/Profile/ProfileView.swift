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
    @State private var isDeleting = false
    @State private var isSendingTest = false
    @State private var info: String?
    @State private var errorMessage: String?
    @AppStorage(AppAppearance.storageKey) private var appearance: AppAppearance = .system

    var body: some View {
        NavigationStack {
            List {
                if let user = session.user {
                    header(user)
                    statsSection(user)
                }
                IntegrationsSection()
                notificationsSection
                appearanceSection
                privacySection
                aboutSection
                accountSection
            }
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
            .overlay {
                if isDeleting {
                    ProgressView("Borrando cuenta…")
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
                }
            }
        }
    }

    // MARK: - Sections

    private func header(_ user: AppUser) -> some View {
        Section {
            HStack(spacing: 16) {
                PhotosPicker(selection: $avatarItem, matching: .images) {
                    ZStack(alignment: .bottomTrailing) {
                        AvatarView(name: user.name, avatar: user.avatar, color: user.color, size: 76)
                        Image(systemName: isUploadingAvatar ? "hourglass.circle.fill" : "camera.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.white, Color.brand)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Cambiar foto de perfil")
                .disabled(isUploadingAvatar)

                VStack(alignment: .leading, spacing: 4) {
                    Text(user.name).font(.title2.bold())
                    Text("@\(user.username)").foregroundStyle(.secondary)
                    if let email = user.email {
                        Text(email).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }
            .padding(.vertical, 6)

            Button("Editar perfil") { showEdit = true }
            if user.avatar != nil {
                Button("Quitar foto de perfil", role: .destructive) {
                    Task {
                        do { try await session.removeAvatar() } catch { errorMessage = error.localizedDescription }
                    }
                }
            }
        }
    }

    private func statsSection(_ user: AppUser) -> some View {
        Section("Estadísticas") {
            HStack {
                StatTile(value: Format.areaParts(user.totalArea).value, label: "Territorio", unit: Format.areaParts(user.totalArea).unit, tint: .brand)
                StatTile(value: user.rank.map { "#\($0)" } ?? "–", label: "Ranking amigos")
                StatTile(value: "\(user.friendCount ?? 0)", label: "Amigos")
            }
            .padding(.vertical, 4)
            if let conquest, conquest.totalStolen > 0 || conquest.totalLost > 0 {
                conquestDetails(conquest)
            }
        }
    }

    @ViewBuilder
    private func conquestDetails(_ conquest: ConquestStats) -> some View {
        let net = conquest.totalStolen - conquest.totalLost
        LabeledContent("Has robado", value: Format.area(conquest.totalStolen))
        LabeledContent("Te han robado", value: Format.area(conquest.totalLost))
        LabeledContent("Balance") {
            Text((net > 0 ? "+" : "") + Format.area(net))
                .fontWeight(.semibold)
                .foregroundStyle(net > 0 ? Color.green : (net < 0 ? Color.red : Color.secondary))
        }
        let victims = Array(conquest.stolenByUser.sorted { $0.amount > $1.amount }.prefix(3))
        if !victims.isEmpty {
            topList(title: "Tus víctimas", entries: victims, tint: .green)
        }
        let attackers = Array(conquest.lostToUser.sorted { $0.amount > $1.amount }.prefix(3))
        if !attackers.isEmpty {
            topList(title: "Quién te roba más", entries: attackers, tint: .red)
        }
    }

    private func topList(title: String, entries: [ConquestStats.Entry], tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                HStack(spacing: 8) {
                    Text("\(index + 1).")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(width: 18, alignment: .leading)
                    Circle()
                        .fill(Color(hex: entry.userColor))
                        .frame(width: 10, height: 10)
                    Text(entry.userName.isEmpty ? "Usuario" : entry.userName)
                        .font(.subheadline)
                        .lineLimit(1)
                    Spacer()
                    Text(Format.area(entry.amount))
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(tint)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var notificationsSection: some View {
        Section {
            switch notificationStatus {
            case .authorized, .provisional, .ephemeral:
                Label("Notificaciones activadas", systemImage: "bell.badge.fill")
                    .foregroundStyle(Color.brand)
                Button {
                    sendTestNotification()
                } label: {
                    HStack {
                        Label("Enviar notificación de prueba", systemImage: "paperplane")
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
                    Label("Activar notificaciones en Ajustes", systemImage: "bell.slash")
                }
            default:
                Button {
                    Task {
                        await PushManager.shared.requestPermissionAndRegister()
                        notificationStatus = await PushManager.shared.authorizationStatus()
                    }
                } label: {
                    Label("Activar notificaciones", systemImage: "bell")
                }
            }
        } header: {
            Text("Notificaciones")
        } footer: {
            Text("Te avisamos cuando te roban territorio, cuando un amigo corre o te comenta.")
        }
    }

    private var appearanceSection: some View {
        Section("Apariencia") {
            Picker("Tema", selection: $appearance) {
                ForEach(AppAppearance.allCases) { option in
                    Text(option.title).tag(option)
                }
            }
            .pickerStyle(.segmented)
            .padding(.vertical, 4)
        }
    }

    private var privacySection: some View {
        Section {
            NavigationLink {
                BlockedUsersView()
            } label: {
                Label("Usuarios bloqueados", systemImage: "hand.raised.slash")
            }
        } header: {
            Text("Privacidad y seguridad")
        } footer: {
            Text("Las personas que bloquees no podrán ver tu actividad ni comentarte, y tú no verás la suya.")
        }
    }

    private var aboutSection: some View {
        Section("Información") {
            Link(destination: AppConfig.privacyURL) { Label("Política de privacidad", systemImage: "hand.raised") }
            Link(destination: AppConfig.termsURL) { Label("Términos de uso", systemImage: "doc.text") }
            Link(destination: AppConfig.supportURL) { Label("Ayuda y soporte", systemImage: "questionmark.circle") }
            if let mail = AppConfig.supportMailURL {
                Link(destination: mail) {
                    LabeledContent {
                        Text(AppConfig.supportEmail)
                            .font(.caption)
                            .lineLimit(1)
                    } label: {
                        Label("Contactar con soporte", systemImage: "envelope")
                    }
                }
            }
            LabeledContent("Versión", value: Bundle.main.appVersion)
        }
    }

    private var accountSection: some View {
        Section {
            Button("Cerrar sesión") { confirmLogout = true }
            Button("Borrar cuenta", role: .destructive) { confirmDelete = true }
        } footer: {
            Text("Borrar la cuenta elimina todos tus datos de Runna.io de forma permanente.")
        }
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
                Haptics.success()
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
                Section("Nombre") {
                    TextField("Tu nombre", text: $name)
                        .textContentType(.name)
                }
                Section {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: 6), spacing: 14) {
                        ForEach(AppConfig.userColors, id: \.self) { option in
                            let taken = takenColors.contains(option.uppercased()) && option.uppercased() != session.user?.color.uppercased()
                            Button {
                                color = option
                            } label: {
                                ZStack {
                                    Circle().fill(Color(hex: option))
                                    if option.uppercased() == color.uppercased() {
                                        Image(systemName: "checkmark").font(.headline).foregroundStyle(.white)
                                    } else if taken {
                                        Image(systemName: "person.fill").font(.caption).foregroundStyle(.white.opacity(0.9))
                                    }
                                }
                                .frame(height: 40)
                                .opacity(taken ? 0.35 : 1)
                            }
                            .buttonStyle(.plain)
                            .disabled(taken)
                            .accessibilityLabel(AppConfig.userColorNames[option] ?? option)
                        }
                    }
                    .padding(.vertical, 6)
                } header: {
                    Text("Color de tu territorio")
                } footer: {
                    Text("Los colores con un icono ya los usa alguno de tus amigos.")
                }
            }
            .navigationTitle("Editar perfil")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Guardar") { save() }
                        .disabled(isSaving || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .errorAlert($errorMessage)
            .task { await load() }
        }
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
