import SwiftUI
import WidgetKit

/// Widget extension of KM2: the Live Activity of the run being recorded, the home-screen /
/// lock-screen summary and (iOS 18) the "Correr" control.
@main
struct RunnaLiveBundle: WidgetBundle {
    var body: some Widget {
        RunLiveActivityWidget()
        HomeSummaryWidget()
        if #available(iOS 18.0, *) {
            StartRunControl()
        }
    }
}
