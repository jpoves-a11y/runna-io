import SwiftUI
import MapKit

// Defending territory: castles (built by running your zone again) and wear (zones not run over for
// 14 days lose ~3 % a day from the border), with rest mode to stop the clock.

// MARK: - Zones wearing away

/// GET /api/territories/weak
struct WeakZonesResponse: Decodable {
    struct Zone: Decodable {
        let userId: String
        /// Wearing away now (not run over for 14 days).
        let weak: [[[CLLocationCoordinate2D]]]
        /// Yours only: starts wearing away within two days.
        let atRisk: [[[CLLocationCoordinate2D]]]

        enum CodingKeys: String, CodingKey { case userId, weak, atRisk }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            userId = c.string(.userId) ?? ""
            weak = GeoJSON.polygons(from: c.jsonObject(.weak))
            atRisk = GeoJSON.polygons(from: c.jsonObject(.atRisk))
        }
    }

    let zones: [Zone]
    let resting: Bool

    enum CodingKeys: String, CodingKey { case zones, resting }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        zones = (try? c.decodeIfPresent([Zone].self, forKey: .zones)) ?? []
        resting = c.bool(.resting) ?? false
    }
}

/// A zone wearing away (faded, dashed border) or at risk (dotted border), in the owner's colour.
struct WeakZoneShape: Identifiable {
    let id: String
    let userId: String
    let color: Color
    let polygon: MKPolygon
    let isAtRisk: Bool

    var strokeStyle: StrokeStyle {
        StrokeStyle(lineWidth: isAtRisk ? 2 : 2.5, lineCap: .round, lineJoin: .round, dash: isAtRisk ? [1, 6] : [8, 6])
    }
}

// MARK: - Castle detail

/// What a castle zone is worth and when its castles fall.
struct CastleDetailSheet: View {
    let zone: CastleZone
    let isMine: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            HStack(spacing: DS.Spacing.m) {
                CastleMarker(zone: zone)
                VStack(alignment: .leading, spacing: 2) {
                    Text(zone.layers == 1 ? "1 castillo" : "\(zone.layers) castillos")
                        .font(.headline)
                    Text(isMine ? "Tu zona fortificada" : "Zona fortificada de \(zone.ownerName.isEmpty ? "otro corredor" : zone.ownerName)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if zone.area > 0 {
                    Text(Format.area(zone.area))
                        .font(.subheadline.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            Text(attackText)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
            if let expiryText {
                Label(expiryText, systemImage: "hourglass")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Text(isMine
                 ? "Vuelve a correr por esta zona para añadir castillos (máximo 3) y renovar los que caducan."
                 : "Pasa corriendo por la zona para derribar sus castillos.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(DS.Spacing.l)
        .presentationDetents([.height(260)])
        .presentationDragIndicator(.visible)
    }

    private var attackText: String {
        let attacks = zone.layers == 1 ? "1 ataque" : "\(zone.layers) ataques"
        return isMine
            ? "Aguanta \(attacks): cada castillo frena una carrera rival y cae. Sin castillos, la zona se puede robar."
            : "Aguanta \(attacks): necesitas \(zone.layers + 1) carreras por aquí para robarla."
    }

    private var expiryText: String? {
        guard let next = zone.nextExpiryAt else { return nil }
        let first = "El primero caduca \(Format.relative(next))"
        if let last = zone.expiresAt, zone.layers > 1, last > next {
            return "\(first); el último, \(Format.relative(last))."
        }
        return "\(first)."
    }
}

// MARK: - Rest mode

/// GET/POST/DELETE /api/user/rest
struct RestStatus: Decodable {
    let active: Bool
    let until: Date?
    let daysLeft: Int
    let maxDays: Int

    enum CodingKeys: String, CodingKey { case active, until, daysLeft, maxDays }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        active = c.bool(.active) ?? false
        until = APIDate.parse(c.string(.until))
        daysLeft = c.int(.daysLeft) ?? 0
        maxDays = c.int(.maxDays) ?? 14
    }
}

/// Profile → Modo descanso: stops the wear of your territory (holidays, an injury).
struct RestModeView: View {
    @State private var status: RestStatus?
    @State private var days = 7
    @State private var isWorking = false
    @State private var errorMessage: String?

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: DS.Spacing.s) {
                    Label("Cómo se desgasta el territorio", systemImage: "leaf")
                        .font(.subheadline.weight(.semibold))
                    Text("Las zonas por las que no corres en 14 días pierden un 3 % al día desde el borde. Te avisamos 2 días antes. Pasar corriendo por una zona (o rodearla) la defiende de nuevo.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 4)
            }
            .listRowBackground(Color.surface)

            Section {
                if let status {
                    if status.active, let until = status.until {
                        SocialSettingsLabel(title: "En descanso hasta", systemImage: "moon.zzz", value: Format.dayAndTime(until))
                        Button(role: .destructive) {
                            Task { await change { try await APIClient.shared.request("DELETE", "/api/user/rest") } }
                        } label: {
                            Text("Terminar el descanso ahora")
                        }
                        .disabled(isWorking)
                    } else if status.daysLeft > 0 {
                        Stepper(value: $days, in: 1...status.daysLeft) {
                            SocialSettingsLabel(title: days == 1 ? "1 día" : "\(days) días", systemImage: "moon.zzz")
                        }
                        Button {
                            Task { await change { try await APIClient.shared.request("POST", "/api/user/rest", body: ["days": days]) } }
                        } label: {
                            Text("Empezar el descanso")
                        }
                        .disabled(isWorking)
                    } else {
                        Text("Ya has usado los \(status.maxDays) días de descanso de este año.")
                            .foregroundStyle(.secondary)
                    }
                } else if errorMessage == nil {
                    ProgressView()
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(Color.steal)
                }
            } header: {
                SocialSectionHeader(title: "Modo descanso")
            } footer: {
                if let status {
                    Text("Mientras descansas tu territorio no se desgasta. Te quedan \(status.daysLeft) de \(status.maxDays) días este año; si terminas antes, recuperas los días completos que no uses.")
                }
            }
            .listRowBackground(Color.surface)
        }
        .scrollContentBackground(.hidden)
        .screenBackground()
        .navigationTitle("Modo descanso")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        do {
            let loaded: RestStatus = try await APIClient.shared.request("GET", "/api/user/rest")
            status = loaded
            days = min(max(1, days), max(1, loaded.daysLeft))
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func change(_ request: () async throws -> RestStatus) async {
        isWorking = true
        defer { isWorking = false }
        do {
            status = try await request()
            errorMessage = nil
            Haptics.success()
            // The map stops / starts drawing your zones wearing away
            await MapModel.shared.refreshDefenseOverlays()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
