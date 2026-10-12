import SwiftUI
import T3WatchKit

@MainActor @Observable
final class ThreadsModel {
  private(set) var recent: [WatchThreadSummary] = []
  private(set) var pinned: [WatchThreadSummary] = []
  private(set) var nextCursor: String?
  private(set) var isLoading = false
  private(set) var error: String?
  private(set) var lastRefresh: Date?
  private(set) var lastRefreshFailed = false
  /// When each shown summary was fetched; pinned threads outside the page are fetched separately.
  private(set) var fetchedAt: [String: Date] = [:]
  private var restored = false

  var freshness: SnapshotFreshness {
    SnapshotFreshness(fetchedAt: lastRefresh, lastRefreshFailed: lastRefreshFailed)
  }

  /// Shows the last cached page until the first refresh lands.
  func restore(cache: SnapshotCache?, pins: [String]) async {
    guard !restored, let cache else { return }
    restored = true
    guard let cached = await cache.threadsPage, lastRefresh == nil else { return }
    var byId = Dictionary(
      cached.page.items.map { ($0.threadId, $0) }, uniquingKeysWith: { a, _ in a })
    var times = byId.mapValues { _ in cached.fetchedAt }
    for id in pins where byId[id] == nil {
      if let thread = await cache.thread(id: id) {
        byId[id] = thread.summary
        times[id] = thread.fetchedAt
      }
    }
    guard lastRefresh == nil else { return }
    pinned = pins.compactMap { byId[$0] }
    recent = cached.page.items.filter { !pins.contains($0.threadId) }
    nextCursor = cached.page.nextCursor
    fetchedAt = times
    lastRefresh = cached.fetchedAt
  }

  func refresh(client: WatchClient, cache: SnapshotCache?, pins: [String]) async {
    guard !isLoading else { return }
    isLoading = true
    defer { isLoading = false }
    do {
      let page = try await client.threads(limit: WatchLimits.defaultThreadPageSize)
      let now = Date()
      try? await cache?.saveThreadsPage(page, fetchedAt: now)
      var byId = Dictionary(page.items.map { ($0.threadId, $0) }, uniquingKeysWith: { a, _ in a })
      var times = byId.mapValues { _ in now }
      for id in pins where byId[id] == nil {
        if let thread = try? await client.thread(id: id) {
          let at = Date()
          byId[id] = thread
          times[id] = at
          try? await cache?.saveThread(thread, fetchedAt: at)
        }
      }
      pinned = pins.compactMap { byId[$0] }
      recent = page.items.filter { !pins.contains($0.threadId) }
      nextCursor = page.nextCursor
      fetchedAt = times
      lastRefresh = now
      lastRefreshFailed = false
      error = nil
    } catch {
      if Task.isCancelled { return }
      lastRefreshFailed = true
      self.error = error.localizedDescription
    }
  }

  func loadMore(client: WatchClient, pins: [String]) async {
    guard let cursor = nextCursor, !isLoading else { return }
    isLoading = true
    defer { isLoading = false }
    do {
      let page = try await client.threads(cursor: cursor, limit: WatchLimits.defaultThreadPageSize)
      let known = Set(recent.map(\.threadId)).union(pins)
      let added = page.items.filter { !known.contains($0.threadId) }
      recent += added
      let now = Date()
      for thread in added { fetchedAt[thread.threadId] = now }
      nextCursor = page.nextCursor
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// Pin order is frozen to the order pins were added.
  func applyPins(_ pins: [String]) {
    let all = pinned + recent
    pinned = pins.compactMap { id in all.first { $0.threadId == id } }
    recent = all.filter { !pins.contains($0.threadId) }
  }
}

struct ThreadsView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.scenePhase) private var scenePhase
  @State private var model = ThreadsModel()
  @State private var showsEnvironments = false

  var body: some View {
    TimelineView(.periodic(from: .now, by: freshnessTick)) { context in
      let stale = model.freshness.isStale(now: context.date)
      List {
        if !model.pinned.isEmpty {
          Section("Pinned") {
            ForEach(model.pinned) { row($0, stale: stale) }
          }
        }
        Section("Recent") {
          ForEach(model.recent) { row($0, stale: stale) }
          if model.nextCursor != nil {
            Button("Load more") { Task { await loadMore() } }
              .disabled(model.isLoading)
          }
          if model.recent.isEmpty && model.pinned.isEmpty && !model.isLoading {
            Text("No threads").foregroundStyle(.secondary)
          }
        }
        Section {
          FreshnessLabel(freshness: model.freshness, now: context.date)
          if let error = model.error ?? app.authError ?? app.startupError {
            Text(error).font(.caption2).foregroundStyle(.red)
          }
        }
        Section {
          Button { showsEnvironments = true } label: {
            Label(app.environmentLabel, systemImage: "server.rack")
          }
        }
      }
    }
    .navigationTitle("Threads")
    .sheet(isPresented: $showsEnvironments) { NavigationStack { EnvironmentsView() } }
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          Task { await refresh() }
        } label: {
          Image(systemName: "arrow.clockwise")
        }
        .disabled(model.isLoading)
      }
    }
    .task(id: scenePhase) {
      await model.restore(cache: app.cache, pins: app.pins.ids)
      guard scenePhase == .active else { return }
      await refresh()
    }
    .onChange(of: app.pins.ids) { _, ids in model.applyPins(ids) }
  }

  private func row(_ thread: WatchThreadSummary, stale: Bool) -> some View {
    NavigationLink(
      value: Route.thread(thread, fetchedAt: model.fetchedAt[thread.threadId] ?? model.lastRefresh)
    ) {
      VStack(alignment: .leading, spacing: 2) {
        Text(thread.labels.thread).lineLimit(2)
          .foregroundStyle(stale ? .secondary : .primary)
        Text(thread.labels.project ?? "No project")
          .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        HStack(spacing: 4) {
          ActivityBadge(activity: thread.activity, isStale: stale)
          if thread.pendingAttention.needsAttention {
            Image(systemName: "exclamationmark.bubble.fill")
              .foregroundStyle(stale ? Color.secondary : .orange)
          }
        }
      }
    }
    .swipeActions {
      Button {
        app.pins.toggle(thread.threadId)
      } label: {
        Image(systemName: app.pins.contains(thread.threadId) ? "pin.slash" : "pin")
      }
      .tint(.yellow)
    }
  }

  private func refresh() async {
    guard let client = app.client else { return }
    await model.refresh(client: client, cache: app.cache, pins: app.pins.ids)
  }

  private func loadMore() async {
    guard let client = app.client else { return }
    await model.loadMore(client: client, pins: app.pins.ids)
  }
}
