import SwiftUI
import MapKit

/// An activity: map, stats and, for your own activities, rename and delete.
struct RouteDetailView: View {
    let route: RunRoute
    /// Route colour (the owner's territory colour); defaults to yours.
    let color: String?
    /// Rename/delete are only offered on your own activities.
    let editable: Bool
    let onChange: () -> Void

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var isRenaming = false
    @State private var confirmDelete = false
    @State private var isWorking = false
    @State private var errorMessage: String?

    init(route: RunRoute, color: String? = nil, editable: Bool = true, onChange: @escaping () -> Void = {}) {
        self.route = route
        self.color = color
        self.editable = editable
        self.onChange = onChange
        _name = State(initialValue: route.name)
    }

    private var lineColor: Color {
        Color(hex: color ?? session.user?.color ?? "#16A34A")
    }

    var body: some View {
        List {
            Section {
                if route.locations.count >= 2 {
                    Map(initialPosition: .automatic) {
                        MapPolyline(coordinates: route.locations)
                            .stroke(lineColor, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
                        if let start = route.locations.first {
                            Marker("Salida", systemImage: "flag", coordinate: start)
                                .tint(.green)
                        }
                        if let end = route.locations.last {
                            Marker("Llegada", systemImage: "flag.checkered", coordinate: end)
                                .tint(.red)
                        }
                    }
                    .frame(height: 280)
                    .listRowInsets(EdgeInsets())
                } else {
                    ContentUnavailableView("Sin datos GPS", systemImage: "location.slash", description: Text("Esta actividad no tiene recorrido registrado."))
                        .frame(height: 200)
                }
            }

            Section {
                LabeledContent("Fecha", value: Format.dayAndTime(route.startDate))
                LabeledContent("Distancia", value: Format.distance(route.distance))
                LabeledContent("Tiempo", value: Format.duration(route.duration))
                LabeledContent("Ritmo", value: Format.pace(distanceMeters: route.distance, seconds: route.duration))
                if let area = route.territoryArea, area > 0 {
                    LabeledContent("Conquistado", value: "+\(Format.area(area))")
                }
                if !route.ranTogetherWith.isEmpty {
                    LabeledContent("Con", value: route.ranTogetherWith.joined(separator: ", "))
                }
            }

            if editable {
                Section {
                    Button("Cambiar nombre") { isRenaming = true }
                    Button("Borrar actividad", role: .destructive) { confirmDelete = true }
                } footer: {
                    Text("Al borrarla se recalcula tu territorio sin esta carrera.")
                }
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
