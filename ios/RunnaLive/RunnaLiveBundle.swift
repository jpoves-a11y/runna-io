import SwiftUI
import WidgetKit

/// Widget extension of Runna.io: the Live Activity of the run being recorded and the home / lock screen widgets.
@main
struct RunnaLiveBundle: WidgetBundle {
    var body: some Widget {
        RunLiveActivityWidget()
        RunnaLeagueWidget()
        RunnaHomeWidget()
        RunnaTerritoryWidget()
        RunnaDefendWidget()
    }
}
