import SwiftUI
import WidgetKit

/// Widget extension of Runna.io: only the Live Activity of the run being recorded.
@main
struct RunnaLiveBundle: WidgetBundle {
    var body: some Widget {
        RunLiveActivityWidget()
    }
}
