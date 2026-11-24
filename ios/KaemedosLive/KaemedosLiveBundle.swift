import SwiftUI
import WidgetKit

/// Widget extension of KM2: the Live Activity of the run being recorded, the home-screen widgets
/// (KM2, to choose what it shows; Mapa; Podio; the summary) and (iOS 18) the "Correr" control.
@main
struct KaemedosLiveBundle: WidgetBundle {
    var body: some Widget {
        RunLiveActivityWidget()
        ConfigurableKM2Widget()
        TerritoryMapWidget()
        PodiumWidget()
        HomeSummaryWidget()
        if #available(iOS 18.0, *) {
            StartRunControl()
        }
    }
}
