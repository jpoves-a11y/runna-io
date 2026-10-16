import SwiftUI
import UIKit

/// Take a photo and send it (viewable once) to someone whose territory you stole.
struct TauntComposerView: View {
    let victim: Victim
    /// Called once the photo has been sent.
    var onSent: () -> Void = {}

    @Environment(\.dismiss) private var dismiss
    @State private var image: UIImage?
    @State private var message = ""
    @State private var showCamera = false
    @State private var isSending = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: DS.Spacing.xl) {
                    if let image {
                        preview(image)
                    } else {
                        intro
                    }
                }
                .padding(DS.Spacing.l)
                .animation(.snappy, value: image != nil)
            }
            .scrollDismissesKeyboard(.interactively)
            .screenBackground()
            .navigationTitle("Foto para \(victim.userName)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker(image: $image)
                    .ignoresSafeArea()
            }
            .errorAlert($errorMessage)
        }
    }

    private var intro: some View {
        VStack(spacing: DS.Spacing.xl) {
            ZStack {
                Circle()
                    .fill(Color.steal.opacity(0.10))
                    .frame(width: 180, height: 180)
                Circle()
                    .fill(.stealGradient)
                    .frame(width: 120, height: 120)
                    .shadow(color: Color.steal.opacity(0.4), radius: 18, x: 0, y: 10)
                Image(systemName: "camera.fill")
                    .font(.system(size: 50, weight: .bold))
                    .foregroundStyle(.white)
                    .symbolEffect(.bounce, value: showCamera)
                AvatarView(name: victim.userName, avatar: nil, color: victim.userColor, size: 54)
                    .background(Color.surface, in: Circle())
                    .offset(x: 62, y: 52)
            }
            .padding(.top, DS.Spacing.xxl)
            VStack(spacing: DS.Spacing.s) {
                Text("Déjale un recuerdo a \(victim.userName)")
                    .font(.system(.title2, design: .rounded, weight: .heavy))
                    .multilineTextAlignment(.center)
                Text("Le has quitado \(Format.area(victim.stolenArea)). Mándale una foto: la verá una sola vez y luego desaparece.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            Button {
                showCamera = true
            } label: {
                Label("Abrir cámara", systemImage: "camera.fill")
            }
            .buttonStyle(PrimaryButtonStyle(color: Color.steal))
        }
    }

    private func preview(_ image: UIImage) -> some View {
        VStack(spacing: DS.Spacing.l) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxHeight: 380)
                .clipShape(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
                .overlay(alignment: .topLeading) {
                    Label("Se ve una vez", systemImage: "eye.fill")
                        .font(.system(.caption, design: .rounded, weight: .bold))
                        .padding(.horizontal, 10)
                        .frame(height: 28)
                        .glassSurface(Capsule())
                        .padding(DS.Spacing.m)
                }
                .shadow(color: Color.black.opacity(0.15), radius: 14, x: 0, y: 8)
            HStack(spacing: DS.Spacing.m) {
                Image(systemName: "text.bubble.fill")
                    .foregroundStyle(Color.steal)
                TextField("Añade un mensaje (opcional)", text: $message)
                    .font(.system(.body, design: .rounded))
            }
            .padding(.horizontal, DS.Spacing.l)
            .frame(minHeight: 52)
            .background(Color.surface, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous).strokeBorder(Color.hairline, lineWidth: 1))
            Button {
                send(image)
            } label: {
                if isSending {
                    ProgressView().tint(.white)
                } else {
                    Label("Enviar a \(victim.userName)", systemImage: "paperplane.fill")
                }
            }
            .buttonStyle(PrimaryButtonStyle(color: Color.steal))
            .disabled(isSending)
            Button {
                showCamera = true
            } label: {
                Label("Repetir foto", systemImage: "arrow.triangle.2.circlepath.camera.fill")
            }
            .buttonStyle(SecondaryButtonStyle(tint: Color.steal))
        }
    }

    private func send(_ image: UIImage) {
        guard let dataURL = image.compressedDataURL(maxDimension: 900, maxBase64Length: 650_000) else {
            errorMessage = "No se ha podido preparar la foto."
            return
        }
        isSending = true
        Task {
            do {
                var body: [String: Any] = [
                    "recipientId": victim.userId,
                    "photoData": dataURL,
                    "areaStolen": victim.stolenArea,
                ]
                let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { body["message"] = String(trimmed.prefix(140)) }
                try await APIClient.shared.send("POST", "/api/ephemeral-photos", body: body)
                Haptics.success()
                onSent()
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isSending = false
        }
    }
}

/// Shows photos other runners sent you; each one is deleted on the server once opened.
struct PendingPhotosModifier: ViewModifier {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    @State private var pending: [PendingPhoto] = []
    @State private var current: PendingPhoto?

    func body(content: Content) -> some View {
        content
            .task(id: session.userId) { await refresh() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await refresh() } }
            }
            // A taunt-photo push was tapped or arrived while the app is open
            .onChange(of: router.reloadSignal) { _, _ in
                Task { await refresh() }
            }
            .sheet(item: $current, onDismiss: showNext) { photo in
                EphemeralPhotoView(photo: photo)
            }
    }

    private func refresh() async {
        guard let userId = session.userId else { return }
        if let photos: [PendingPhoto] = try? await APIClient.shared.request("GET", "/api/ephemeral-photos/pending/\(userId)") {
            pending = photos
            if current == nil { showNext() }
        }
    }

    private func showNext() {
        guard !pending.isEmpty else { return }
        current = pending.removeFirst()
    }
}

