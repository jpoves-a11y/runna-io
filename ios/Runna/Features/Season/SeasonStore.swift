import Foundation
import Observation
import SwiftUI

/// The season (current cycle, my club competition, challenges, inventory summary) and my Global-mode
/// numbers, shared by the map, rankings, club and profile. Stale-while-revalidate, reset on logout.
@MainActor
@Observable
final class SeasonStore {
    static let shared = SeasonStore()

    private(set) var current: SeasonCurrent?
    private(set) var globalMe: GlobalMe?
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    private let currentResource = CachedResource<SeasonCurrent>("/api/season/current")
    private let globalResource = CachedResource<GlobalMe>("/api/global/me")

    private init() {}

    var cycle: SeasonCycle? { current?.cycle }
    var competition: ClubCompetition? { current?.competition }
    var club: ClubSummary? { current?.club }
    var challenges: [SeasonChallenge] { current?.challenges ?? [] }
    var availableItemCount: Int { current?.inventory?.available ?? 0 }
    var isCompetitionPhase: Bool { cycle?.isCompetition ?? false }
    /// Competing right now (in a club competition during the competition days).
    var isCompeting: Bool { isCompetitionPhase && competition?.isActive == true }
    var isFresh: Bool { currentResource.isFresh && globalResource.isFresh }

    func reset() {
        current = nil
        globalMe = nil
        isLoading = false
        errorMessage = nil
        currentResource.forget()
        globalResource.forget()
    }

    /// Last known values, instantly.
    func loadCached() async {
        if let value = await currentResource.loadCached() { current = value }
        if let value = await globalResource.loadCached() { globalMe = value }
    }

    /// Cached first, then both refetched in parallel (unless fresh and not forced).
    func load(force: Bool = false) async {
        await loadCached()
        if !force && current != nil && globalMe != nil && isFresh { return }
        isLoading = current == nil
        defer { isLoading = false }
        let seasonSource: CachedResource<SeasonCurrent> = currentResource
        let globalSource: CachedResource<GlobalMe> = globalResource
        async let season: Result<SeasonCurrent?, Error> = Self.fetch(seasonSource)
        async let global: Result<GlobalMe?, Error> = Self.fetch(globalSource)
        let seasonResult = await season
        let globalResult = await global
        switch seasonResult {
        case .success(let value):
            if let value { withAnimation(.snappy) { current = value } }
            errorMessage = nil
        case .failure(let error):
            if !(error is CancellationError) {
                errorMessage = current == nil ? error.localizedDescription : nil
            }
        }
        if case .success(let value) = globalResult, let value {
            withAnimation(.snappy) { globalMe = value }
        }
    }

    private static func fetch<T: Decodable>(_ resource: CachedResource<T>) async -> Result<T?, Error> {
        do {
            return .success(try await resource.fetch())
        } catch {
            return .failure(error)
        }
    }

    /// "Termina en 3 días" / "Empieza en 5 h" for the current phase.
    var phaseCountdown: String? {
        guard let cycle, let end = cycle.phaseEndsAt else { return nil }
        let seconds = end.timeIntervalSinceNow
        guard seconds > 0 else { return nil }
        let text = Self.remaining(seconds)
        if cycle.isCompetition { return "Termina en \(text)" }
        return "Competición en \(text)"
    }

    static func remaining(_ seconds: TimeInterval) -> String {
        let hours = Int(seconds / 3600)
        if hours >= 48 { return "\(hours / 24) días" }
        if hours >= 1 { return "\(hours) h" }
        return "\(max(1, Int(seconds / 60))) min"
    }
}
