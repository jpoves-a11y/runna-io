import SwiftUI
import AVFoundation
import UIKit

/// Perfil → Durante la carrera → Voz: the Spanish voices installed on the iPhone, best first, with a
/// sample of each, and how to download a more natural one ("Mejorada" / "Premium") in Ajustes.
struct VoicePickerView: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var voices: [AVSpeechSynthesisVoice] = VoiceCoach.spanishVoices()
    @State private var selectedId: String? = UserDefaults.standard.string(forKey: VoiceCoach.voiceIdentifierKey)
    @State private var coach = VoiceCoach()

    /// The voice used now: the chosen one, or the best installed.
    private var currentId: String? { selectedId ?? VoiceCoach.bestSpanishVoice()?.identifier }
    private var hasNaturalVoice: Bool { voices.contains { $0.quality != .default } }

    var body: some View {
        List {
            if !hasNaturalVoice {
                Section {
                    downloadHelp
                } header: {
                    SocialSectionHeader(title: "Consigue una voz más natural")
                }
                .listRowBackground(Color.surface)
            }

            Section {
                ForEach(voices, id: \.identifier) { voice in
                    Button {
                        select(voice)
                    } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(voice.name)
                                    .font(.body)
                                    .foregroundStyle(.primary)
                                Text("\(Self.region(of: voice)) · \(Self.qualityName(voice.quality))")
                                    .font(.caption)
                                    .foregroundStyle(voice.quality == .default ? Color.secondary : Color.brand)
                            }
                            Spacer()
                            if voice.identifier == currentId {
                                Image(systemName: "checkmark")
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(Color.brand)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(voice.identifier == currentId ? .isSelected : [])
                }
            } header: {
                SocialSectionHeader(title: "Voces en español de tu iPhone")
            } footer: {
                Text("Toca una voz para oírla y usarla en los avisos de tus carreras.")
            }
            .listRowBackground(Color.surface)

            if hasNaturalVoice {
                Section {
                    downloadHelp
                } header: {
                    SocialSectionHeader(title: "Más voces")
                }
                .listRowBackground(Color.surface)
            }
        }
        .listStyle(.insetGrouped)
        .listBackground()
        .navigationTitle("Voz")
        .navigationBarTitleDisplayMode(.inline)
        // Back from Ajustes with a new voice downloaded: show it
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { voices = VoiceCoach.spanishVoices() }
        }
        .onReceive(NotificationCenter.default.publisher(for: AVSpeechSynthesizer.availableVoicesDidChangeNotification)) { _ in
            voices = VoiceCoach.spanishVoices()
        }
    }

    private var downloadHelp: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Text("Las voces «Mejorada» y «Premium» suenan mucho más naturales. Son gratis y se descargan una vez:")
                .font(.subheadline)
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(Self.downloadSteps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(index + 1).")
                            .font(.subheadline.weight(.semibold).monospacedDigit())
                            .foregroundStyle(Color.brand)
                        Text(step)
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            Text("Cuando vuelvas a KM2, la verás aquí para elegirla.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    /// Apple moves and renames these menus between iOS versions, and apps can't open them directly:
    /// the search field of Ajustes always finds them.
    static let downloadSteps: [String] = [
        "Abre la app Ajustes y escribe «Voces» en el buscador de arriba. Entra en el resultado de Contenido leído.",
        "Elige Español y toca una voz (por ejemplo, Mónica o Jorge).",
        "Descarga la versión «Mejorada» o «Premium» con el botón de la nube (mejor con wifi).",
    ]

    private func select(_ voice: AVSpeechSynthesisVoice) {
        selectedId = voice.identifier
        UserDefaults.standard.set(voice.identifier, forKey: VoiceCoach.voiceIdentifierKey)
        Analytics.track("voice_selected", ["quality": Self.qualityName(voice.quality)])
        coach.sample(with: voice)
    }

    static func qualityName(_ quality: AVSpeechSynthesisVoiceQuality) -> String {
        switch quality {
        case .premium: return "Premium"
        case .enhanced: return "Mejorada"
        default: return "Estándar"
        }
    }

    static func region(of voice: AVSpeechSynthesisVoice) -> String {
        let code = voice.language.split(separator: "-").last.map(String.init) ?? ""
        return Locale(identifier: "es_ES").localizedString(forRegionCode: code) ?? voice.language
    }
}
