import SwiftUI
import T3WatchKit

extension WatchThreadActivity {
  var label: String {
    switch self {
    case .idle: "Idle"
    case .preparing: "Preparing"
    case .queued: "Queued"
    case .starting: "Starting"
    case .running: "Running"
    case .waiting: "Waiting"
    case .completed: "Completed"
    case .interrupted: "Interrupted"
    case .failed: "Failed"
    case .cancelled: "Cancelled"
    case .rolledBack: "Rolled back"
    case .unknown: "Unknown"
    }
  }

  var tint: Color {
    switch self {
    case .running, .starting, .preparing: .green
    case .waiting, .queued: .orange
    case .failed, .interrupted: .red
    case .unknown: .yellow
    default: .secondary
    }
  }
}

extension WatchAction {
  var label: String {
    switch self {
    case .send: "Send"
    case .queue: "Queue"
    case .steer: "Steer"
    }
  }

  var explanation: String {
    switch self {
    case .send: "Starts a new run on this idle thread."
    case .queue: "Runs after the current work finishes."
    case .steer: "Redirects the run in progress."
    }
  }
}

struct ActivityBadge: View {
  let activity: WatchThreadActivity
  /// A stale activity is last known, not live, so it loses its colour.
  var isStale = false

  var body: some View {
    Label(activity.label, systemImage: "circle.fill")
      .labelStyle(.titleAndIcon)
      .font(.caption2)
      .foregroundStyle(isStale ? Color.secondary : activity.tint)
  }
}

/// Coarse ticks for age labels and staleness; never per-second repaints.
let freshnessTick: TimeInterval = 15

/// "Updated 20s ago", plus a caption once the snapshot is stale. `now` comes from a coarse
/// `TimelineView` owned by the screen, which also uses it to gate actions.
struct FreshnessLabel: View {
  let freshness: SnapshotFreshness
  let now: Date

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(age).font(.caption2).foregroundStyle(.secondary)
      if freshness.fetchedAt != nil && freshness.isStale(now: now) {
        Label(
          freshness.lastRefreshFailed ? "Offline · last known state" : "Stale · last known state",
          systemImage: freshness.lastRefreshFailed ? "wifi.slash" : "clock.arrow.circlepath"
        )
        .font(.caption2)
        .foregroundStyle(.yellow)
      }
    }
  }

  private var age: String {
    guard let date = freshness.fetchedAt else {
      return freshness.lastRefreshFailed ? "Couldn't refresh" : "Not refreshed"
    }
    let seconds = max(0, Int(now.timeIntervalSince(date)))
    if seconds < 15 { return "Updated just now" }
    if seconds < 60 { return "Updated \(seconds)s ago" }
    if seconds < 3600 { return "Updated \(seconds / 60)m ago" }
    return "Updated \(seconds / 3600)h ago"
  }
}

struct TargetHeader: View {
  let labels: WatchThreadLabels

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(labels.thread).font(.headline).lineLimit(2)
      Text("\(labels.project ?? "No project") · \(labels.environment)")
        .font(.caption2)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
  }
}
