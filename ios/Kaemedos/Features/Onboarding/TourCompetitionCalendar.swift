import SwiftUI

/// The 14-day cycle on a two-week calendar, for the tour's competition card: Monday to Thursday are
/// rest days (chests and challenges), then the competition runs from Friday to the Sunday of the
/// following week (10 days). Same calendar as `shared/game.ts`.
struct TourCompetitionCalendar: View {
    private enum Kind { case rest, competition }

    private struct Day: Identifiable {
        let id: Int
        let kind: Kind
        let symbol: String
    }

    private static let weekdays = ["L", "M", "X", "J", "V", "S", "D"]

    /// Monday of week 1 to Sunday of week 2.
    private static let days: [Day] = (0..<14).map { index in
        if index < 4 { return Day(id: index, kind: .rest, symbol: "gift.fill") }
        if index == 4 { return Day(id: index, kind: .competition, symbol: "flag.fill") }
        if index == 13 { return Day(id: index, kind: .competition, symbol: "trophy.fill") }
        return Day(id: index, kind: .competition, symbol: "shield.lefthalf.filled")
    }

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 7)

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            LazyVGrid(columns: columns, spacing: 6) {
                ForEach(Self.weekdays, id: \.self) { day in
                    Text(day)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                ForEach(Self.days) { day in
                    cell(day)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Calendario de dos semanas: de lunes a jueves, descanso; del viernes al domingo de la semana siguiente, competición.")

            VStack(alignment: .leading, spacing: 6) {
                legend(color: Color.brand, symbol: "flag.fill",
                       text: "**10 días de competición**: tu club contra los demás. Empieza el viernes con el mapa vacío.")
                legend(color: Color.gold, symbol: "gift.fill",
                       text: "**4 días de descanso**: cofres alrededor de tu ciudad y retos.")
            }
        }
    }

    private func color(_ kind: Kind) -> Color {
        kind == .rest ? Color.gold : Color.brand
    }

    private func cell(_ day: Day) -> some View {
        let tint = color(day.kind)
        let highlighted = day.symbol != "shield.lefthalf.filled"
        return Image(systemName: day.symbol)
            .font(.system(size: highlighted ? 14 : 11, weight: .semibold))
            .foregroundStyle(highlighted ? tint : tint.opacity(0.55))
            .frame(maxWidth: .infinity)
            .frame(height: 34)
            .background(tint.opacity(highlighted ? 0.22 : 0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .strokeBorder(tint.opacity(highlighted ? 0.6 : 0), lineWidth: 1)
            )
    }

    private func legend(color: Color, symbol: String, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.s) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(color)
                .frame(width: 16)
            Text(LocalizedStringKey(text))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

#Preview {
    TourCompetitionCalendar()
        .padding()
}
