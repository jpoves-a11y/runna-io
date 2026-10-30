import SwiftUI
import MapKit

/// Shown after finishing a run: upload progress, conquered territory and victims.
struct RunSummaryView: View {
    let submission: RunSubmission
    let onClose: () -> Void

    @Environment(SessionStore.self) private var session
    @State private var routeName = ""
    @State private var renameSaved = false
    @State private var errorMessage: String?
    @State private var tauntVictim: Victim?
    @State private var sentVictimIds: Set<String> = []
    @State private var retrying = false
    @State private var retryMessage: String?
    @State private var showShare = false
    @State private var shareConquest: ConquestResult?

    private var run: FinishedRun { submission.run }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: DS.Spacing.xxl) {
                    RunCelebrationHeader(
                        title: headerTitle,
                        subtitle: headerSubtitle,
                        isWorking: isWorking
                    )
                    .padding(.top, DS.Spacing.s)
                    VStack(spacing: DS.Spacing.m) {
                        RouteGrowthReplay(
                            coordinates: run.coordinates,
                            color: Color.brand,
                            height: 220
                        )
                        RunStatsCard(distance: run.distance, duration: run.duration)
                    }
                    resultSection
                    if case .done(let result) = submission.state, submission.routeId != nil {
                        Button {
                            shareConquest = result
                            showShare = true
                        } label: {
                            Label("Compartir carrera", systemImage: "square.and.arrow.up")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(SecondaryButtonStyle(tint: Color.brand))
                    }
                    let treasures: [TreasureLine] = treasureLines
                    if !treasures.isEmpty {
                        TreasuresCard(treasures: treasures)
                    }
                    if submission.routeId != nil {
                        renameSection
                    }
                }
                .padding(.horizontal, DS.Spacing.screen)
                .padding(.bottom, DS.Spacing.xxl)
                .animation(.snappy, value: stateKey)
            }
            .screenBackground()
            .safeAreaInset(edge: .bottom) {
                doneButton
            }
            .navigationTitle("Resumen")
            .navigationBarTitleDisplayMode(.inline)
            .errorAlert($errorMessage)
            .sheet(isPresented: $showShare) {
                ShareStudioView(
                    run: ShareRun(
                        routeId: submission.routeId,
                        name: routeName.isEmpty ? run.defaultName : routeName,
                        date: run.startedAt,
                        coordinates: run.coordinates,
                        distance: run.distance,
                        duration: run.duration,
                        colorHex: session.user?.color ?? "#16A34A"
                    ),
                    conquest: shareConquest
                )
            }
            .sheet(item: $tauntVictim) { victim in
                TauntComposerView(victim: victim) {
                    sentVictimIds.insert(victim.userId)
                }
            }
        }
        .interactiveDismissDisabled(isBlocking)
    }

    /// Changes whenever the upload state changes (drives the layout animation).
    private var stateKey: Int {
        switch submission.state {
        case .uploading: return 0
        case .processing: return 1
        case .done(let result): return result == nil ? 2 : 3
        case .failed: return 4
        case .rejected: return 5
        }
    }

    private var isWorking: Bool {
        switch submission.state {
        case .uploading, .processing: return true
        default: return false
        }
    }

    private var headerTitle: String {
        switch submission.state {
        case .uploading, .processing: return "Carrera terminada"
        case .done(let result):
            if let result, result.newAreaConquered > 0 { return "Territorio conquistado" }
            return "Carrera guardada"
        case .failed, .rejected: return "Carrera terminada"
        }
    }

    private var headerSubtitle: String {
        switch submission.state {
        case .uploading: return "Subiendo la ruta…"
        case .processing: return "Calculando el territorio…"
        case .done(let result):
            if let result, result.totalStolen > 0 { return "Has ganado terreno a otros corredores." }
            if let result, result.newAreaConquered > 0 { return "Tu zona en el mapa es más grande." }
            return run.defaultName
        case .failed, .rejected: return "La carrera está guardada en este iPhone."
        }
    }

    private var doneButton: some View {
        Button(action: onClose) {
            Text(isBlocking ? "Guardando…" : "Hecho")
        }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(isBlocking)
        .padding(.horizontal, DS.Spacing.screen)
        .padding(.top, DS.Spacing.m)
        .padding(.bottom, DS.Spacing.s)
        .background(Color.canvas.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) {
            HairlineDivider()
        }
    }

    /// While uploading (or retrying) the screen can't be closed, so two uploads never overlap.
    private var isBlocking: Bool {
        if retrying { return true }
        if case .uploading = submission.state { return true }
        return false
    }

    private var treasureLines: [TreasureLine] {
        var server: [CollectedTreasure] = []
        if case .done(let result) = submission.state, let result {
            server = result.treasuresCollected
        }
        return TreasureLine.merge(live: run.treasures, server: server)
    }

    @ViewBuilder
    private var resultSection: some View {
        switch submission.state {
        case .uploading:
            RunStatusCard(systemImage: "icloud.and.arrow.up", title: "Guardando la carrera", message: "Estamos subiendo tu recorrido.", isLoading: true)
        case .processing:
            RunStatusCard(systemImage: "map", title: "Calculando el territorio", message: "Medimos el área conquistada y a quién se la has ganado.", isLoading: true)
        case .done(let result):
            if let result {
                ConquestCard(result: result, sentVictimIds: sentVictimIds) { victim in
                    tauntVictim = victim
                }
            } else {
                RunStatusCard(
                    systemImage: "clock",
                    title: "Carrera guardada",
                    message: "El territorio se está calculando y aparecerá en el mapa en unos minutos."
                )
            }
        case .failed(let message):
            failureSection(
                systemImage: "icloud.slash",
                title: "Sin conexión",
                text: "No se ha podido subir (\(message)). La carrera está guardada en el iPhone y se subirá automáticamente cuando haya conexión."
            )
        case .rejected(let message):
            failureSection(
                systemImage: "exclamationmark.triangle",
                title: "El servidor no la ha aceptado",
                text: "Motivo: \(message). Sigue guardada en el iPhone y se volverá a intentar más adelante."
            )
        }
    }

    private func failureSection(systemImage: String, title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            RunStatusCard(systemImage: systemImage, title: title, message: text, tint: Color.steal)
            HStack(spacing: DS.Spacing.m) {
                retryButton
                if let retryMessage {
                    Text(retryMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var retryButton: some View {
        Button {
            retry()
        } label: {
            if retrying {
                ProgressView()
                    .controlSize(.small)
            } else {
                Text("Reintentar")
            }
        }
        .buttonStyle(SecondaryButtonStyle(tint: Color.primary))
        .disabled(retrying)
    }

    private var renameSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Nombre de la carrera")
            HStack(spacing: DS.Spacing.m) {
                TextField(run.defaultName, text: $routeName)
                    .font(.body)
                    .submitLabel(.done)
                    .onSubmit { rename() }
                Button {
                    rename()
                } label: {
                    if renameSaved {
                        Label("Guardado", systemImage: "checkmark")
                            .labelStyle(.titleAndIcon)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Guardar")
                            .foregroundStyle(Color.brand)
                    }
                }
                .font(.subheadline.weight(.semibold))
                .disabled(routeName.trimmingCharacters(in: .whitespaces).isEmpty || renameSaved)
                .opacity(routeName.trimmingCharacters(in: .whitespaces).isEmpty && !renameSaved ? 0.4 : 1)
                .accessibilityLabel(renameSaved ? "Guardado" : "Guardar nombre")
            }
            .padding(.horizontal, DS.Spacing.l)
            .frame(minHeight: 50)
            .background(Color.surface, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
            .hairlineBorder()
        }
        .sensoryFeedback(.success, trigger: renameSaved)
        .onChange(of: routeName) { _, _ in
            renameSaved = false
        }
    }

    private func retry() {
        guard !retrying else { return }
        retrying = true
        retryMessage = nil
        Task {
            await submission.submit()
            retrying = false
            switch submission.state {
            case .failed:
                retryMessage = "Sigue sin conexión. Se volverá a intentar automáticamente."
            case .rejected:
                retryMessage = "El servidor sigue sin aceptarla."
            default:
                break
            }
        }
    }

    private func rename() {
        guard let routeId = submission.routeId else { return }
        let name = routeName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        // Optimistic: saved at once in "Mis carreras" and the feed; undone if the server refuses
        let previous: String? = MyRoutesModel.shared.routes.first(where: { $0.id == routeId })?.name
        MyRoutesModel.shared.applyRename(routeId: routeId, name: name)
        renameSaved = true
        Task {
            do {
                try await APIClient.shared.send("PATCH", "/api/routes/\(routeId)/name", body: ["name": name])
            } catch {
                renameSaved = false
                if let previous {
                    MyRoutesModel.shared.applyRename(routeId: routeId, name: previous)
                }
                errorMessage = error.localizedDescription
            }
        }
    }
}
