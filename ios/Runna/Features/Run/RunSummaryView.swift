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

    private var run: FinishedRun { submission.run }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: DS.Spacing.l) {
                    RunCelebrationHeader(
                        title: headerTitle,
                        subtitle: headerSubtitle,
                        isWorking: isWorking
                    )
                    .padding(.top, DS.Spacing.s)
                    RouteReplayView(
                        coordinates: run.coordinates,
                        color: Color(hex: session.user?.color ?? "#16A34A"),
                        height: 220
                    )
                    RunStatsCard(distance: run.distance, duration: run.duration)
                    resultSection
                    let treasures = treasureLines
                    if !treasures.isEmpty {
                        TreasuresCard(treasures: treasures)
                    }
                    if submission.routeId != nil {
                        renameSection
                    }
                    doneButton
                }
                .padding(.horizontal, DS.Spacing.l)
                .padding(.bottom, DS.Spacing.xxl)
                .animation(.snappy, value: stateKey)
            }
            .screenBackground()
            .navigationTitle("Resumen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Hecho", action: onClose)
                        .fontWeight(.bold)
                        .disabled(isBlocking)
                }
            }
            .errorAlert($errorMessage)
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
        case .uploading, .processing: return "¡Carrera terminada!"
        case .done(let result):
            if let result, result.totalStolen > 0 { return "¡Golpe maestro!" }
            if let result, result.newAreaConquered > 0 { return "¡Territorio conquistado!" }
            return "¡Carrera guardada!"
        case .failed, .rejected: return "¡Carrera terminada!"
        }
    }

    private var headerSubtitle: String {
        switch submission.state {
        case .uploading: return "Subiendo tu ruta…"
        case .processing: return "Pintando el mapa con tu color…"
        case .done(let result):
            if let result, result.totalStolen > 0 { return "Has entrado en terreno ajeno y has salido ganando." }
            if let result, result.newAreaConquered > 0 { return "Tu color ya ocupa más mapa. Sigue así." }
            return "Cada kilómetro cuenta."
        case .failed, .rejected: return "Tus kilómetros están a salvo en el móvil."
        }
    }

    private var doneButton: some View {
        Button(action: onClose) {
            Label(isBlocking ? "Guardando…" : "¡A por la siguiente!", systemImage: "figure.run")
        }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(isBlocking)
        .padding(.top, DS.Spacing.s)
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
            RunStatusCard(systemImage: "icloud.and.arrow.up", title: "Guardando carrera…", message: "Un segundo, estamos subiendo tu recorrido.", isLoading: true)
        case .processing:
            RunStatusCard(systemImage: "map", title: "Calculando tu conquista…", message: "Estamos midiendo cuánto mapa has pintado y a quién se lo has quitado.", isLoading: true)
        case .done(let result):
            if let result {
                ConquestCard(result: result, sentVictimIds: sentVictimIds) { victim in
                    tauntVictim = victim
                }
            } else {
                RunStatusCard(
                    systemImage: "hourglass",
                    title: "Carrera guardada",
                    message: "El territorio se está calculando y aparecerá en el mapa en unos minutos.",
                    tint: Color.grape
                )
            }
        case .failed(let message):
            failureSection(
                systemImage: "icloud.slash",
                title: "Sin conexión",
                text: "No se ha podido subir (\(message)). La carrera está guardada en el móvil y se subirá sola cuando haya conexión."
            )
        case .rejected(let message):
            failureSection(
                systemImage: "exclamationmark.triangle",
                title: "El servidor no la ha aceptado",
                text: "Motivo: \(message). Sigue guardada en el móvil y se volverá a intentar otro día."
            )
        }
    }

    private func failureSection(systemImage: String, title: String, text: String) -> some View {
        VStack(spacing: DS.Spacing.m) {
            RunStatusCard(systemImage: systemImage, title: title, message: text, tint: Color.steal)
            if let retryMessage {
                Text(retryMessage)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            retryButton
        }
    }

    private var retryButton: some View {
        Button {
            retry()
        } label: {
            if retrying {
                ProgressView().tint(Color.steal)
            } else {
                Label("Reintentar ahora", systemImage: "arrow.clockwise")
            }
        }
        .buttonStyle(SecondaryButtonStyle(tint: Color.steal))
        .disabled(retrying)
    }

    private var renameSection: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            Label("Ponle nombre a tu hazaña", systemImage: "pencil.line")
                .font(Font.cardTitle)
            HStack(spacing: DS.Spacing.s) {
                TextField(run.defaultName, text: $routeName)
                    .font(.system(.body, design: .rounded))
                    .padding(.horizontal, DS.Spacing.m)
                    .frame(minHeight: 46)
                    .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous))
                    .submitLabel(.done)
                    .onSubmit { rename() }
                Button {
                    rename()
                } label: {
                    Image(systemName: renameSaved ? "checkmark" : "arrow.up")
                        .font(.headline.weight(.heavy))
                        .foregroundStyle(.white)
                        .contentTransition(.symbolEffect(.replace))
                        .frame(width: 46, height: 46)
                        .background(.brandGradient, in: Circle())
                }
                .buttonStyle(.pressable)
                .disabled(routeName.trimmingCharacters(in: .whitespaces).isEmpty || renameSaved)
                .opacity(routeName.trimmingCharacters(in: .whitespaces).isEmpty && !renameSaved ? 0.45 : 1)
                .accessibilityLabel(renameSaved ? "Guardado" : "Guardar nombre")
            }
        }
        .card()
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
                retryMessage = "Sigue sin poder subirse. Lo volveremos a intentar automáticamente."
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
        Task {
            do {
                try await APIClient.shared.send("PATCH", "/api/routes/\(routeId)/name", body: ["name": name])
                renameSaved = true
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
