import SwiftUI
import Photos
import UniformTypeIdentifiers
import UIKit

/// Share a run: swipe through the cards (sticker, map, conquest, league), choose what they show,
/// then copy, save or share; or make a video (cinematic 2D or the 3D follow camera) and save it to
/// the photo library, without watching the replay first.
struct ShareStudioView: View {
    let run: ShareRun
    /// Opened from the "Vídeo" button: the video section comes first.
    var startWithVideo = false

    @Environment(\.dismiss) private var dismiss
    @State private var context: ShareContext
    @State private var template: ShareTemplate = .sticker
    @State private var options = ShareOptions(background: .transparent)
    @State private var videoStyle: VideoStyle = .cinematic
    @AppStorage("replay_speed") private var speed: Double = 1
    @State private var videoProgress: Double?
    @State private var videoTask: Task<Void, Never>?
    @State private var video: SharedFile?
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
                ? "Se crea en unos segundos."
                : "La cámara te sigue por detrás. Se reproduce en pantalla mientras se graba."
        }
    }

    init(run: ShareRun, conquest: ConquestResult? = nil, startWithVideo: Bool = false) {
        self.run = run
        self.startWithVideo = startWithVideo
        _context = State(initialValue: ShareContext(run: run, conquest: conquest))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    if startWithVideo {
                        videoSection
                        imagesSection
                    } else {
                        imagesSection
                        videoSection
                    }
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
                    Label(toast, systemImage: "checkmark.circle.fill")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, DS.Spacing.l)
                        .padding(.vertical, DS.Spacing.s)
                        .glassSurface(Capsule())
                        .padding(.top, DS.Spacing.s)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.snappy, value: toast)
            .animation(.snappy, value: context.isLoading)
            .task { await context.load() }
            .onChange(of: template) { _, new in
                // The sticker goes over a photo; the conquest card looks best on dark
                if new == .sticker { options.background = .transparent }
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
                    autoRecord: true,
                    videoFileName: run.fileBaseName
                )
            }
            .errorAlert($errorMessage)
            .onDisappear { videoTask?.cancel() }
        }
    }

    // MARK: Images

    private var imagesSection: some View {
        VStack(spacing: DS.Spacing.l) {
            carousel
            optionChips
            HStack(spacing: 28) {
                circleAction("Copiar", systemImage: "doc.on.doc") { copy() }
                circleAction("Guardar", systemImage: "arrow.down.to.line") { saveImage() }
                circleAction("Compartir", systemImage: "square.and.arrow.up") { shareImage() }
            }
            .padding(.top, 4)
        }
    }

    /// The cards, side by side (swipe), each at its real proportions.
    private var carousel: some View {
        let templates = context.isLoading ? [ShareTemplate.sticker, .map] : context.templates
        return VStack(spacing: 10) {
            TabView(selection: $template) {
                ForEach(templates) { item in
                    preview(item)
                        .tag(item)
                        .padding(.horizontal, 4)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .frame(height: 440)
            HStack(spacing: 6) {
                ForEach(templates) { item in
                    Button {
                        withAnimation(.snappy) { template = item }
                    } label: {
                        Text(item.title)
                            .font(.footnote.weight(template == item ? .semibold : .regular))
                            .foregroundStyle(template == item ? Color.primary : Color.secondary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(template == item ? Color.primary.opacity(0.08) : Color.clear, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .onChange(of: context.templates) { _, available in
            if !available.contains(template) { template = .sticker }
        }
    }

    private func preview(_ item: ShareTemplate) -> some View {
        let size = item.size
        let scale = min(300 / size.width, 430 / size.height)
        return ZStack {
            if item.allowsTransparency && options.background == .transparent {
                LinearGradient(colors: [Color(white: 0.55), Color(white: 0.3)], startPoint: .topLeading, endPoint: .bottomTrailing)
            }
            ShareCardView(template: item, context: context, options: options)
                .environment(\.colorScheme, .dark)
                .scaleEffect(scale)
                .frame(width: size.width * scale, height: size.height * scale)
        }
        .frame(width: size.width * scale, height: size.height * scale)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .shadow(color: Color.black.opacity(0.18), radius: 16, x: 0, y: 8)
        .overlay {
            if context.isLoading { ProgressView() }
        }
    }

    /// Only the options that change something for this run.
    private var optionChips: some View {
        let chips = availableChips
        return VStack(spacing: 12) {
            FlowChips(items: chips.map(\.0)) { index in
                let keyPath = chips[index].1
                return Binding(get: { options[keyPath: keyPath] }, set: { options[keyPath: keyPath] = $0 })
            }
            if template.allowsTransparency {
                Picker("Fondo", selection: $options.background) {
                    ForEach(ShareOptions.Background.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
            }
        }
    }

    private var availableChips: [(String, WritableKeyPath<ShareOptions, Bool>)] {
        var chips: [(String, WritableKeyPath<ShareOptions, Bool>)] = [
            ("Distancia", \.distance), ("Tiempo", \.time), ("Ritmo", \.pace),
        ]
        if context.hasTerritory { chips.append(("Territorio", \.territory)) }
        if context.hasSteals { chips.append(("Robos", \.steals)) }
        if context.hasRanking { chips.append(("Ranking", \.ranking)) }
        return chips
    }

    private func circleAction(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: 18, weight: .medium))
                    .frame(width: 54, height: 54)
                    .background(Color.primary.opacity(0.07), in: Circle())
                Text(title)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .disabled(context.isLoading)
    }

    private var cardPNG: Data? {
        ShareCardRenderer.image(template, context: context, options: options)?.pngData()
    }

    private func copy() {
        guard let png = cardPNG else { return }
        UIPasteboard.general.setData(png, forPasteboardType: UTType.png.identifier)
        Haptics.success()
        show("Copiada. Pégala en Instagram o WhatsApp")
    }

    private func saveImage() {
        guard let png = cardPNG else { return }
        Task {
            do {
                try await PhotoSaver.save(png, type: .photo, fileName: "\(run.fileBaseName).png")
                Haptics.success()
                show("Guardada en Fotos")
            } catch {
                errorMessage = PhotoSaver.deniedMessage
            }
        }
    }

    private func shareImage() {
        guard let png = cardPNG else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(run.fileBaseName).png")
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
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Vídeo")
                    .font(.headline)
                Spacer()
                Picker("Velocidad", selection: $speed) {
                    ForEach(RouteReplayState.speeds, id: \.self) { Text(RouteReplayState.speedLabel($0)).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 150)
            }
            Picker("Estilo", selection: $videoStyle) {
                ForEach(VideoStyle.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            Text(videoStyle.detail)
                .font(.footnote)
                .foregroundStyle(.secondary)

            if let video {
                HStack(spacing: DS.Spacing.s) {
                    Button {
                        saveVideo(video.url)
                    } label: {
                        Label("Guardar en la galería", systemImage: "arrow.down.to.line")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    Button {
                        sharedFile = video
                    } label: {
                        Image(systemName: "square.and.arrow.up")
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(SecondaryButtonStyle(tint: .primary))
                    .accessibilityLabel("Compartir vídeo")
                }
            } else if let videoProgress {
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
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .onChange(of: videoStyle) { _, _ in video = nil }
        .onChange(of: speed) { _, _ in video = nil }
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
                    video = SharedFile(url: url)
                    saveVideo(url)
                } catch is CancellationError {
                    videoProgress = nil
                } catch {
                    videoProgress = nil
                    errorMessage = "No se ha podido crear el vídeo (\(error.localizedDescription))."
                }
            }
        }
    }

    private func saveVideo(_ url: URL) {
        Task {
            do {
                try await PhotoSaver.saveVideo(at: url, fileName: "\(run.fileBaseName).mp4")
                Haptics.success()
                show("Vídeo guardado en Fotos")
            } catch {
                errorMessage = PhotoSaver.deniedMessage
            }
        }
    }
}

/// Toggle chips that wrap onto several lines.
private struct FlowChips: View {
    let items: [String]
    let binding: (Int) -> Binding<Bool>

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 8)], spacing: 8) {
            ForEach(items.indices, id: \.self) { index in
                let isOn = binding(index)
                Button {
                    isOn.wrappedValue.toggle()
                } label: {
                    Text(items[index])
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(isOn.wrappedValue ? Color(uiColor: .systemBackground) : Color.primary)
                        .frame(maxWidth: .infinity, minHeight: 34)
                        .background(isOn.wrappedValue ? Color.primary : Color.primary.opacity(0.07), in: Capsule())
                }
                .buttonStyle(.plain)
                .sensoryFeedback(.selection, trigger: isOn.wrappedValue)
            }
        }
    }
}

/// A file handed to the share sheet.
struct SharedFile: Identifiable {
    let url: URL
    var id: URL { url }
}

/// iOS share sheet (Instagram, WhatsApp…).
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Saves pictures and videos to the photo library ("add only" access), with their file name.
enum PhotoSaver {
    struct Denied: Error {}

    static let deniedMessage = "No se ha podido guardar en Fotos. Permite el acceso en Ajustes → Runna.io → Fotos."

    static func save(_ data: Data, type: PHAssetResourceType, fileName: String) async throws {
        try await authorize()
        let options = PHAssetResourceCreationOptions()
        options.originalFilename = fileName
        try await PHPhotoLibrary.shared().performChanges {
            PHAssetCreationRequest.forAsset().addResource(with: type, data: data, options: options)
        }
    }

    static func saveVideo(at url: URL, fileName: String) async throws {
        try await authorize()
        let options = PHAssetResourceCreationOptions()
        options.originalFilename = fileName
        try await PHPhotoLibrary.shared().performChanges {
            PHAssetCreationRequest.forAsset().addResource(with: .video, fileURL: url, options: options)
        }
    }

    private static func authorize() async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { throw Denied() }
    }
}
