import AppIntents

/// Siri and Shortcuts phrases (Spanish is the project's development language).
struct KaemedosShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartRunIntent(),
            phrases: [
                "Empieza una carrera en \(.applicationName)",
                "Empezar a correr con \(.applicationName)",
                "Salir a correr con \(.applicationName)",
                "Correr con \(.applicationName)",
                "Inicia una carrera en \(.applicationName)",
                "Empieza a correr en \(.applicationName)",
                "Empezar una carrera en \(.applicationName)",
            ],
            shortTitle: "Correr",
            systemImageName: "figure.run"
        )
    }
}