private struct EphemeralPhotoView: View {
    let photo: PendingPhoto

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var image: UIImage?
    @State private var text: String?
    @State private var failed = false
    @State private var revealed = false

    var body: some View {
        VStack(spacing: DS.Spacing.xl) {
            header
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .animation(.snappy, value: revealed)
                .animation(.snappy, value: image != nil)
            Button("Cerrar") { dismiss() }
                .buttonStyle(SecondaryButtonStyle(tint: Color.secondary))
        }
        .padding(DS.Spacing.xl)
        .screenBackground()
        .presentationDetents([.large])
        .presentationCornerRadius(32)
    }

    private var header: some View {
        HStack(spacing: DS.Spacing.m) {
            AvatarView(name: photo.senderName, avatar: photo.senderAvatar, color: "#FF5F45", size: 52)
            VStack(alignment: .leading, spacing: 2) {
                Text(photo.senderName)
                    .font(.system(.headline, design: .rounded, weight: .bold))
                if let area = photo.areaStolen, area > 0 {
                    Label("Te ha robado \(Format.area(area))", systemImage: "bolt.fill")
                        .font(.system(.subheadline, design: .rounded, weight: .semibold))
                        .foregroundStyle(Color.steal)
                } else {
                    Text("Te ha mandado una foto")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .card(padding: DS.Spacing.m)
    }

    @ViewBuilder
    private var content: some View {
        if !revealed {
            VStack(spacing: DS.Spacing.l) {
                ZStack {
                    Circle()
                        .fill(Color.steal.opacity(0.10))
                        .frame(width: 170, height: 170)
                    Circle()
                        .fill(.stealGradient)
                        .frame(width: 112, height: 112)
                        .shadow(color: Color.steal.opacity(0.4), radius: 16, x: 0, y: 8)
                    Image(systemName: "eye.slash.fill")
                        .font(.system(size: 44, weight: .bold))
                        .foregroundStyle(.white)
                }
                Text("Foto sorpresa")
                    .font(.system(.title2, design: .rounded, weight: .heavy))
                Text("Solo podrás verla una vez. ¿Preparado para el vacile?")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button {
                    reveal()
                } label: {
                    Label("Ver foto", systemImage: "eye.fill")
                }
                .buttonStyle(PrimaryButtonStyle(color: Color.steal))
            }
            .transition(.opacity)
        } else if let image {
            VStack(spacing: DS.Spacing.l) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
                    .shadow(color: Color.black.opacity(0.18), radius: 16, x: 0, y: 8)
                if let text, !text.isEmpty {
                    Text("“\(text)”")
                        .font(.system(.title3, design: .rounded, weight: .semibold))
                        .italic()
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, DS.Spacing.l)
                        .padding(.vertical, DS.Spacing.m)
                        .background(Color.steal.opacity(0.12), in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
                }
            }
            .transition(.scale(scale: 0.9).combined(with: .opacity))
        } else if failed {
            EmptyStateView(
                systemImage: "photo.badge.exclamationmark",
                title: "Se esfumó",
                message: "Esta foto ya no está disponible.",
                tint: Color.steal
            )
        } else {
            ProgressView()
                .controlSize(.large)
                .tint(Color.steal)
        }
    }

    private func reveal() {
        revealed = true
        guard let userId = session.userId else { return }
        Task {
            do {
                let content: PhotoContent = try await APIClient.shared.request(
                    "GET", "/api/ephemeral-photos/\(photo.id)/view", query: ["userId": userId]
                )
                image = UIImage.fromDataURL(content.photoData)
                text = content.message
                if image == nil { failed = true }
            } catch {
                failed = true
            }
        }
    }
}

/// UIKit camera wrapped for SwiftUI.
struct CameraPicker: UIViewControllerRepresentable {
    @Binding var image: UIImage?
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        if picker.sourceType == .camera {
            picker.cameraDevice = .front
        }
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker

        init(_ parent: CameraPicker) {
            self.parent = parent
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            parent.image = info[.originalImage] as? UIImage
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

extension UIImage {
    /// Scales down and JPEG-encodes the image as a data URL that fits the server's size limit.
    func compressedDataURL(maxDimension: CGFloat, maxBase64Length: Int) -> String? {
        var dimension = maxDimension
        var quality: CGFloat = 0.6
        for _ in 0..<6 {
            guard let data = resized(maxDimension: dimension).jpegData(compressionQuality: quality) else { return nil }
            let base64 = data.base64EncodedString()
            if base64.count <= maxBase64Length {
                return "data:image/jpeg;base64,\(base64)"
            }
            dimension *= 0.8
            quality = max(0.3, quality - 0.1)
        }
        return nil
    }

    func resized(maxDimension: CGFloat) -> UIImage {
        let largest = max(size.width, size.height)
        guard largest > maxDimension else { return self }
        let scale = maxDimension / largest
        let newSize = CGSize(width: size.width * scale, height: size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: newSize, format: format).image { _ in
            draw(in: CGRect(origin: .zero, size: newSize))
        }
    }

    static func fromDataURL(_ dataURL: String) -> UIImage? {
        let base64 = dataURL.firstIndex(of: ",").map { String(dataURL[dataURL.index(after: $0)...]) } ?? dataURL
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else { return nil }
        return UIImage(data: data)
    }
}
