import SwiftUI

/// "Tipos de notificaciones": which kinds of push notifications the account gets (GET/PUT /api/push/preferences).
/// Everything is on until the user turns something off; each switch is saved at once.
struct NotificationPreferencesView: View {
    private struct Kind: Identifiable {
        let id: String
        let title: String
        let detail: String
        let systemImage: String
        let tint: Color
    }

    private static let kinds: [Kind] = [
        Kind(id: "conquest", title: "Robos y ranking", detail: "Cuando te roban territorio o te adelantan en el ranking.", systemImage: "shield.lefthalf.filled", tint: .steal),
        Kind(id: "runs", title: "Tus carreras importadas", detail: "Lo que ha conquistado cada carrera de Strava, Polar, Garmin o Suunto.", systemImage: "checkmark.circle", tint: .brand),
        Kind(id: "friends", title: "Carreras de amigos", detail: "Cuando un amigo sale a correr. Llegan sin sonido.", systemImage: "figure.run", tint: .brand),
        Kind(id: "social", title: "Comentarios y amistad", detail: "Comentarios, respuestas, menciones, me gusta, fotos y solicitudes.", systemImage: "bubble.left.and.bubble.right", tint: .brand),
        Kind(id: "competition", title: "Competición", detail: "Tesoros (de 9 a 21 h), apodos y el resumen semanal.", systemImage: "trophy", tint: .gold),
        Kind(id: "reminders", title: "Recordatorios", detail: "Si llevas días sin correr: como mucho tres avisos y luego nada.", systemImage: "bell", tint: .secondary),
    ]

    @State private var settings: [String: Bool] = [:]
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var errorMessage: String?

    var body: some View {
        List {
            if !settings.isEmpty {
                Section {
                    ForEach(Self.kinds) { kind in
                        Toggle(isOn: binding(for: kind.id)) {
                            HStack(spacing: 12) {
                                SocialIconTile(systemImage: kind.systemImage, tint: kind.tint, size: 28)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(kind.title)
                                    Text(kind.detail)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                        .tint(Color.brand)
                        .listRowBackground(Color.surface)
                    }
                } footer: {
                    Text("Para silenciarlas todas, desactiva las notificaciones de Runna.io en los Ajustes del iPhone.")
                }
            }
        }
        .overlay {
            if settings.isEmpty {
                if isLoading {
                    ProgressView()
                } else if let loadError {
                    ErrorView(message: loadError) { Task { await load() } }
                }
            }
        }
        .listStyle(.insetGrouped)
        .listBackground()
        .navigationTitle("Tipos de notificaciones")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .errorAlert($errorMessage)
    }

    private func binding(for id: String) -> Binding<Bool> {
        Binding(
            get: { settings[id] ?? true },
            set: { value in save(id, value) }
        )
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            settings = try await APIClient.shared.request("GET", "/api/push/preferences")
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    /// Optimistic: the switch moves at once and goes back if the server refuses.
    private func save(_ id: String, _ value: Bool) {
        let previous = settings[id] ?? true
        settings[id] = value
        Task {
            do {
                let saved: [String: Bool] = try await APIClient.shared.request("PUT", "/api/push/preferences", body: [id: value])
                settings = saved
            } catch {
                settings[id] = previous
                errorMessage = "No se ha podido guardar. \(error.localizedDescription)"
            }
        }
    }
}
