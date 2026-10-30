import AVFoundation
import Foundation

/// Run options the runner can change from the run screen (kept between runs).
enum RunSettings {
    static let voiceKey = "run_voice_enabled"
    static let autoPauseKey = "run_auto_pause"

    static var voiceEnabled: Bool { UserDefaults.standard.object(forKey: voiceKey) as? Bool ?? true }
    static var autoPauseEnabled: Bool { UserDefaults.standard.object(forKey: autoPauseKey) as? Bool ?? true }
}

/// Spoken cues during a run (km splits, entering territory, treasures, auto-pause). Music and podcasts
/// are lowered while it speaks and come back after. Works with the screen locked (background audio mode).
@MainActor
final class RunVoiceCoach: NSObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private let voice = AVSpeechSynthesisVoice(language: "es-ES")

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Speaks `text` after whatever is being said (cues are short, they don't interrupt each other).
    func speak(_ text: String) {
        guard RunSettings.voiceEnabled, !text.isEmpty else { return }
        activateSession()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 1.02
        utterance.prefersAssistiveTechnologySettings = true
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        deactivateSession()
    }

    private func activateSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers])
        try? session.setActive(true)
    }

    /// Gives the volume back to the music.
    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            if !self.synthesizer.isSpeaking { self.deactivateSession() }
        }
    }
}
