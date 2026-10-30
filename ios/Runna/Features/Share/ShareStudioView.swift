import SwiftUI
import Photos
import UniformTypeIdentifiers
import UIKit

/// Share a run: pick a card (sticker, map, conquest, league), choose what it shows, then copy it,
/// save it or share it; or create a video (cinematic 2D, generated without recording the screen,
/// or the 3D follow camera recorded cleanly), without having to watch the replay first.
struct ShareStudioView: View {
    let run: ShareRun

    @Environment(\.dismiss) private var dismiss
    @State private var context: ShareContext
    @State private var template: ShareTemplate = .sticker
    @State private var options = ShareOptions(background: .transparent)
    @State private var videoStyle: VideoStyle = .cinematic
    @AppStorage("replay_speed") private var speed: Double = 1
    @State private var videoProgress: Double?
    @State private var videoTask: Task<Void, Never>?
    @State private var sharedFile: SharedFile?
    @State private var show3DRecording = false
    @State private var toast: String?
    @State private var errorMessage: String?

    enum VideoStyle: String, CaseIterable, Identifiable {
        case cinematic, follow3D
        var id: String { rawValue }
        var title: String { self == .cinematic ? "Cinemático 2D" : "3D" }
        var detail: String {
            self == .cinematic
                ? "Se crea en unos segundos, sin grabar la pantalla."
                : "La cámara detrás de ti. Se reproduce en pantalla mientras se graba (iOS pide permiso)."
        }
    }

