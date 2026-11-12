import SwiftUI

/// Name a new activity right where it's shown (run summary, imported activity): a light card that
/// invites to give the run a name, with a few ready-made suggestions. Saves on Done, on a
/// suggestion or when the field loses focus.
struct ActivityNameEditor: View {
    /// nil while the run isn't on the server yet (the name can be changed once it is)
    let routeId: String?
    /// The name it has now (the default one)
    let currentName: String
    let startDate: Date?
    /// metres
    let distance: Double
    /// Called with the new name once saved.
    var onRenamed: (String) -> Void = { _ in }

    @State private var text = ""
    @State private var savedName: String?
    @State private var isSaving = false
    @State private var errorMessage: String?
    @FocusState private var focused: Bool

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSave: Bool { routeId != nil && !trimmed.isEmpty && trimmed != (savedName ?? currentName) }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            HStack(spacing: 6) {
                Image(systemName: savedName == nil ? "pencil.line" : "checkmark.circle.fill")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.brand)
                    .symbolEffect(.bounce, value: savedName)
                Text(savedName == nil ? "¿Cómo la llamarías?" : "Nombre guardado")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(savedName == nil ? Color.brand : Color.secondary)
                Spacer(minLength: 0)
            }

            HStack(spacing: DS.Spacing.s) {
                TextField(currentName, text: $text)
                    .font(.title3.weight(.semibold))
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit { save() }
                    .disabled(routeId == nil)
                if isSaving {
                    ProgressView()
                } else if canSave {
                    Button("Guardar") { save() }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.brand)
                        .transition(.opacity)
                }
            }
            .padding(.bottom, 2)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(focused ? Color.brand : Color.hairline)
                    .frame(height: focused ? 1.5 : 1)
            }

            if routeId == nil {
                Text("Podrás cambiarlo en cuanto se suba la carrera.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if savedName == nil {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: DS.Spacing.s) {
                        ForEach(Self.suggestions(startDate: startDate, distance: distance), id: \.self) { suggestion in
                            Button {
                                text = suggestion
                                save(suggestion)
                            } label: {
                                Text(suggestion)
                                    .font(.footnote.weight(.medium))
                                    .foregroundStyle(.primary)
                                    .padding(.horizontal, 12)
                                    .frame(height: 30)
                                    .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
                            }
                            .buttonStyle(.pressable)
                        }
                    }
                }
                .scrollClipDisabled()
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(Color.steal)
            }
        }
        .padding(DS.Spacing.l)
        .background(Color.brand.opacity(0.07), in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous)
                .strokeBorder(Color.brand.opacity(0.22), lineWidth: 1)
        )
        .animation(.snappy, value: savedName)
        .animation(.snappy, value: canSave)
        .sensoryFeedback(.success, trigger: savedName)
        .onChange(of: focused) { _, isFocused in
            if !isFocused, canSave { save() }
        }
        .onChange(of: text) { _, _ in
            errorMessage = nil
            if let savedName, trimmed != savedName { self.savedName = nil }
        }
    }

    /// Saves `name` (a tapped suggestion) or what's typed.
    private func save(_ name: String? = nil) {
        let name = (name ?? text).trimmingCharacters(in: .whitespacesAndNewlines)
        guard let routeId, !name.isEmpty, name != (savedName ?? currentName), !isSaving else { return }
        focused = false
        isSaving = true
        // Optimistic: shown at once in "Mis carreras" and the feed; undone if the server refuses
        let previous: String? = MyRoutesModel.shared.routes.first(where: { $0.id == routeId })?.name
        MyRoutesModel.shared.applyRename(routeId: routeId, name: name)
        Task {
            do {
                try await APIClient.shared.send("PATCH", "/api/routes/\(routeId)/name", body: ["name": name])
                savedName = name
                onRenamed(name)
            } catch {
                if let previous {
                    MyRoutesModel.shared.applyRename(routeId: routeId, name: previous)
                }
                errorMessage = "No se ha podido guardar el nombre. \(error.localizedDescription)"
            }
            isSaving = false
        }
    }

    /// A few names to pick with one tap: by time of day, distance and weekday.
    static func suggestions(startDate: Date?, distance: Double) -> [String] {
        var names: [String] = []
        let km = distance / 1000
        if let startDate {
            let hour = Calendar.current.component(.hour, from: startDate)
            switch hour {
            case 5..<12: names.append("Carrera matutina")
            case 12..<15: names.append("Carrera de mediodía")
            case 15..<21: names.append("Carrera de tarde")
            default: names.append("Carrera nocturna")
            }
        }
        if km >= 41.5 && km <= 43.5 {
            names.append("Maratón")
        } else if km >= 20.8 && km <= 21.8 {
            names.append("Media maratón")
        } else if km >= 15 {
            names.append("Tirada larga")
        } else if km >= 9.8 && km <= 10.4 {
            names.append("10K")
        } else if km < 5 {
            names.append("Rodaje corto")
        } else {
            names.append("Rodaje suave")
        }
        if let startDate {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "es_ES")
            formatter.dateFormat = "EEEE"
            names.append("Carrera del \(formatter.string(from: startDate))")
        }
        names.append("Conquistando el barrio")
        return names
    }
}
