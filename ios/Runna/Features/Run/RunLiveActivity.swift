import ActivityKit
import Foundation

/// Lock screen / Dynamic Island tracker of the run being recorded (drawn by the RunnaLive widget extension).
/// Driven by `RunTracker`: started with the run, updated on pause/resume and every few seconds while moving,
/// ended when the run is finished or discarded.
@MainActor
final class RunLiveActivity {
    typealias State = RunActivityAttributes.ContentState

    /// Minimum time between two distance updates.
    private let minUpdateInterval: TimeInterval = 10
    /// Minimum distance change for a distance update.
    private let minUpdateDistance: Double = 20
    /// Even without changes, refresh this often (keeps the stale date ahead and the pace current).
    private let refreshInterval: TimeInterval = 60
    /// Shown as outdated if the app stops updating it for this long (e.g. it was killed).
    private let staleAfter: TimeInterval = 10 * 60
    /// The final state stays on the lock screen this long after finishing.
    private let finishedDismissDelay: TimeInterval = 4 * 60

    private var activity: Activity<RunActivityAttributes>?
    private var lastSent: State?
    private var lastSentAt: Date?
    /// Requests run one after another so an end never overtakes an earlier update.
    private var queue: Task<Void, Never>?

    /// Ends Live Activities left over by a previous launch (the app was killed during a run).
    /// Call it at launch, when no run is being recorded.
    static func endStaleActivities() {
        let stale = Activity<RunActivityAttributes>.activities
        guard !stale.isEmpty else { return }
        Task {
            for activity in stale {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    var isActive: Bool { activity != nil }

    /// Starts the Live Activity (the app must be in the foreground: runs are started from a button).
    func start(startedAt: Date, state: State, userColorHex: String? = nil) {
        // Any activity still showing (e.g. from a previous run) is replaced
        let previous = Activity<RunActivityAttributes>.activities
        if !previous.isEmpty || activity != nil {
            activity = nil
            enqueue {
                for old in previous {
                    await old.end(nil, dismissalPolicy: .immediate)
                }
            }
        }
        lastSent = nil
        lastSentAt = nil
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        do {
            activity = try Activity.request(
                attributes: RunActivityAttributes(startedAt: startedAt, userColorHex: userColorHex),
                content: content(state),
                pushType: nil
            )
            lastSent = state
            lastSentAt = Date()
        } catch {
            #if DEBUG
            print("Could not start the Live Activity:", error)
            #endif
        }
    }

    /// Sends the new state now (pause, resume, treasure collected...).
    func update(_ state: State) {
        guard let activity else { return }
        lastSent = state
        lastSentAt = Date()
        let content = content(state)
        enqueue {
            await activity.update(content)
        }
    }

    /// Sends the new state and lights up the lock screen / expands the Dynamic Island with a short alert
    /// (entering another runner's territory). In the foreground iOS doesn't show the alert.
    func alert(_ state: State, title: String, body: String) {
        guard let activity else { return }
        lastSent = state
        lastSentAt = Date()
        let content = content(state)
        let alert = AlertConfiguration(
            title: LocalizedStringResource(stringLiteral: title),
            body: LocalizedStringResource(stringLiteral: body),
            sound: .default
        )
        enqueue {
            await activity.update(content, alertConfiguration: alert)
        }
    }

    /// Sends the new state only if the distance changed enough or it's been a while (called on every GPS fix).
    func updateIfNeeded(_ state: State) {
        guard activity != nil else { return }
        guard let lastSent, let lastSentAt else {
            update(state)
            return
        }
        let sinceLast = Date().timeIntervalSince(lastSentAt)
        let moved = abs(state.distanceMeters - lastSent.distanceMeters)
        let changedFlags = state.isPaused != lastSent.isPaused
            || state.conqueredHint != lastSent.conqueredHint
            || state.zoneText != lastSent.zoneText
        if changedFlags
            || (moved >= minUpdateDistance && sinceLast >= minUpdateInterval)
            || sinceLast >= refreshInterval {
            update(state)
        }
    }

    /// Ends the Live Activity: with the final numbers for a few minutes after finishing, or right away when discarded.
    func end(finalState: State?, discarded: Bool) {
        guard let activity else { return }
        self.activity = nil
        lastSent = nil
        lastSentAt = nil
        let finalContent = finalState.map { ActivityContent(state: $0, staleDate: nil, relevanceScore: 100) }
        let policy: ActivityUIDismissalPolicy = discarded
            ? .immediate
            : .after(Date().addingTimeInterval(finishedDismissDelay))
        enqueue {
            await activity.end(finalContent, dismissalPolicy: policy)
        }
    }

    private func content(_ state: State) -> ActivityContent<State> {
        ActivityContent(state: state, staleDate: Date().addingTimeInterval(staleAfter), relevanceScore: 100)
    }

    private func enqueue(_ operation: @escaping @Sendable () async -> Void) {
        let previous = queue
        queue = Task {
            await previous?.value
            await operation()
        }
    }
}
