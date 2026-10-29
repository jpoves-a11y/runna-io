import SwiftUI
import WidgetKit

/// Widget extension of Runna.io: the Live Activity of the run being recorded and the home screen widget.
@main
struct RunnaLiveBundle: WidgetBundle {
    var body: some Widget {
        RunLiveActivityWidget()
        RunnaHomeWidget()
    }
}
