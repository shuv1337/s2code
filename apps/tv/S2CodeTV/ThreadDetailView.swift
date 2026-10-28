import SwiftUI
import T3WatchKit

/// The shelf paints immediately. A direct fetch keeps the excerpt current after the thread
/// leaves the loaded page. Both responses are the watch API's capped excerpt.
struct ThreadDetailView: View {
  let model: TVModel
  let ref: ThreadRef
  @State private var detail: WatchThreadSummary?
  @State private var lastKnown: WatchThreadSummary?

  var body: some View {
    TimelineView(.periodic(from: .now, by: freshnessTick)) { context in
      loaded(now: context.date)
    }
    .task(id: ref) {
      detail = nil
      lastKnown = model.thread(ref)
      while !Task.isCancelled {
        switch await model.loadThread(ref) {
        case .current(let thread):
          detail = thread
          lastKnown = thread
        case .gone:
          detail = nil
        case .unavailable:
          break
        }
        try? await Task.sleep(for: TVModel.refreshInterval)
      }
    }
    .onChange(of: model.thread(ref)) { _, thread in
      if let thread { lastKnown = thread }
    }
  }

  @ViewBuilder
  private func loaded(now: Date) -> some View {
    if let thread = detail ?? model.thread(ref) ?? lastKnown {
      content(thread, now: now, missing: detail == nil && model.thread(ref) == nil)
    } else {
      Text("This thread is no longer available.").foregroundStyle(.secondary)
    }
  }

  private func content(_ thread: WatchThreadSummary, now: Date, missing: Bool) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 36) {
        VStack(alignment: .leading, spacing: 12) {
          Text(thread.labels.thread).font(.largeTitle.bold())
          Text("\(thread.labels.project ?? "No project") · \(thread.labels.environment)")
            .foregroundStyle(.secondary)
        }
        HStack(spacing: 40) {
          ActivityBadge(
            activity: thread.activity,
            isStale: missing || isStale(fetchedAt: model.feeds[ref.serverId]?.fetchedAt, now: now))
          AttentionBadge(attention: thread.pendingAttention)
          if thread.queuedCount > 0 {
            Label("\(thread.queuedCount) queued", systemImage: "tray.full").font(.caption)
          }
          Text(thread.provider).font(.caption).foregroundStyle(.secondary)
          Text("Updated \(ageLabel(since: thread.updatedAt, now: now))")
            .font(.caption).foregroundStyle(.secondary)
        }
        if missing {
          Text("No longer in the thread list · last known state").foregroundStyle(.yellow)
        }
        // Focusable so the remote can scroll a long excerpt.
        Button {
        } label: {
          VStack(alignment: .leading, spacing: 16) {
            Text("Last completed reply").font(.caption).foregroundStyle(.secondary)
            Text(thread.latestAssistantExcerpt ?? "No reply yet.")
              .font(.title3)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .padding(40)
        }
        .buttonStyle(.card)
      }
      .padding(80)
    }
  }
}
