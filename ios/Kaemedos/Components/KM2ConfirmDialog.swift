import SwiftUI

/// A yes/no question in the middle of the screen, with the KM2 logo: "¿Cerrar sesión?" Sí / No.
/// "No" is the prominent button (the safe answer); "Sí" is the quiet one, in coral when it destroys
/// something. Replaces `confirmationDialog`, which iOS 26 shows as a bubble near the top of a list.
///
///     .km2Confirm("¿Cerrar sesión?", isPresented: $confirmLogout) { Task { await session.logout() } }
///     .km2Confirm(item: $toDelete, title: { "¿Eliminar \($0.name)?" }, message: { _ in "…" }) { delete($0) }
///
/// It is a full-screen cover with a clear background, so it works from any view (a list row too),
/// and it covers the tab bar and the navigation bar.
extension View {
    func km2Confirm(
        _ title: String,
        isPresented: Binding<Bool>,
        message: String? = nil,
        destructive: Bool = true,
        onConfirm: @escaping () -> Void
    ) -> some View {
        modifier(KM2ConfirmModifier(isPresented: isPresented, title: title, message: message, destructive: destructive, onConfirm: onConfirm))
    }

    /// The same, for a question about an item (shown while `item` is not nil).
    func km2Confirm<Item>(
        item: Binding<Item?>,
        title: @escaping (Item) -> String,
        message: @escaping (Item) -> String? = { _ in nil },
        destructive: Bool = true,
        onConfirm: @escaping (Item) -> Void
    ) -> some View {
        let current = item.wrappedValue
        return modifier(KM2ConfirmModifier(
            isPresented: Binding(get: { item.wrappedValue != nil }, set: { if !$0 { item.wrappedValue = nil } }),
            title: current.map(title) ?? "",
            message: current.flatMap(message),
            destructive: destructive,
            onConfirm: { if let current { onConfirm(current) } }
        ))
    }
}

private struct KM2ConfirmModifier: ViewModifier {
    @Binding var isPresented: Bool
    let title: String
    let message: String?
    let destructive: Bool
    let onConfirm: () -> Void

    /// The cover itself; it appears and goes away without the slide-up animation (the dialog fades
    /// in and out on its own).
    @State private var coverShown = false

    func body(content: Content) -> some View {
        content
            .onChange(of: isPresented, initial: true) { _, presented in
                guard presented != coverShown else { return }
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) { coverShown = presented }
            }
            .fullScreenCover(isPresented: $coverShown) {
                KM2ConfirmDialog(title: title, message: message, destructive: destructive) { confirmed in
                    var transaction = Transaction()
                    transaction.disablesAnimations = true
                    withTransaction(transaction) {
                        coverShown = false
                        isPresented = false
                    }
                    if confirmed { onConfirm() }
                }
                .presentationBackground(.clear)
            }
    }
}

struct KM2ConfirmDialog: View {
    let title: String
    var message: String? = nil
    var destructive = true
    /// Called with the answer once the dialog has faded out.
    let onAnswer: (Bool) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false
    @State private var answered = false

    var body: some View {
        ZStack {
            Color.black.opacity(shown ? 0.4 : 0)
                .ignoresSafeArea()
                .onTapGesture { answer(false) }
                .accessibilityHidden(true)

            VStack(spacing: DS.Spacing.l) {
                KM2Logo(size: 34)
                    .padding(.top, DS.Spacing.xs)

                VStack(spacing: DS.Spacing.s) {
                    Text(title)
                        .font(.title3.weight(.semibold))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    if let message, !message.isEmpty {
                        Text(message)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                VStack(spacing: DS.Spacing.s) {
                    // The safe answer is the prominent one
                    Button { answer(false) } label: { Text("No") }
                        .buttonStyle(PrimaryButtonStyle())
                        .keyboardShortcut(.cancelAction)

                    Button { answer(true) } label: {
                        Text("Sí")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(destructive ? Color.steal : Color.primary)
                            .frame(maxWidth: .infinity, minHeight: DS.Size.button)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.pressable)
                }
                .padding(.top, DS.Spacing.xs)
            }
            .padding(DS.Spacing.xxl)
            .frame(maxWidth: 340)
            .background(Color.surface, in: RoundedRectangle(cornerRadius: DS.Radius.card + 6, style: .continuous))
            .hairlineBorder(radius: DS.Radius.card + 6)
            .shadow(color: .black.opacity(0.18), radius: 24, y: 8)
            .padding(.horizontal, DS.Spacing.xxl)
            .scaleEffect(shown || reduceMotion ? 1 : 0.92)
            .opacity(shown ? 1 : 0)
            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(.isModal)
        }
        .onAppear {
            withAnimation(.spring(duration: 0.28, bounce: 0.18)) { shown = true }
        }
        .sensoryFeedback(.warning, trigger: shown) { _, new in new && destructive }
    }

    private func answer(_ confirmed: Bool) {
        guard !answered else { return }
        answered = true
        withAnimation(.easeOut(duration: 0.16)) { shown = false }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.17) { onAnswer(confirmed) }
    }
}

#Preview {
    KM2ConfirmDialog(title: "¿Cerrar sesión?") { _ in }
}
