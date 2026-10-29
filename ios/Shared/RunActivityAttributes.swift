import ActivityKit
import Foundation

/// Live Activity of a run being recorded (lock screen and Dynamic Island).
/// Compiled into both the app (which starts/updates/ends it) and the RunnaLive widget extension (which draws it):
/// the `ios/Shared` folder is a synchronized group that belongs to both targets.
struct RunActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// Start of the clock with the paused time removed: while running, elapsed time = now - timerStart,
        /// so the lock screen timer counts by itself without updates.
        var timerStart: Date
        var isPaused: Bool
        /// Moving time when the state was sent (shown as is while paused or finished).
        var pausedElapsed: TimeInterval
        var distanceMeters: Double
        /// Average pace; nil until there's enough distance to compute it.
        var paceSecondsPerKm: Double?
        /// Short extra line, e.g. "2 tesoros".
        var conqueredHint: String?
        /// The run has ended (final state shown for a few minutes).
        var isFinished: Bool = false
        /// Whose territory the runner is in ("En territorio de Ana"), nil outside any.
        var zoneText: String? = nil
        /// The zone belongs to another runner (shown in their colour as a warning).
        var zoneIsRival: Bool = false
        /// Territory colour of the zone's owner ("#RRGGBB").
        var zoneColorHex: String? = nil
    }

    /// When the run started.
    var startedAt: Date
    /// Territory colour of the runner ("#RRGGBB"), if known.
    var userColorHex: String?
}

extension RunActivityAttributes.ContentState {
    /// "5,23" (km with 2 decimals, Spanish style).
    var distanceKmText: String {
        String(format: "%.2f", max(0, distanceMeters) / 1000).replacingOccurrences(of: ".", with: ",")
    }

    /// "5:12" per km, or "–:––" when unknown.
    var paceText: String {
        guard let pace = paceSecondsPerKm, pace.isFinite, pace > 0, pace < 60 * 60 else { return "–:––" }
        let total = Int(pace.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    /// Static moving time ("12:34" or "1:02:03").
    var elapsedText: String {
        let total = max(0, Int(pausedElapsed))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let seconds = total % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, seconds)
            : String(format: "%d:%02d", minutes, seconds)
    }

    /// Range for `Text(timerInterval:countsDown: false)`, counting up from `timerStart`.
    var timerRange: ClosedRange<Date> {
        timerStart...timerStart.addingTimeInterval(60 * 60 * 24)
    }
}
