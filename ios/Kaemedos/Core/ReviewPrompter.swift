import Foundation

/// When to ask for an App Store rating: right after a good moment, never too often.
/// iOS itself shows the prompt at most 3 times a year (and never in TestFlight builds).
enum ReviewPrompter {
    private static let countKey = "review.goodRunCount"
    private static let askedAtKey = "review.lastAskedAt"
    private static let askedVersionKey = "review.lastAskedVersion"
    private static let minRuns = 3
    private static let minDaysBetween: TimeInterval = 120 * 24 * 3600
    /// "A good result": this much new area (m²), a steal, or an epic/legendary chest
    private static let goodArea: Double = 50_000

    private static var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    }

    /// Call when the user closes a run result. True when this is the moment to ask (and records it).
    static func shouldAsk(after result: ConquestResult?) -> Bool {
        guard let result else { return false }
        if result.validation?.isRejected == true || result.validation?.isFlagged == true { return false }
        let defaults = UserDefaults.standard
        let runs = defaults.integer(forKey: countKey) + 1
        defaults.set(runs, forKey: countKey)

        let bigArea = result.globalGained + result.globalBonus >= goodArea || result.newAreaConquered >= goodArea
        let stole = result.totalStolen > 0
        let greatChest = result.treasuresCollected.contains { $0.rarity == "epic" || $0.rarity == "legendary" }
        guard runs >= minRuns, bigArea || stole || greatChest else { return false }

        if defaults.string(forKey: askedVersionKey) == currentVersion { return false }
        let lastAsked = defaults.double(forKey: askedAtKey)
        if lastAsked > 0, Date().timeIntervalSince1970 - lastAsked < minDaysBetween { return false }

        defaults.set(Date().timeIntervalSince1970, forKey: askedAtKey)
        defaults.set(currentVersion, forKey: askedVersionKey)
        return true
    }
}
