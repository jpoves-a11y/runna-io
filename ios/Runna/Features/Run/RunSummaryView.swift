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
                VStack(spacing: 18) {
                    RouteReplayView(
                        coordinates: run.coordinates,
                        color: Color(hex: session.user?.color ?? "#16A34A"),
                        height: 220
                    )
                    stats
                    resultSection
                    if submission.routeId != nil {
                        renameSection
                    }
                    let treasures = treasureLines
                    if !treasures.isEmpty {
                        TreasuresCard(treasures: treasures)
                    }
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("¡Carrera terminada!")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Hecho", action: onClose)
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

    private var stats: some View {
        HStack {
            StatTile(value: Format.distance(run.distance), label: "Distancia")
            StatTile(value: Format.duration(run.duration), label: "Tiempo")
            StatTile(value: Format.pace(distanceMeters: run.distance, seconds: run.duration), label: "Ritmo")
        }
        .cardStyle()
    }

    @ViewBuilder
    private var resultSection: some View {
        switch submission.state {
        case .uploading:
            progressCard("Guardando carrera…")
        case .processing:
            progressCard("Calculando el territorio conquistado…")
        case .done(let result):
            if let result {
                ConquestCard(result: result, sentVictimIds: sentVictimIds) { victim in
                    tauntVictim = victim
                }
            } else {
                infoCard(
                    icon: "hourglass",
                    text: "Tu carrera está guardada. El territorio se está calculando y aparecerá en el mapa en unos minutos."
                )
            }
        case .failed(let message):
            VStack(spacing: 12) {
                infoCard(
                    icon: "icloud.slash",
                    text: "No se ha podido subir (\(message)). La carrera está guardada en el móvil y se subirá sola cuando haya conexión."
                )
                if let retryMessage {
                    Text(retryMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                retryButton
            }
        case .rejected(let message):
            VStack(spacing: 12) {
                infoCard(
                    icon: "exclamationmark.triangle",
                    text: "El servidor no ha aceptado la carrera (\(message)). Sigue guardada en el móvil y se volverá a intentar otro día."
                )
                if let retryMessage {
                    Text(retryMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                retryButton
            }
        }
    }

    private var retryButton: some View {
        Button {
            retry()
        } label: {
            if retrying { ProgressView().tint(.white) } else { Text("Reintentar ahora") }
        }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(retrying)
    }

    private var renameSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Nombre de la carrera")
                .font(.subheadline.weight(.semibold))
            HStack {
                TextField(run.defaultName, text: $routeName)
                    .textFieldStyle(.roundedBorder)
                Button(renameSaved ? "Guardado" : "Guardar") {
                    rename()
                }
                .disabled(routeName.trimmingCharacters(in: .whitespaces).isEmpty || renameSaved)
            }
        }
        .cardStyle()
        .onChange(of: routeName) { _, _ in
            renameSaved = false
        }
    }

    private func progressCard(_ text: String) -> some View {
        HStack(spacing: 12) {
            ProgressView()
            Text(text)
            Spacer()
        }
        .cardStyle()
    }

    private func infoCard(icon: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(.secondary)
            Text(text)
                .font(.subheadline)
            Spacer()
        }
        .cardStyle()
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
