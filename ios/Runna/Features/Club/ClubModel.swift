import Foundation
import Observation
import SwiftUI

/// My club (or the invitations and requests while I have none), and every club action.
/// Shared by the Club tab; reset on logout.
@MainActor
@Observable
final class ClubModel {
    static let shared = ClubModel()

    private(set) var detail: ClubDetailResponse?
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    private(set) var errorMessage: String?
    var reloadTracker = ReloadSignalTracker()

    private let mineResource = CachedResource<ClubDetailResponse>("/api/clubs/mine")

    private init() {}

    var club: ClubSummary? { detail?.club }
    var isMember: Bool { detail?.club != nil }
    var isAdmin: Bool { detail?.isAdmin ?? false }
    var isOwner: Bool { detail?.isOwner ?? false }
    var invites: [ClubInvite] { detail?.invites ?? [] }
    var myRequests: [ClubOwnRequest] { detail?.myRequests ?? [] }
    var pendingCount: Int { (detail?.pendingRequests.count ?? 0) + (isMember ? 0 : invites.count) }

    func reset() {
        detail = nil
        isLoading = false
        hasLoaded = false
        errorMessage = nil
        reloadTracker = ReloadSignalTracker()
        mineResource.forget()
    }

    func load(force: Bool = false) async {
        if let cached = await mineResource.loadCached() {
            detail = cached
            hasLoaded = true
        }
        if !force && hasLoaded && mineResource.isFresh { return }
        isLoading = detail == nil
        defer {
            isLoading = false
            hasLoaded = true
        }
        do {
            if let value = try await mineResource.fetch() {
                withAnimation(.snappy) { detail = value }
            }
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = detail == nil ? error.localizedDescription : nil
        }
    }

    /// After a change: my club and the season (competition, challenges) are refetched.
    private func refreshAll() async {
        await load(force: true)
        await SeasonStore.shared.load(force: true)
    }

    // MARK: - Joining

    func search(_ query: String) async throws -> [ClubSummary] {
        let response: ClubSearchResponse = try await APIClient.shared.request("GET", "/api/clubs/search", query: ["q": query])
        return response.clubs
    }

    func create(name: String, slogan: String, crest: Crest, visibility: String) async throws -> ClubJoinResponse {
        let body: [String: Any] = [
            "name": name,
            "slogan": slogan,
            "crest": crest.json,
            "color": crest.primary,
            "visibility": visibility,
        ]
        let response: ClubJoinResponse = try await APIClient.shared.request("POST", "/api/clubs", body: body)
        await refreshAll()
        return response
    }

    /// Public club: joins at once. Private club: sends a request to its admins.
    func join(_ clubId: String) async throws -> ClubJoinResponse {
        let response: ClubJoinResponse = try await APIClient.shared.request("POST", "/api/clubs/\(clubId)/join", body: [:])
        await refreshAll()
        return response
    }

    func join(code: String) async throws -> ClubJoinResponse {
        let response: ClubJoinResponse = try await APIClient.shared.request("POST", "/api/clubs/join-code", body: ["code": code])
        await refreshAll()
        return response
    }

    func preview(inviteToken token: String) async throws -> ClubSummary {
        let response: ClubPreviewResponse = try await APIClient.shared.request("GET", "/api/clubs/invite-links/\(token)")
        return response.club
    }

    func accept(inviteToken token: String) async throws -> ClubJoinResponse {
        let response: ClubJoinResponse = try await APIClient.shared.request("POST", "/api/clubs/invite-links/\(token)/accept", body: [:])
        await refreshAll()
        return response
    }

    func respond(toInvite invite: ClubInvite, accept: Bool) async throws {
        try await APIClient.shared.send("POST", "/api/clubs/invites/\(invite.id)/\(accept ? "accept" : "decline")", body: [:])
        await refreshAll()
    }

    // MARK: - Managing

    func respond(toRequest request: ClubJoinRequest, accept: Bool) async throws {
        guard let clubId = club?.id else { return }
        try await APIClient.shared.send("POST", "/api/clubs/\(clubId)/requests/\(request.id)/\(accept ? "accept" : "reject")", body: [:])
        await load(force: true)
    }

    func invite(userId: String) async throws {
        guard let clubId = club?.id else { return }
        try await APIClient.shared.send("POST", "/api/clubs/\(clubId)/invites", body: ["userId": userId])
    }

    func inviteLink() async throws -> ClubInviteLinkResponse {
        guard let clubId = club?.id else { throw APIError(status: 0, message: "No estás en ningún club.") }
        return try await APIClient.shared.request("POST", "/api/clubs/\(clubId)/invites", body: [:])
    }

    func update(name: String?, slogan: String?, crest: Crest?, visibility: String?) async throws {
        guard let clubId = club?.id else { return }
        var body: [String: Any] = [:]
        if let name { body["name"] = name }
        if let slogan { body["slogan"] = slogan }
        if let crest {
            body["crest"] = crest.json
            body["color"] = crest.primary
        }
        if let visibility { body["visibility"] = visibility }
        try await APIClient.shared.send("PATCH", "/api/clubs/\(clubId)", body: body)
        await refreshAll()
    }

    func regenerateCode() async throws {
        guard let clubId = club?.id else { return }
        try await APIClient.shared.send("POST", "/api/clubs/\(clubId)/code", body: [:])
        await load(force: true)
    }

    func setRole(_ role: String, for member: ClubMember) async throws {
        guard let clubId = club?.id else { return }
        try await APIClient.shared.send("POST", "/api/clubs/\(clubId)/members/\(member.user.id)/role", body: ["role": role])
        await load(force: true)
    }

    func transferOwnership(to member: ClubMember) async throws {
        guard let clubId = club?.id else { return }
        try await APIClient.shared.send("POST", "/api/clubs/\(clubId)/transfer", body: ["userId": member.user.id])
        await load(force: true)
    }

    func remove(_ member: ClubMember) async throws {
        guard let clubId = club?.id else { return }
        try await APIClient.shared.send("DELETE", "/api/clubs/\(clubId)/members/\(member.user.id)")
        await load(force: true)
    }

    func leave() async throws {
        guard let clubId = club?.id else { return }
        try await APIClient.shared.send("POST", "/api/clubs/\(clubId)/leave", body: [:])
        await refreshAll()
    }

    func deleteClub() async throws {
        guard let clubId = club?.id else { return }
        try await APIClient.shared.send("DELETE", "/api/clubs/\(clubId)")
        await refreshAll()
    }
}
