import SwiftUI
import MapKit

/// Shown after finishing a run: upload progress, conquered territory and victims.
struct RunSummaryView: View {
    let submission: RunSubmission
    let onClose: () -> Void

    @State private var routeName = ""
    @State private var renameSaved = false
    @State private var errorMessage: String?
    @State private var tauntVictim: Victim?
    @State private var retrying = false

    private var run: FinishedRun { submission.run }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    routePreview
                    stats
                    resultSection
                    if submission.route != nil {
                        renameSection
                    }
                    if !run.treasures.isEmpty {
                        treasuresSection
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
                        .disabled(isUploading)
                }
            }
            .errorAlert($errorMessage)
            .sheet(item: $tauntVictim) { victim in
                TauntComposerView(victim: victim)
            }
        }
        .interactiveDismissDisabled(isUploading)
    }

    private var isUploading: Bool {
        if case .uploading = submission.state { return true }
        return false
    }

    private var routePreview: some View {
        Map(initialPosition: .automatic, interactionModes: []) {
            MapPolyline(coordinates: run.coordinates)
                .stroke(Color.brand, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
        }
        .frame(height: 220)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
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
                conquestCard(result)
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
                Button {
                    retrying = true
                    Task {
                        let uploaded = await PendingRuns.uploadAll()
                        retrying = false
                        if uploaded > 0 {
                            onClose()
                        } else {
                            errorMessage = "Sigue sin haber conexión con el servidor."
                        }
                    }
                } label: {
                    if retrying { ProgressView().tint(.white) } else { Text("Reintentar ahora") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(retrying)
            }
        }
    }

    private func conquestCard(_ result: ConquestResult) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Territorio", systemImage: "flag.fill")
                .font(.headline)
            HStack {
                StatTile(value: Format.area(result.newAreaConquered), label: "Conquistado", tint: .brand)
                StatTile(value: Format.area(result.areaStolen), label: "Robado", tint: .red)
            }
            if !result.victims.isEmpty {
                Divider()
                Text("Has robado territorio a:")
                    .font(.subheadline.weight(.semibold))
                ForEach(result.victims) { victim in
                    HStack {
                        Circle().fill(Color(hex: victim.userColor)).frame(width: 12, height: 12)
                        Text(victim.userName)
                        Spacer()
                        Text(Format.area(victim.stolenArea))
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                        Button {
                            tauntVictim = victim
                        } label: {
                            Image(systemName: "camera.fill")
                        }
                        .buttonStyle(.bordered)
                        .accessibilityLabel("Enviar foto a \(victim.userName)")
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
    }

    private var renameSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Nombre de la carrera")
                .font(.subheadline.weight(.semibold))
            HStack {
                TextField(PendingRuns.Entry(run: run).name, text: $routeName)
                    .textFieldStyle(.roundedBorder)
                Button(renameSaved ? "Guardado" : "Guardar") {
                    rename()
                }
                .disabled(routeName.trimmingCharacters(in: .whitespaces).isEmpty || renameSaved)
            }
        }
        .cardStyle()
    }

    private var treasuresSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Tesoros recogidos", systemImage: "gift.fill")
                .font(.headline)
            ForEach(run.treasures) { treasure in
                HStack {
                    Text(treasure.emoji ?? "🎁")
                    Text(treasure.powerName ?? treasure.name)
                    Spacer()
                    Text(treasure.rarity.capitalized)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
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

    private func rename() {
        guard let route = submission.route else { return }
        let name = routeName.trimmingCharacters(in: .whitespaces)
        Task {
            do {
                try await APIClient.shared.send("PATCH", "/api/routes/\(route.id)/name", body: ["name": name])
                renameSaved = true
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
