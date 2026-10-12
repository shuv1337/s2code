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

  func refresh(client: WatchClient, pins: [String]) async {
    guard !isLoading else { return }
    isLoading = true
    defer { isLoading = false }
    do {
      let page = try await client.threads(limit: WatchLimits.defaultThreadPageSize)
      var byId = Dictionary(page.items.map { ($0.threadId, $0) }, uniquingKeysWith: { a, _ in a })
      for id in pins where byId[id] == nil {
        if let thread = try? await client.thread(id: id) { byId[id] = thread }
      }
      pinned = pins.compactMap { byId[$0] }
      recent = page.items.filter { !pins.contains($0.threadId) }
      nextCursor = page.nextCursor
      lastRefresh = Date()
      error = nil
    } catch {
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
      recent += page.items.filter { !known.contains($0.threadId) }
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
  @State private var model = ThreadsModel()

  var body: some View {
    List {
      Section {
        RefreshAge(date: model.lastRefresh)
        if let error = model.error ?? app.authError ?? app.startupError {
          Text(error).font(.caption2).foregroundStyle(.red)
        }
      }
      if !model.pinned.isEmpty {
        Section("Pinned") {
          ForEach(model.pinned) { row($0) }
        }
      }
      Section("Recent") {
        ForEach(model.recent) { row($0) }
        if model.nextCursor != nil {
          Button("Load more") { Task { await loadMore() } }
            .disabled(model.isLoading)
        }
        if model.recent.isEmpty && model.pinned.isEmpty && !model.isLoading {
          Text("No threads").foregroundStyle(.secondary)
        }
      }
      Section {
        Button("Unpair", role: .destructive) { app.unpair() }
      }
    }
    .navigationTitle("Threads")
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
    .task { await refresh() }
    .onChange(of: app.pins.ids) { _, ids in model.applyPins(ids) }
  }

  private func row(_ thread: WatchThreadSummary) -> some View {
    NavigationLink(value: Route.thread(thread)) {
      VStack(alignment: .leading, spacing: 2) {
        Text(thread.labels.thread).lineLimit(2)
        Text(thread.labels.project ?? "No project")
          .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        HStack(spacing: 4) {
          ActivityBadge(activity: thread.activity)
          if thread.pendingAttention.needsAttention {
            Image(systemName: "exclamationmark.bubble.fill").foregroundStyle(.orange)
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
    await model.refresh(client: client, pins: app.pins.ids)
  }

  private func loadMore() async {
    guard let client = app.client else { return }
    await model.loadMore(client: client, pins: app.pins.ids)
  }
}
