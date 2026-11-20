import SwiftUI
import Observation

/// GET /api/onboarding/missions
struct WelcomeMissionsResponse: Decodable {
    struct Mission: Decodable, Identifiable, Hashable {
        let id: String
        let title: String
        let detail: String
        let done: Bool
    }

    let visible: Bool
    let daysLeft: Int
    let completed: Int
    let total: Int
    let missions: [Mission]
    let rewardItem: String?

    func isDone(_ id: String) -> Bool { missions.first { $0.id == id }?.done ?? false }
}

/// The welcome missions of the first two weeks, and whether the user still has nobody to play with.
@MainActor
@Observable
final class WelcomeMissionsModel {
    static let shared = WelcomeMissionsModel()

    private(set) var response: WelcomeMissionsResponse?
    /// A gift for finishing every mission, to celebrate once.
    var rewardJustGranted = false
    private static let collapsedKey = "welcomeMissions.collapsed"
    private static let hiddenEmptyCardKey = "emptyMapCard.hiddenUntil"
    var isCollapsed = UserDefaults.standard.bool(forKey: collapsedKey) {
        didSet { UserDefaults.standard.set(isCollapsed, forKey: Self.collapsedKey) }
    }

    private init() {}

    func load() async {
        let health = HealthImporter.shared.autoImport ? "1" : "0"
        guard let fresh = try? await APIClient.shared.request("GET", "/api/onboarding/missions", query: ["health": health], as: WelcomeMissionsResponse.self) else { return }
        response = fresh
        if fresh.rewardItem != nil {
            rewardJustGranted = true
            Analytics.track("welcome_missions_completed")
        }
    }

    func reset() {
        response = nil
        rewardJustGranted = false
    }

    /// No friends and no club: the map is empty of rivals (shown when the missions card is gone).
    var showsEmptyMapCard: Bool {
        guard let response, !response.visible else { return false }
        guard !response.isDone("first_friend"), !response.isDone("join_club") else { return false }
        let hiddenUntil = UserDefaults.standard.double(forKey: Self.hiddenEmptyCardKey)
        return Date().timeIntervalSince1970 > hiddenUntil
    }

    func hideEmptyMapCardForAWeek() {
        UserDefaults.standard.set(Date().addingTimeInterval(7 * 86_400).timeIntervalSince1970, forKey: Self.hiddenEmptyCardKey)
        response = response // redraw
    }
}

/// Card on the map: "Primeros pasos 2/5" with the missions, each one a shortcut to where it's done.
struct WelcomeMissionsCard: View {
    @Environment(AppRouter.self) private var router
    @Environment(RunTracker.self) private var tracker
    @State private var model = WelcomeMissionsModel.shared
    @State private var showsInvite = false

    var body: some View {
        Group {
            if let response = model.response, response.visible {
                missionsCard(response)
            } else if model.showsEmptyMapCard {
                emptyMapCard
            }
        }
        .task(id: router.reloadSignal) { await model.load() }
        .onChange(of: tracker.isPresented) { _, presented in
            if !presented { Task { try? await Task.sleep(nanoseconds: 6_000_000_000); await model.load() } }
        }
        .sheet(isPresented: $showsInvite) {
            InviteFriendSheet()
        }
        .alert("¡Primeros pasos completados!", isPresented: Binding(
            get: { model.rewardJustGranted && !TourController.shared.isActive },
            set: { model.rewardJustGranted = $0 }
        )) {
            Button("Ver mis poderes") { router.showPowers = true }
            Button("Genial", role: .cancel) {}
        } message: {
            Text("Te hemos regalado un poder raro. Úsalo en tu próxima competición.")
        }
    }

