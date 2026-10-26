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

    /// Brand emerald (#12A85E light / #2FD27F dark).
    static let liveBrand = Color.liveAdaptive(light: 0x12A85E, dark: 0x2FD27F)
    /// Always the bright variant: the Dynamic Island is black in both modes.
    static let liveBrandBright = Color(uiColor: UIColor(liveRGB: 0x2FD27F))
    static let livePaused = Color(uiColor: UIColor(liveRGB: 0xF5A524))
    static let liveBackground = Color.liveAdaptive(light: 0xF4FBF7, dark: 0x0E1512)
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

// MARK: - Widget

struct RunLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RunActivityAttributes.self) { context in
            RunLockScreenView(state: context.state, isStale: context.isStale)
                .activityBackgroundTint(Color.liveBackground)
                .activitySystemActionForegroundColor(Color.liveBrand)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        Label {
                            Text("Runna.io")
                        } icon: {
                            Image(systemName: "figure.run")
                        }
                        .font(.system(.caption, design: .rounded).weight(.bold))
                        .foregroundStyle(Color.liveBrandBright)
                        if state.isPaused && !state.isFinished {
                            PausedBadge()
                        }
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 0) {
                        Text(state.distanceKmText)
                            .font(.system(.title2, design: .rounded).weight(.bold))
                            .monospacedDigit()
                        Text("km")
                            .font(.system(.caption2, design: .rounded).weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    RunTimerText(state: state)
                        .font(.system(size: 34, weight: .heavy, design: .rounded))
                        .foregroundStyle(state.isPaused ? Color.livePaused : Color.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Label("\(state.paceText) /km", systemImage: "speedometer")
                        Spacer()
                        if let hint = state.conqueredHint {
                            Text(hint)
                        } else if state.isFinished {
                            Text("Carrera terminada")
                        }
                    }
                    .font(.system(.footnote, design: .rounded).weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                Image(systemName: state.isPaused ? "pause.fill" : "figure.run")
                    .foregroundStyle(state.isPaused ? Color.livePaused : Color.liveBrandBright)
            } compactTrailing: {
                RunTimerText(state: state)
                    .font(.system(.footnote, design: .rounded).weight(.bold))
                    .foregroundStyle(state.isPaused ? Color.livePaused : Color.liveBrandBright)
                    .frame(maxWidth: 56)
            } minimal: {
                Image(systemName: state.isPaused ? "pause.fill" : "figure.run")
                    .foregroundStyle(state.isPaused ? Color.livePaused : Color.liveBrandBright)
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

private struct PausedBadge: View {
    var body: some View {
        Text("PAUSA")
            .font(.system(.caption2, design: .rounded).weight(.heavy))
            .foregroundStyle(Color.black)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Color.livePaused, in: Capsule())
    }
}

private struct RunLockScreenView: View {
    let state: RunActivityAttributes.ContentState
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "figure.run")
                    .font(.system(.subheadline, design: .rounded).weight(.bold))
                    .foregroundStyle(Color.liveBrand)
                Text("Runna.io")
                    .font(.system(.subheadline, design: .rounded).weight(.bold))
                Spacer()
                if state.isFinished {
                    Text("Terminada")
                        .font(.system(.caption, design: .rounded).weight(.bold))
                        .foregroundStyle(Color.liveBrand)
                } else if state.isPaused {
                    PausedBadge()
                } else {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(Color.liveBrand)
                            .frame(width: 7, height: 7)
                        Text("Grabando")
                    }
                    .font(.system(.caption, design: .rounded).weight(.semibold))
                    .foregroundStyle(.secondary)
                }
            }

            HStack(alignment: .lastTextBaseline, spacing: 12) {
                RunTimerText(state: state)
                    .font(.system(size: 44, weight: .heavy, design: .rounded))
                    .foregroundStyle(state.isPaused && !state.isFinished ? Color.livePaused : Color.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .trailing, spacing: 2) {
                    HStack(alignment: .lastTextBaseline, spacing: 3) {
                        Text(state.distanceKmText)
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .monospacedDigit()
                        Text("km")
                            .font(.system(.subheadline, design: .rounded).weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    Text("\(state.paceText) /km")
                        .font(.system(.footnote, design: .rounded).weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                .lineLimit(1)
                .fixedSize()
            }

            if let hint = state.conqueredHint ?? (isStale && !state.isFinished ? "Abre Runna.io para actualizar" : nil) {
                Text(hint)
                    .font(.system(.caption, design: .rounded).weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(16)
    }
}
