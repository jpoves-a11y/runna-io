import SwiftUI
import WidgetKit

/// The lock screen's only widget: the KM2 logo in a circle. Opens the app.

/// The KM2 wordmark, traced from the app icon: the same outline as the "Correr" control's symbol.
struct KM2LogoShape: Shape {
    /// Size of the outline: 207.99 wide, 70.54 tall (letters from the baseline, y up is negative).
    private static let size = CGSize(width: 207.994, height: 70.54)
    private static let data: String =
        "M0.00 -34.78L0.00 -69.55L9.44 -69.55L18.89 -69.55L18.71 -53.35C18.55 -38.28 18.58 -37.21 19.08 -" +
        "38.09C21.05 -41.55 26.73 -49.47 33.90 -58.76L42.25 -69.55L53.47 -69.55L64.69 -69.55L63.23 -67.82" +
        "C58.07 -61.71 40.39 -39.71 40.46 -39.50C40.55 -39.20 65.15 -1.07 65.68 -0.41C65.94 -0.08 63.73 0" +
        ".00 54.83 0.00L43.65 0.00L35.59 -13.52C31.16 -20.95 27.44 -27.00 27.32 -26.95C27.21 -26.90 25.24" +
        " -24.73 22.95 -22.13L18.79 -17.39L18.79 -8.70L18.79 0.00L9.39 0.00L0.00 0.00L0.00 -34.78ZM67.90 " +
        "-34.78L67.90 -69.55L82.71 -69.55C96.54 -69.55 97.54 -69.51 97.70 -68.97C103.53 -49.19 105.99 -39" +
        ".51 107.96 -28.60C108.48 -25.75 108.94 -23.46 108.99 -23.51C109.05 -23.56 109.84 -27.45 110.77 -" +
        "32.16C111.69 -36.86 112.89 -42.47 113.42 -44.61C114.17 -47.60 119.10 -65.34 120.19 -68.97C120.35" +
        " -69.51 121.36 -69.55 135.33 -69.55L150.31 -69.55L150.31 -34.78L150.31 0.00L140.70 0.00L131.10 0" +
        ".00L131.31 -23.16C131.43 -35.89 131.59 -48.02 131.68 -50.10L131.83 -53.89L131.15 -51.09C128.03 -" +
        "38.17 125.31 -28.11 121.41 -15.15L116.86 0.01L108.99 -0.08L101.13 -0.16L97.04 -13.51C92.42 -28.5" +
        "7 90.12 -36.76 87.84 -46.24C86.98 -49.83 86.25 -52.72 86.21 -52.67C86.18 -52.62 86.26 -48.79 86." +
        "39 -44.17C86.53 -39.55 86.65 -27.72 86.67 -17.88L86.69 0.00L77.30 0.00L67.90 0.00L67.90 -34.78ZM" +
        "154.60 -6.84L154.61 -13.68L168.17 -24.89C183.63 -37.65 184.79 -38.67 186.39 -40.86C187.96 -43.00" +
        " 188.58 -44.89 188.58 -47.52C188.57 -52.76 185.38 -55.78 179.81 -55.82C176.68 -55.84 174.61 -55." +
        "01 173.03 -53.11C172.00 -51.86 171.08 -49.32 171.08 -47.74L171.08 -46.81L162.18 -46.81L153.28 -4" +
        "6.81L153.28 -48.73C153.28 -51.44 154.34 -55.28 155.95 -58.38C160.36 -66.85 170.83 -71.38 183.34 " +
        "-70.24C189.78 -69.65 194.22 -68.23 198.49 -65.40C203.66 -61.95 206.55 -56.76 206.91 -50.24C207.4" +
        "4 -40.71 202.92 -34.09 186.48 -20.32C183.27 -17.63 180.72 -15.29 180.82 -15.13C180.92 -14.96 186" +
        ".91 -14.83 194.50 -14.83L207.99 -14.83L207.99 -7.42L207.99 0.00L181.29 0.00L154.59 0.00L154.60 -" +
        "6.84Z"

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width / Self.size.width, rect.height / Self.size.height)
        let width = Self.size.width * scale, height = Self.size.height * scale
        let origin = CGPoint(x: rect.minX + (rect.width - width) / 2, y: rect.minY + (rect.height - height) / 2)
        func point(_ x: Double, _ y: Double) -> CGPoint {
            CGPoint(x: origin.x + x * scale, y: origin.y + (y + Self.size.height) * scale)
        }
        var path = Path()
        let scanner = Scanner(string: Self.data)
        scanner.charactersToBeSkipped = .whitespaces
        while !scanner.isAtEnd {
            guard let command = scanner.scanCharacter() else { break }
            func number() -> Double { scanner.scanDouble() ?? 0 }
            switch command {
            case "M":
                let x = number(), y = number()
                path.move(to: point(x, y))
            case "L":
                let x = number(), y = number()
                path.addLine(to: point(x, y))
            case "C":
                let x1 = number(), y1 = number(), x2 = number(), y2 = number(), x = number(), y = number()
                path.addCurve(to: point(x, y), control1: point(x1, y1), control2: point(x2, y2))
            case "Z":
                path.closeSubpath()
            default:
                break
            }
        }
        return path
    }
}

struct LogoEntry: TimelineEntry {
    let date: Date
}

struct LogoProvider: TimelineProvider {
    func placeholder(in context: Context) -> LogoEntry { LogoEntry(date: Date()) }

    func getSnapshot(in context: Context, completion: @escaping (LogoEntry) -> Void) {
        completion(LogoEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<LogoEntry>) -> Void) {
        // Nothing changes: one entry for ever
        completion(Timeline(entries: [LogoEntry(date: Date())], policy: .never))
    }
}

struct LockScreenLogoWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KaemedosLogo", provider: LogoProvider()) { _ in
            ZStack {
                AccessoryWidgetBackground()
                KM2LogoShape()
                    .padding(.horizontal, 9)
                    .widgetAccentable()
            }
            .containerBackground(for: .widget) { Color.clear }
            .widgetURL(URL(string: "runnaio://tab/map"))
            .accessibilityLabel("KM2")
        }
        .configurationDisplayName("KM2")
        .description("El logo de KM2. Tócalo para abrir la app.")
        .supportedFamilies([.accessoryCircular])
    }
}
