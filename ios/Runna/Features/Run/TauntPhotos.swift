import SwiftUI
import UIKit

/// Take a photo and send it (viewable once) to someone whose territory you stole.
struct TauntComposerView: View {
    let victim: Victim

    @Environment(\.dismiss) private var dismiss
    @State private var image: UIImage?
    @State private var message = ""
    @State private var showCamera = false
    @State private var isSending = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .frame(maxHeight: 360)
                    TextField("Mensaje (opcional)", text: $message)
                        .textFieldStyle(.roundedBorder)
                    Button {
                        send(image)
                    } label: {
                        if isSending { ProgressView().tint(.white) } else { Text("Enviar a \(victim.userName)") }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(isSending)
                    Button("Repetir foto") { showCamera = true }
                } else {
                    Spacer()
                    Image(systemName: "camera.fill")
                        .font(.system(size: 56))
                        .foregroundStyle(Color.brand)
                    Text("Hazle una foto a \(victim.userName). La verá una sola vez.")
                        .multilineTextAlignment(.center)
                    Button("Abrir cámara") { showCamera = true }
                        .buttonStyle(PrimaryButtonStyle())
                    Spacer()
                }
            }
            .padding()
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
    @Environment(\.scenePhase) private var scenePhase
    @State private var pending: [PendingPhoto] = []
    @State private var current: PendingPhoto?

    func body(content: Content) -> some View {
        content
            .task(id: session.userId) { await refresh() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await refresh() } }
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
        VStack(spacing: 18) {
            HStack(spacing: 12) {
                AvatarView(name: photo.senderName, avatar: photo.senderAvatar, color: "#16A34A", size: 44)
                VStack(alignment: .leading) {
                    Text(photo.senderName).font(.headline)
                    if let area = photo.areaStolen, area > 0 {
                        Text("Te ha robado \(Format.area(area))")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }

            if !revealed {
                Spacer()
                Text("Te ha enviado una foto. Solo podrás verla una vez.")
                    .multilineTextAlignment(.center)
                Button("Ver foto") { reveal() }
                    .buttonStyle(PrimaryButtonStyle())
                Spacer()
            } else if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                if let text, !text.isEmpty {
                    Text("“\(text)”").font(.title3.italic())
                }
                Spacer()
            } else if failed {
                Spacer()
                Text("Esta foto ya no está disponible.")
                Spacer()
            } else {
                Spacer()
                ProgressView()
                Spacer()
            }

            Button("Cerrar") { dismiss() }
        }
        .padding()
        .presentationDetents([.large])
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
