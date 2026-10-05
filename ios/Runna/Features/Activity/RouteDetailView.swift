import SwiftUI
import MapKit

/// One of your activities: map, stats, rename and delete.
struct RouteDetailView: View {
    let route: RunRoute
    let onChange: () -> Void

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var isRenaming = false
    @State private var confirmDelete = false
    @State private var isWorking = false
    @State private var errorMessage: String?

    init(route: RunRoute, onChange: @escaping () -> Void) {
        self.route = route
        self.onChange = onChange
        _name = State(initialValue: route.name)
    }

    var body: some View {
        List {
            Section {
                Map(initialPosition: .automatic) {
                    MapPolyline(coordinates: route.locations)
                        .stroke(Color(hex: session.user?.color ?? "#16A34A"), style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
                    if let start = route.locations.first {
                        Marker("Salida", systemImage: "flag", coordinate: start)
                            .tint(.green)
                    }
                }
                .frame(height: 280)
                .listRowInsets(EdgeInsets())
            }

            Section {
                LabeledContent("Fecha", value: Format.dayAndTime(route.startDate))
                LabeledContent("Distancia", value: Format.distance(route.distance))
                LabeledContent("Tiempo", value: Format.duration(route.duration))
                LabeledContent("Ritmo", value: Format.pace(distanceMeters: route.distance, seconds: route.duration))
                if let area = route.territoryArea {
                    LabeledContent("Territorio", value: Format.area(area))
                }
                if !route.ranTogetherWith.isEmpty {
                    LabeledContent("Con", value: route.ranTogetherWith.joined(separator: ", "))
                }
            }

            Section {
                Button("Cambiar nombre") { isRenaming = true }
                Button("Borrar actividad", role: .destructive) { confirmDelete = true }
            } footer: {
                Text("Al borrarla se recalcula tu territorio sin esta carrera.")
            }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .disabled(isWorking)
        .overlay { if isWorking { ProgressView() } }
        .alert("Nombre de la actividad", isPresented: $isRenaming) {
            TextField("Nombre", text: $name)
            Button("Guardar") { rename() }
            Button("Cancelar", role: .cancel) { name = route.name }
        }
        .confirmationDialog("¿Borrar esta actividad?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Borrar", role: .destructive) { delete() }
        } message: {
            Text("No se puede deshacer.")
        }
        .errorAlert($errorMessage)
    }

    private func rename() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            name = route.name
            return
        }
        isWorking = true
        Task {
            do {
                try await APIClient.shared.send("PATCH", "/api/routes/\(route.id)/name", body: ["name": trimmed])
                onChange()
            } catch {
                name = route.name
                errorMessage = error.localizedDescription
            }
            isWorking = false
        }
    }

    private func delete() {
        guard let userId = session.userId else { return }
        isWorking = true
        Task {
            do {
                try await APIClient.shared.send("DELETE", "/api/routes/\(userId)/\(route.id)")
                onChange()
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isWorking = false
        }
    }
}
