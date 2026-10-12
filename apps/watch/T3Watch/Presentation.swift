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

  var body: some View {
    Label(activity.label, systemImage: "circle.fill")
      .labelStyle(.titleAndIcon)
      .font(.caption2)
      .foregroundStyle(activity.tint)
  }
}

/// Coarse "updated 20s ago" label; refreshes on a slow timer to avoid per-second repaints.
struct RefreshAge: View {
  let date: Date?

  var body: some View {
    TimelineView(.periodic(from: .now, by: 15)) { context in
      Text(text(now: context.date))
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
  }

  private func text(now: Date) -> String {
    guard let date else { return "Not refreshed" }
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
