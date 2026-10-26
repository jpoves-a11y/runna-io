import ActivityKit
import SwiftUI
import UIKit
import WidgetKit

// MARK: - Colours (same values as the app's design system)

private extension Color {
    static func liveAdaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            UIColor(liveRGB: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }

    /// Brand emerald (same as `Color.brand` in the app).
    static let liveBrand = Color.liveAdaptive(light: 0x0E8A5F, dark: 0x3CC98E)
    /// Always the dark-mode variant: the Dynamic Island is black in both modes.
    static let liveBrandBright = Color(uiColor: UIColor(liveRGB: 0x3CC98E))
    /// Lock screen background: plain white / near black.
    static let liveBackground = Color.liveAdaptive(light: 0xFFFFFF, dark: 0x111113)
    /// Hairline separators.
    static let liveHairline = Color(uiColor: .separator)
}

private extension UIColor {
    convenience init(liveRGB rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}

private extension Font {
    /// Condensed number (same recipe as the app's stat fonts).
    static func liveStat(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        Font.system(size: size, weight: weight).width(.condensed)
    }

    /// Small uppercase label.
    static let liveLabel = Font.system(.caption2, weight: .semibold)
}

// MARK: - Widget

struct RunLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RunActivityAttributes.self) { context in
            RunLockScreenView(state: context.state, isStale: context.isStale)
                .activityBackgroundTint(Color.liveBackground)
                .activitySystemActionForegroundColor(Color.primary)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text("Runna.io")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.leading, 6)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    RunStatusText(state: state)
                        .padding(.trailing, 6)
                }
                DynamicIslandExpandedRegion(.center) {
                    RunTimerText(state: state)
                        .font(Font.liveStat(40))
                        .foregroundStyle(state.isPaused && !state.isFinished ? Color.secondary : Color.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    RunMetricsRow(state: state, valueSize: 22)
                        .padding(.horizontal, 6)
                        .padding(.top, 2)
                }
            } compactLeading: {
                Image(systemName: state.isPaused ? "pause.fill" : "figure.run")
                    .foregroundStyle(state.isPaused ? Color.secondary : Color.liveBrandBright)
            } compactTrailing: {
                RunTimerText(state: state)
                    .font(Font.liveStat(15))
                    .foregroundStyle(state.isPaused ? Color.secondary : Color.white)
                    .frame(maxWidth: 56)
            } minimal: {
                Image(systemName: state.isPaused ? "pause.fill" : "figure.run")
                    .foregroundStyle(state.isPaused ? Color.secondary : Color.liveBrandBright)
            }
            .keylineTint(Color.liveBrandBright)
        }
    }
}

// MARK: - Pieces

/// Counts by itself while running; static moving time while paused or finished.
private struct RunTimerText: View {
    let state: RunActivityAttributes.ContentState

    var body: some View {
        Group {
            if state.isPaused || state.isFinished {
                Text(state.elapsedText)
            } else {
                Text(timerInterval: state.timerRange, countsDown: false)
            }
        }
        .monospacedDigit()
        .multilineTextAlignment(.center)
    }
}

/// "Pausa" / "Terminada" / "Rec" as a small uppercase text label.
private struct RunStatusText: View {
    let state: RunActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 5) {
            if !state.isPaused && !state.isFinished {
                Circle()
                    .fill(Color.liveBrand)
                    .frame(width: 6, height: 6)
            }
            Text(title)
                .font(Font.liveLabel)
                .textCase(.uppercase)
                .tracking(0.8)
                .foregroundStyle(.secondary)
        }
        .lineLimit(1)
    }

    private var title: String {
        if state.isFinished { return "Terminada" }
        if state.isPaused { return "Pausa" }
        return "Rec"
    }
}

/// Distance | pace with a hairline divider and labels under the values.
private struct RunMetricsRow: View {
    let state: RunActivityAttributes.ContentState
    var valueSize: CGFloat = 26

    var body: some View {
        HStack(spacing: 0) {
            metric(value: state.distanceKmText, unit: "km", label: "Distancia")
            Rectangle()
                .fill(Color.liveHairline)
                .frame(width: 0.5, height: valueSize + 8)
            metric(value: state.paceText, unit: "/km", label: "Ritmo")
        }
    }

    private func metric(value: String, unit: String, label: String) -> some View {
        VStack(spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value)
                    .font(Font.liveStat(valueSize))
                    .monospacedDigit()
                Text(unit)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            .lineLimit(1)
            Text(label)
                .font(Font.liveLabel)
                .textCase(.uppercase)
                .tracking(0.8)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct RunLockScreenView: View {
    let state: RunActivityAttributes.ContentState
    let isStale: Bool

    private var hint: String? {
        state.conqueredHint ?? (isStale && !state.isFinished ? "Abre Runna.io para actualizar" : nil)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Runna.io")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                RunStatusText(state: state)
            }

            HStack(alignment: .center, spacing: 12) {
                RunTimerText(state: state)
                    .font(Font.liveStat(52))
                    .foregroundStyle(state.isPaused && !state.isFinished ? Color.secondary : Color.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)

                RunMetricsRow(state: state, valueSize: 24)
                    .frame(width: 168)
            }

            if let hint {
                Text(hint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(16)
    }
}