    init(run: ShareRun, conquest: ConquestResult? = nil) {
        self.run = run
        _context = State(initialValue: ShareContext(run: run, conquest: conquest))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: DS.Spacing.xl) {
                    Picker("Plantilla", selection: $template) {
                        ForEach(ShareTemplate.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)

                    preview
                    optionsSection
                    actions
                    videoSection
                }
                .padding(.horizontal, DS.Spacing.screen)
                .padding(.vertical, DS.Spacing.l)
            }
            .screenBackground()
            .navigationTitle("Compartir")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .overlay(alignment: .top) {
                if let toast {
                    Text(toast)
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, DS.Spacing.l)
                        .padding(.vertical, DS.Spacing.s)
                        .glassSurface(Capsule())
                        .padding(.top, DS.Spacing.s)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.snappy, value: toast)
            .task { await context.load() }
            .onChange(of: template) { _, new in
                // Stickers go over a photo; the other cards look best on dark
                options.background = new == .sticker ? .transparent : (new.allowsTransparency ? options.background : .dark)
                if new == .conquest && options.background == .transparent { options.background = .dark }
            }
            .sheet(item: $sharedFile) { file in
                ShareSheet(items: [file.url])
                    .presentationDetents([.medium, .large])
            }
            .fullScreenCover(isPresented: $show3DRecording) {
                RouteReplayView(
                    locations: run.coordinates,
                    color: run.color,
                    territories: run.territories,
                    title: run.name,
                    autoRecord: true
                )
            }
            .errorAlert($errorMessage)
            .onDisappear { videoTask?.cancel() }
        }
    }

    // MARK: Preview

    private var preview: some View {
        let size = template.size
        let scale = min(300 / size.width, 420 / size.height)
        return ZStack {
            if template.allowsTransparency && options.background == .transparent {
                Checkerboard()
            }
            ShareCardView(template: template, context: context, options: options)
                .environment(\.colorScheme, .dark)
                .scaleEffect(scale)
                .frame(width: size.width * scale, height: size.height * scale)
        }
        .frame(width: size.width * scale, height: size.height * scale)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.hairline, lineWidth: DS.Stroke.hairline))
        .shadow(color: Color.black.opacity(0.15), radius: 12, x: 0, y: 6)
        .overlay {
            if context.isLoading { ProgressView() }
        }
        .frame(maxWidth: .infinity)
        .animation(.snappy, value: template)
    }

    // MARK: Options

    private var optionsSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            SectionHeader(title: "Qué mostrar")
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 8)], spacing: 8) {
                chip("Distancia", isOn: $options.distance)
                chip("Tiempo", isOn: $options.time)
                chip("Ritmo", isOn: $options.pace)
                chip("Territorio", isOn: $options.territory)
                chip("Robos", isOn: $options.steals)
                chip("Ranking", isOn: $options.ranking)
            }
            if template.allowsTransparency {
                Picker("Fondo", selection: $options.background) {
                    ForEach(ShareOptions.Background.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
            }
        }
    }

    private func chip(_ title: String, isOn: Binding<Bool>) -> some View {
        Button {
            isOn.wrappedValue.toggle()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: isOn.wrappedValue ? "checkmark.circle.fill" : "circle")
                Text(title)
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(isOn.wrappedValue ? Color.onBrand : Color.primary)
            .frame(maxWidth: .infinity, minHeight: 36)
            .background(isOn.wrappedValue ? Color.brand : Color.primary.opacity(0.07), in: Capsule())
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.selection, trigger: isOn.wrappedValue)
    }

    // MARK: Image actions

    private var actions: some View {
        HStack(spacing: DS.Spacing.s) {
            actionButton("Copiar", systemImage: "doc.on.doc") { copy() }
            actionButton("Guardar", systemImage: "square.and.arrow.down") { save() }
            actionButton("Compartir", systemImage: "square.and.arrow.up") { shareImage() }
        }
    }

    private func actionButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: systemImage).font(.title3)
                Text(title).font(.caption.weight(.semibold))
            }
            .frame(maxWidth: .infinity, minHeight: 60)
        }
        .buttonStyle(SecondaryButtonStyle(tint: Color.primary))
        .disabled(context.isLoading)
    }

    private var cardPNG: Data? {
        ShareCardRenderer.image(template, context: context, options: options)?.pngData()
    }

    private func copy() {
        guard let png = cardPNG else { return }
        UIPasteboard.general.setData(png, forPasteboardType: UTType.png.identifier)
        Haptics.success()
        show("Copiada: pégala en Instagram o WhatsApp")
    }

    private func save() {
        guard let png = cardPNG else { return }
        Task {
            do {
                try await PhotoSaver.save(png, type: .photo)
                Haptics.success()
                show("Guardada en Fotos")
            } catch {
                errorMessage = "No se ha podido guardar en Fotos. Permite el acceso en Ajustes → Runna.io → Fotos."
            }
        }
    }

    private func shareImage() {
        guard let png = cardPNG else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("Runna-\(template.rawValue).png")
        do {
            try png.write(to: url, options: .atomic)
            sharedFile = SharedFile(url: url)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func show(_ message: String) {
        toast = message
        Task {
            try? await Task.sleep(nanoseconds: 2_200_000_000)
            if toast == message { toast = nil }
        }
    }

    // MARK: Video

    private var videoSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            SectionHeader(title: "Vídeo")
            Picker("Estilo", selection: $videoStyle) {
                ForEach(VideoStyle.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            Text(videoStyle.detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
            HStack {
                Text("Velocidad")
                    .font(.subheadline.weight(.medium))
                Spacer()
                Picker("Velocidad", selection: $speed) {
                    ForEach(RouteReplayState.speeds, id: \.self) { Text(RouteReplayState.speedLabel($0)).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 180)
            }
            if let videoProgress {
                VStack(alignment: .leading, spacing: 6) {
                    ProgressView(value: videoProgress)
                        .tint(run.color)
                    Text("Creando el vídeo… \(Int(videoProgress * 100)) %")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            } else {
                Button {
                    createVideo()
                } label: {
                    Label("Crear vídeo", systemImage: "film")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(context.isLoading || run.coordinates.count < 2)
            }
        }
        .padding(DS.Spacing.l)
        .card()
    }

    private func createVideo() {
        switch videoStyle {
        case .follow3D:
            show3DRecording = true
        case .cinematic:
            videoProgress = 0
            let renderContext = context
            let speed = speed
            videoTask = Task {
                do {
                    let url = try await ShareVideoRenderer.render(context: renderContext, speed: speed) { progress in
                        videoProgress = progress
                    }
                    videoProgress = nil
                    sharedFile = SharedFile(url: url)
                } catch is CancellationError {
                    videoProgress = nil
                } catch {
                    videoProgress = nil
                    errorMessage = "No se ha podido crear el vídeo (\(error.localizedDescription))."
                }
            }
        }
    }
}

/// Light/dark squares behind transparent cards.
private struct Checkerboard: View {
    var body: some View {
        Canvas { context, size in
            let side: CGFloat = 10
            for row in 0..<Int(size.height / side) + 1 {
                for column in 0..<Int(size.width / side) + 1 where (row + column) % 2 == 0 {
                    context.fill(Path(CGRect(x: CGFloat(column) * side, y: CGFloat(row) * side, width: side, height: side)), with: .color(Color.gray.opacity(0.25)))
                }
            }
        }
        .background(Color.gray.opacity(0.12))
    }
}

/// A file handed to the share sheet.
struct SharedFile: Identifiable {
    let url: URL
    var id: URL { url }
}

/// iOS share sheet (Guardar, Instagram, WhatsApp…).
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Saves a picture or a video to Photos (asks for "add only" access).
enum PhotoSaver {
    struct Denied: Error {}

    static func save(_ data: Data, type: PHAssetResourceType) async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { throw Denied() }
        try await PHPhotoLibrary.shared().performChanges {
            PHAssetCreationRequest.forAsset().addResource(with: type, data: data, options: nil)
        }
    }
}
