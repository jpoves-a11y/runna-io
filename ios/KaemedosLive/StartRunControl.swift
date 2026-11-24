import AppIntents
import SwiftUI
import WidgetKit

/// "Correr" in Control Center, on the lock screen and on the Action button (iOS 18).
@available(iOS 18.0, *)
struct StartRunControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.jpoves.runnaio.StartRun") {
            ControlWidgetButton(action: StartRunIntent()) {
                // The KM2 wordmark, traced from the icon (a custom symbol: controls only show symbols)
                Label("Correr", image: "km2")
            }
        }
        .displayName("Empezar a correr")
        .description("Abre KM2 y empieza a grabar una carrera.")
    }
}
