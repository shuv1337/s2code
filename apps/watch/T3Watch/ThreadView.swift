import SwiftUI
import T3WatchKit

@MainActor @Observable
final class ThreadModel {
  private(set) var thread: WatchThreadSummary
  private(set) var error: String?
  private(set) var lastRefresh: Date?
  private(set) var unresolvedCommandId: String?
  private var interval: Duration = .seconds(3)

  init(thread: WatchThreadSummary) {
    self.thread = thread
  }

  func refresh(client: WatchClient, store: SubmissionStore?) async -> (any Error)? {
    unresolvedCommandId = await store?.unresolved(
      environmentId: thread.environmentId, threadId: thread.threadId)?.id
    do {
      let fresh = try await client.thread(id: thread.threadId)
      let changed =
        fresh.activity != thread.activity || fresh.activeRunId != thread.activeRunId
        || fresh.updatedAt != thread.updatedAt || fresh.queuedCount != thread.queuedCount
        || fresh.pendingAttention != thread.pendingAttention
      thread = fresh
      lastRefresh = Date()
      error = nil
      interval = changed ? .seconds(3) : min(interval * 1.5, .seconds(10))
      return nil
    } catch {
      self.error = error.localizedDescription
      interval = min(interval * 2, .seconds(10))
      return error
    }
  }

  /// Adaptive 3–10 s polling while the view is visible and the scene is active.
  func poll(client: WatchClient, store: SubmissionStore?, onError: (any Error) -> Void) async {
    interval = .seconds(3)
    while !Task.isCancelled {
      if let error = await refresh(client: client, store: store) { onError(error) }
      try? await Task.sleep(for: interval)
    }
  }
}

struct ThreadView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.scenePhase) private var scenePhase
  @State private var model: ThreadModel
  @State private var parentError: String?

  init(initial: WatchThreadSummary) {
    _model = State(initialValue: ThreadModel(thread: initial))
  }

  private var thread: WatchThreadSummary { model.thread }

  var body: some View {
    List {
      Section {
        TargetHeader(labels: thread.labels)
        Text(thread.providerInstanceId).font(.caption2).foregroundStyle(.secondary)
        HStack {
          ActivityBadge(activity: thread.activity)
          if thread.queuedCount > 0 {
            Text("\(thread.queuedCount) queued").font(.caption2).foregroundStyle(.secondary)
          }
        }
        RefreshAge(date: model.lastRefresh)
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
        .foregroundStyle(.orange)
      }

      if let excerpt = thread.latestAssistantExcerpt {
        Section("Last completed reply") {
          Text(excerpt).font(.footnote)
        }
      }

      Section {
        if let commandId = model.unresolvedCommandId {
          NavigationLink(value: Route.receipt(commandId: commandId)) {
            Label("Earlier instruction unresolved", systemImage: "questionmark.circle")
          }
        } else if thread.isReadOnly {
          Text("Subagent thread. Messages go to its parent.").font(.caption2)
          if thread.parentThreadId != nil {
            Button("Open parent") { Task { await openParent() } }
          }
          if let parentError { Text(parentError).font(.caption2).foregroundStyle(.red) }
        } else {
          let actions = WatchAdmissionRules.availableActions(
            for: thread, serverActions: app.capabilities?.actions)
          NavigationLink(value: Route.compose(thread)) {
            Label("New instruction", systemImage: "mic.fill")
          }
          .disabled(actions.isEmpty)
          Text(actions.map(\.label).joined(separator: " · "))
            .font(.caption2).foregroundStyle(.secondary)
        }
      }

      Section {
        Button(app.pins.contains(thread.threadId) ? "Unpin" : "Pin") {
          app.pins.toggle(thread.threadId)
        }
      }
    }
    .navigationTitle(thread.labels.thread)
    .task(id: scenePhase) {
      guard scenePhase == .active, let client = app.client else { return }
      await model.poll(client: client, store: app.store) { app.handle($0) }
    }
  }

  private func openParent() async {
    guard let client = app.client, let parentId = thread.parentThreadId else { return }
    do {
      app.path.append(.thread(try await client.thread(id: parentId)))
    } catch {
      parentError = error.localizedDescription
    }
  }
}
