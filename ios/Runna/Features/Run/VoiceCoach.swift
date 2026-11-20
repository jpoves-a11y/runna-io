import AVFoundation
import CoreLocation
import Foundation

/// Spoken cues during a run: every kilometre, entering a territory you can steal, chests nearby,
/// pause/resume and the end. Uses the iPhone's own Spanish voice (the best one installed: "mejorada"
/// or "premium" if the user downloaded it in Ajustes → Accesibilidad → Contenido leído), offline.
/// Music keeps playing, lowered while the voice speaks. Works with the screen locked (the "audio"
/// background mode, while the run keeps the app alive with location updates).
@MainActor
final class VoiceCoach {
    /// UserDefaults key of the setting in Perfil → Durante la carrera (on by default).
    static let enabledKey = "voiceCues"

    static var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    /// Silenced for the current run only (speaker button on the run screen).
    var isMutedForRun = false

    private let synthesizer = AVSpeechSynthesizer()
    private let delegate = SpeechDelegate()
    private lazy var voice: AVSpeechSynthesisVoice? = Self.bestSpanishVoice()

    init() {
        synthesizer.delegate = delegate
        delegate.onFinish = { [weak self] in
            MainActor.assumeIsolated { self?.releaseAudioIfIdle() }
        }
    }

    /// Speaks `text` after whatever is being said (never cuts a sentence in half).
    func say(_ text: String, force: Bool = false) {
        guard force || (Self.isEnabled && !isMutedForRun) else { return }
        activateAudio()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.prefersAssistiveTechnologySettings = true
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        releaseAudioIfIdle()
    }

    /// "Probar voz" in the profile.
    func sample() {
        say("Kilómetro 1. 5 minutos 30. Ritmo medio, 5 minutos 30 por kilómetro.", force: true)
    }

    // MARK: - Audio session

    private func activateAudio() {
        let session = AVAudioSession.sharedInstance()
        // Lowers the music while speaking and pauses spoken audio (podcasts) instead of talking over it
        try? session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers])
        try? session.setActive(true)
    }

    private func releaseAudioIfIdle() {
        guard !synthesizer.isSpeaking else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private static func bestSpanishVoice() -> AVSpeechSynthesisVoice? {
        let spanish = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("es") }
        let preferred = spanish.filter { $0.language == "es-ES" }
        let pool = preferred.isEmpty ? spanish : preferred
        let best = pool.max { lhs, rhs in lhs.quality.rawValue < rhs.quality.rawValue }
        return best ?? AVSpeechSynthesisVoice(language: "es-ES")
    }

    // MARK: - Phrases

    /// "Kilómetro 3. 15 minutos 40. Ritmo medio, 5 minutos 13 por kilómetro."
    static func kilometrePhrase(km: Int, movingSeconds: TimeInterval) -> String {
        let pace = movingSeconds / Double(max(km, 1))
        return "Kilómetro \(km). \(spokenDuration(movingSeconds)). Ritmo medio, \(spokenPace(pace)) por kilómetro."
    }

    static func finishPhrase(meters: Double, movingSeconds: TimeInterval) -> String {
        "Carrera terminada. \(spokenDistance(meters)) en \(spokenDuration(movingSeconds))."
    }

    static func territoryPhrase(ownerName: String) -> String {
        let name = ownerName.trimmingCharacters(in: .whitespaces)
        let owner = name.isEmpty ? "un rival" : name
        return "Entras en territorio de \(owner). Cierra el recorrido para robárselo."
    }

    static func chestPhrase(rarity: String, meters: Double) -> String {
        let rounded = Int((meters / 50).rounded() * 50)
        return "Cofre \(rarityName(rarity)) a \(rounded) metros."
    }

    static func chestInRangePhrase(rarity: String) -> String {
        "Estás en el radio del cofre \(rarityName(rarity)). Se abre al terminar la carrera."
    }

    static func rarityName(_ rarity: String) -> String {
        switch rarity {
        case "rare": return "raro"
        case "epic": return "épico"
        case "legendary": return "legendario"
        default: return "común"
        }
    }

    /// "15 minutos 40", "1 hora 5 minutos", "45 segundos".
    static func spokenDuration(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded())
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        if hours > 0 {
            return "\(hours) \(hours == 1 ? "hora" : "horas") \(minutes) \(minutes == 1 ? "minuto" : "minutos")"
        }
        if minutes == 0 { return "\(secs) segundos" }
        let minuteWord = minutes == 1 ? "minuto" : "minutos"
        return secs == 0 ? "\(minutes) \(minuteWord)" : "\(minutes) \(minuteWord) \(secs)"
    }

    /// "5 minutos 13" for a pace in seconds per kilometre.
    static func spokenPace(_ secondsPerKm: Double) -> String {
        guard secondsPerKm.isFinite, secondsPerKm > 0 else { return "sin datos" }
        let total = Int(secondsPerKm.rounded())
        let minutes = total / 60
        let secs = total % 60
        let minuteWord = minutes == 1 ? "minuto" : "minutos"
        return secs == 0 ? "\(minutes) \(minuteWord)" : "\(minutes) \(minuteWord) \(secs)"
    }

    /// "5,2 kilómetros", "800 metros".
    static func spokenDistance(_ meters: Double) -> String {
        if meters < 1000 { return "\(Int((meters / 10).rounded() * 10)) metros" }
        let km = (meters / 100).rounded() / 10
        let text = km == km.rounded() ? String(Int(km)) : String(format: "%.1f", km).replacingOccurrences(of: ".", with: ",")
        return "\(text) kilómetros"
    }
}

private final class SpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
    var onFinish: (() -> Void)?

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.onFinish?() }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.onFinish?() }
    }
}

/// Where the runner is relative to territories and chests, so each cue is said once.
struct RunCueState {
    var announcedKilometres = 0
    var enteredShapeIds: Set<String> = []
    var lastTerritoryCueAt: Date?
    var chestsAnnouncedFar: Set<String> = []
    var chestsAnnouncedNear: Set<String> = []

    /// Distance at which a chest is first announced, and the server's pickup radius (CHEST_RADIUS_M).
    static let chestAnnounceMeters: CLLocationDistance = 500
    static let chestRadiusMeters: CLLocationDistance = 250
    /// At most one territory cue per minute (crossing a patchwork of zones).
    static let territoryCueInterval: TimeInterval = 60
}

enum Geo {
    /// Ray casting on lat/lng: true when the point is inside the outer ring and not in a hole.
    static func contains(_ rings: [[CLLocationCoordinate2D]], _ point: CLLocationCoordinate2D) -> Bool {
        guard let outer = rings.first, inside(outer, point) else { return false }
        for hole in rings.dropFirst() where inside(hole, point) { return false }
        return true
    }

    private static func inside(_ ring: [CLLocationCoordinate2D], _ point: CLLocationCoordinate2D) -> Bool {
        guard ring.count >= 3 else { return false }
        var result = false
        var j = ring.count - 1
        for i in 0..<ring.count {
            let a = ring[i], b = ring[j]
            if (a.latitude > point.latitude) != (b.latitude > point.latitude) {
                let x = (b.longitude - a.longitude) * (point.latitude - a.latitude) / (b.latitude - a.latitude) + a.longitude
                if point.longitude < x { result.toggle() }
            }
            j = i
        }
        return result
    }
}
