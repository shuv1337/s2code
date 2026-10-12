import SwiftUI
import T3WatchKit

@MainActor @Observable
final class ThreadModel {
  private(set) var thread: WatchThreadSummary
  private(set) var error: String?
  private(set) var lastRefresh: Date?
  private(set) var lastRefreshFailed = false
  private(set) var unresolvedCommandId: String?
  private var interval: Duration = .seconds(3)
  private var generation = GenerationGate()

  init(thread: WatchThreadSummary, fetchedAt: Date?) {
    self.thread = thread
    lastRefresh = fetchedAt
  }

  var freshness: SnapshotFreshness {
    SnapshotFreshness(fetchedAt: lastRefresh, lastRefreshFailed: lastRefreshFailed)
  }

  /// Adopts the cached summary when it is newer than what the view opened with.
  func restore(cache: SnapshotCache?) async {
    guard let cached = await cache?.thread(id: thread.threadId),
      cached.fetchedAt > (lastRefresh ?? .distantPast)
    else { return }
    thread = cached.summary
    lastRefresh = cached.fetchedAt
  }

  /// Discards any refresh already in flight. Call when a receipt commits, on explicit refresh,
  /// and when the scene becomes active.
  func invalidate() {
    generation.advance()
  }

  func refresh(client: WatchClient, store: SubmissionStore?, cache: SnapshotCache?) async
    -> (any Error)?
  {
    let started = generation.current
    unresolvedCommandId = await store?.unresolved(
      environmentId: thread.environmentId, threadId: thread.threadId)?.id
    do {
      let fresh = try await client.thread(id: thread.threadId)
      guard generation.isCurrent(started), !Task.isCancelled else { return nil }
      let changed =
        fresh.activity != thread.activity || fresh.activeRunId != thread.activeRunId
        || fresh.updatedAt != thread.updatedAt || fresh.queuedCount != thread.queuedCount
        || fresh.pendingAttention != thread.pendingAttention
      let now = Date()
      thread = fresh
      lastRefresh = now
      lastRefreshFailed = false
      error = nil
      interval = changed ? .seconds(3) : min(interval * 1.5, .seconds(10))
      try? await cache?.saveThread(fresh, fetchedAt: now)
      return nil
    } catch {
      guard generation.isCurrent(started), !Task.isCancelled else { return nil }
      self.error = error.localizedDescription
      lastRefreshFailed = true
      interval = min(interval * 2, .seconds(10))
      return error
    }
  }

  /// Adaptive 3–10 s polling while the view is visible and the scene is active.
  func poll(
    client: WatchClient, store: SubmissionStore?, cache: SnapshotCache?,
    onError: (any Error) -> Void
  ) async {
    interval = .seconds(3)
    while !Task.isCancelled {
      if let error = await refresh(client: client, store: store, cache: cache) { onError(error) }
      try? await Task.sleep(for: interval)
    }
  }
}

struct ThreadView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.scenePhase) private var scenePhase
  @State private var model: ThreadModel
  @State private var parentError: String?

  /// Polling restarts (with a fresh generation) when the scene activates or a receipt commits.
  private struct PollTrigger: Hashable {
    var phase: ScenePhase
    var commits: Int
  }

  init(initial: WatchThreadSummary, fetchedAt: Date?) {
    _model = State(initialValue: ThreadModel(thread: initial, fetchedAt: fetchedAt))
  }

  private var thread: WatchThreadSummary { model.thread }

  var body: some View {
    TimelineView(.periodic(from: .now, by: freshnessTick)) { context in
      list(stale: model.freshness.isStale(now: context.date), now: context.date)
    }
    .navigationTitle(thread.labels.thread)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          Task { await refreshNow() }
        } label: {
          Image(systemName: "arrow.clockwise")
        }
      }
    }
    .task(id: PollTrigger(phase: scenePhase, commits: app.commitEpochs[thread.threadId] ?? 0)) {
      await model.restore(cache: app.cache)
      guard scenePhase == .active, let client = app.client, client.environmentId == thread.environmentId else { return }
      model.invalidate()
      await model.poll(client: client, store: app.store, cache: app.cache) { error in
        if app.client?.environmentId == thread.environmentId { app.handle(error) }
      }
    }
  }

  private func list(stale: Bool, now: Date) -> some View {
    List {
      Section {
        if let commandId = model.unresolvedCommandId {
          NavigationLink(value: Route.receipt(commandId: commandId)) {
            Label("Check instruction", systemImage: "questionmark.circle")
          }
        } else if thread.isReadOnly {
          Text("Messages go to this agent's parent.").font(.caption2)
          if thread.parentThreadId != nil {
            Button("Open parent") { Task { await openParent() } }
          }
          if let parentError { Text(parentError).font(.caption2).foregroundStyle(.red) }
        } else {
          ComposeView(thread: thread)
        }
      }.listRowBackground(Color.clear)

      Section {
        TargetHeader(labels: thread.labels)
        Text(thread.providerInstanceId).font(.caption2).foregroundStyle(.secondary)
        HStack {
          ActivityBadge(activity: thread.activity, isStale: stale)
          if thread.queuedCount > 0 {
            Text("\(thread.queuedCount) queued").font(.caption2).foregroundStyle(.secondary)
          }
        }
        FreshnessLabel(freshness: model.freshness, now: now)
        if let error = model.error {
          Text(error).font(.caption2).foregroundStyle(.red)
        }
      }

      if thread.pendingAttention.needsAttention {
        Section {
          if let request = thread.pendingAttention.runtimeRequest {
            Label("Waiting for approval (\(request.kind))", systemImage: "hand.raised.fill")
          }
          if thread.pendingAttention.hasActionableProposedPlan {
            Label("Plan awaiting review", systemImage: "list.bullet.clipboard")
          }
        } footer: {
          Text("Respond on another T3 client.")
        }
        .foregroundStyle(stale ? Color.secondary : .orange)
      }

      if let excerpt = thread.latestAssistantExcerpt {
        Section("Last completed reply") {
          Text(excerpt).font(.footnote).foregroundStyle(stale ? .secondary : .primary)
        }
      }

      Section {
        Button(app.pins.contains(thread.threadId) ? "Unpin" : "Pin") {
          app.pins.toggle(thread.threadId)
        }
      }
    }
  }

  private func refreshNow() async {
    guard let client = app.client, client.environmentId == thread.environmentId else { return }
    model.invalidate()
    if let error = await model.refresh(client: client, store: app.store, cache: app.cache) {
      if app.client?.environmentId == thread.environmentId { app.handle(error) }
    }
  }

  private func openParent() async {
    guard let client = app.client, client.environmentId == thread.environmentId,
      let parentId = thread.parentThreadId else { return }
    do {
      let parent = try await client.thread(id: parentId)
      guard app.client?.environmentId == thread.environmentId else { return }
      app.path.append(.thread(parent, fetchedAt: Date()))
    } catch {
      parentError = error.localizedDescription
    }
  }
}
