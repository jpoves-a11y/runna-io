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
                .padding(DS.Spacing.screen)
                .animation(.snappy, value: image != nil)
            }
            .scrollDismissesKeyboard(.interactively)
            .screenBackground()
            .navigationTitle("Enviar foto")
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
        VStack(alignment: .leading, spacing: DS.Spacing.xxl) {
            VStack(alignment: .leading, spacing: DS.Spacing.l) {
                AvatarView(name: victim.userName, avatar: nil, color: victim.userColor, size: 56)
                VStack(alignment: .leading, spacing: DS.Spacing.s) {
                    Text("Envía una foto a \(victim.userName)")
                        .font(.title2.weight(.bold))
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Le has quitado \(Format.area(victim.stolenArea)). Podrá verla una sola vez; después se elimina.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, DS.Spacing.l)
            Button {
                showCamera = true
            } label: {
                Text("Abrir cámara")
            }
            .buttonStyle(PrimaryButtonStyle())
        }
    }

    private func preview(_ image: UIImage) -> some View {
        VStack(alignment: .leading, spacing: DS.Spacing.l) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxHeight: 380)
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
                .hairlineBorder()
            Label("Se puede ver una sola vez", systemImage: "eye")
                .font(Font.meta)
                .foregroundStyle(.secondary)
            TextField("Mensaje (opcional)", text: $message)
                .font(.body)
                .padding(.horizontal, DS.Spacing.l)
                .frame(minHeight: 50)
                .background(Color.surface, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
                .hairlineBorder()
            VStack(spacing: DS.Spacing.s) {
                Button {
                    send(image)
                } label: {
                    if isSending {
                        ProgressView().tint(Color.onBrand)
                    } else {
                        Text("Enviar a \(victim.userName)")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isSending)
                Button("Repetir foto") {
                    showCamera = true
                }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(minHeight: 44)
            }
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
                .font(.body.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(minHeight: 44)
        }
        .padding(DS.Spacing.xl)
        .screenBackground()
        .presentationDetents([.large])
    }

    private var header: some View {
        HStack(spacing: DS.Spacing.m) {
            AvatarView(name: photo.senderName, avatar: photo.senderAvatar, color: "#FF5F45", size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(photo.senderName)
                    .font(Font.cardTitle)
                if let area = photo.areaStolen, area > 0 {
                    HStack(spacing: 4) {
                        Text("Te ha quitado")
                            .foregroundStyle(.secondary)
                        Text(Format.area(area))
                            .foregroundStyle(Color.steal)
                            .fontWeight(.medium)
                            .monospacedDigit()
                    }
                    .font(.subheadline)
                } else {
                    Text("Te ha enviado una foto")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var content: some View {
        if !revealed {
            VStack(alignment: .leading, spacing: DS.Spacing.l) {
                Spacer(minLength: 0)
                Image(systemName: "eye.slash")
                    .font(.system(size: 40, weight: .regular))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: DS.Spacing.s) {
                    Text("Foto de un solo uso")
                        .font(.title2.weight(.bold))
                    Text("Solo podrás verla una vez. Después se elimina.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Button {
                    reveal()
                } label: {
                    Text("Ver foto")
                }
                .buttonStyle(PrimaryButtonStyle())
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .transition(.opacity)
        } else if let image {
            VStack(alignment: .leading, spacing: DS.Spacing.l) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
                    .hairlineBorder()
                if let text, !text.isEmpty {
                    Text("“\(text)”")
                        .font(.body)
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .transition(.opacity)
        } else if failed {
            EmptyStateView(
                systemImage: "photo",
                title: "Foto no disponible",
                message: "Esta foto ya se ha visto o ha caducado."
            )
        } else {
            ProgressView()
                .controlSize(.large)
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