    private func missionsCard(_ response: WelcomeMissionsResponse) -> some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            Button {
                withAnimation(.snappy) { model.isCollapsed.toggle() }
            } label: {
                HStack(spacing: DS.Spacing.s) {
                    MissionsProgressRing(progress: Double(response.completed) / Double(max(response.total, 1)))
                        .frame(width: 22, height: 22)
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Primeros pasos · \(response.completed)/\(response.total)")
                            .font(.subheadline.weight(.semibold))
                        if model.isCollapsed, let next = response.missions.first(where: { !$0.done }) {
                            Text(next.title)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: model.isCollapsed ? "chevron.up" : "chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if !model.isCollapsed {
                ForEach(response.missions) { mission in
                    Button {
                        open(mission)
                    } label: {
                        HStack(alignment: .top, spacing: DS.Spacing.s) {
                            Image(systemName: mission.done ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(mission.done ? Color.brand : Color.secondary)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(mission.title)
                                    .font(.subheadline.weight(.medium))
                                    .strikethrough(mission.done)
                                    .foregroundStyle(mission.done ? .secondary : .primary)
                                if !mission.done {
                                    Text(mission.detail)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            Spacer(minLength: 0)
                            if !mission.done {
                                Image(systemName: "chevron.right")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(mission.done)
                }
                Text("Complétalas todas y te regalamos un poder raro.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(DS.Spacing.m)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
    }

    private var emptyMapCard: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Tu mapa está muy tranquilo")
                        .font(.subheadline.weight(.semibold))
                    Text("Con amigos o un club tendrás territorio que robar y quien te lo robe.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Button {
                    withAnimation(.snappy) { model.hideEmptyMapCardForAWeek() }
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                }
                .accessibilityLabel("Ocultar")
            }
            HStack(spacing: DS.Spacing.s) {
                Button("Invitar amigos") { showsInvite = true }
                    .buttonStyle(SecondaryButtonStyle(tint: Color.brand))
                Button("Buscar club") {
                    router.clubSection = .club
                    router.selectedTab = .club
                }
                .buttonStyle(SecondaryButtonStyle(tint: Color.primary))
            }
        }
        .padding(DS.Spacing.m)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
    }

    private func open(_ mission: WelcomeMissionsResponse.Mission) {
        Analytics.track("welcome_mission_tap", ["mission": mission.id])
        switch mission.id {
        case "first_run", "first_territory":
            tracker.isPresented = true
        case "first_friend":
            showsInvite = true
        case "join_club":
            router.clubSection = .club
            router.selectedTab = .club
        case "connect_device":
            router.showProfile = true
        default:
            break
        }
    }
}

private struct MissionsProgressRing: View {
    let progress: Double

    var body: some View {
        ZStack {
            Circle().stroke(Color.secondary.opacity(0.25), lineWidth: 3)
            Circle()
                .trim(from: 0, to: progress)
                .stroke(Color.brand, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
    }
}

/// "Invita a alguien": creates an invite link (POST /api/friends/invite) and shares it. The link opens
/// the app directly when the friend has it (universal link), or the download page otherwise.
struct InviteFriendSheet: View {
    var title = "Invita a un amigo"
    var message = "Cuando acepte, veréis el territorio del otro y podréis robároslo."

    @Environment(\.dismiss) private var dismiss
    @State private var inviteURL: URL?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: DS.Spacing.xl) {
                Image(systemName: "person.2.wave.2.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(Color.brand)
                    .padding(.top, DS.Spacing.xl)
                VStack(spacing: DS.Spacing.s) {
                    Text(title)
                        .font(.title2.weight(.bold))
                    Text(message)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                Spacer(minLength: 0)
                if let inviteURL {
                    ShareLink(
                        item: inviteURL,
                        subject: Text("Corre conmigo en Runna.io"),
                        message: Text("Te reto en Runna.io: corre y conquista la ciudad. Acepta mi invitación:")
                    ) {
                        Label("Enviar invitación", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .simultaneousGesture(TapGesture().onEnded { Analytics.track("invite_shared") })
                } else {
                    ProgressView()
                        .frame(height: 50)
                }
            }
            .padding(DS.Spacing.screen)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Ahora no") { dismiss() }
                }
            }
            .errorAlert($errorMessage)
            .task { await createInvite() }
        }
        .presentationDetents([.medium])
    }

    private func createInvite() async {
        do {
            let invite = try await APIClient.shared.request("POST", "/api/friends/invite", body: [:], as: InviteResponse.self)
            inviteURL = URL(string: invite.url)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
