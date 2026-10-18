import SwiftUI
import T3WatchKit

@MainActor @Observable
final class ReceiptModel {
  let commandId: String
  private(set) var submission: Submission?
  private(set) var isWorking = false
  private(set) var error: String?

  init(commandId: String) {
    self.commandId = commandId
  }

  var acceptedTrigger: Bool {
    if case .receipt(let receipt) = submission?.state { return receipt.status == .accepted }
    return false
  }

  /// `accepted` or `failed`: either way the environment committed and the thread moved.
  var committed: Bool {
    if case .receipt(let receipt) = submission?.state { return receipt.acceptedAt != nil }
    return false
  }

  func load(store: SubmissionStore?) async {
    submission = await store?.submission(id: commandId)
  }

  func drive(coordinator: SubmissionCoordinator?) async {
    guard let coordinator, !isWorking else { return }
    isWorking = true
    defer { isWorking = false }
    do {
      submission = try await coordinator.drive(id: commandId)
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// Keeps reconciling while unresolved and visible. Never creates a new command ID.
  func reconcile(coordinator: SubmissionCoordinator?) async {
    var delay: Duration = .seconds(3)
    for _ in 0..<20 where !Task.isCancelled {
      await drive(coordinator: coordinator)
      guard let submission, !submission.isResolved else { return }
      if case .pending(let lastError?) = submission.state, !lastError.isEmpty {
        return  // Offline: wait for an explicit retry rather than spinning.
      }
      if let until = submission.retryAfter(now: Date()) {
        try? await Task.sleep(for: .seconds(max(1, until.timeIntervalSinceNow)))
      } else {
        try? await Task.sleep(for: delay)
        delay = min(delay * 2, .seconds(10))
      }
    }
  }
}

struct ReceiptView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.scenePhase) private var scenePhase
  @State private var model: ReceiptModel
  @State private var editError: String?

  init(commandId: String) {
    _model = State(initialValue: ReceiptModel(commandId: commandId))
  }

  var body: some View {
    List {
      if let submission = model.submission {
        Section {
          TargetHeader(labels: submission.labels)
          Text("\(submission.envelope.action.label): \(submission.envelope.text)")
            .font(.footnote)
            .lineLimit(6)
        }
        Section {
          status(submission)
          if let error = model.error {
            Text(error).font(.caption2).foregroundStyle(.red)
          }
        }
        Section {
          if !submission.isResolved {
            Button(retryLabel(submission)) {
              Task { await model.drive(coordinator: app.coordinator) }
            }
            .disabled(model.isWorking)
          } else {
            Button("Edit as new instruction") { Task { await editAsNew(submission) } }
            if let editError { Text(editError).font(.caption2).foregroundStyle(.red) }
          }
        }
      } else {
        ProgressView()
      }
    }
    .navigationTitle("Receipt")
    .sensoryFeedback(.success, trigger: model.acceptedTrigger) { _, accepted in accepted }
    .onChange(of: model.committed) { _, committed in
      if committed, model.submission?.envelope.environmentId == app.client?.environmentId,
        let threadId = model.submission?.envelope.threadId {
        app.noteCommitted(threadId: threadId)
      }
    }
    .task(id: scenePhase) {
      await model.load(store: app.store)
      guard scenePhase == .active else { return }
      await model.reconcile(coordinator: app.coordinator)
    }
  }

  @ViewBuilder
  private func status(_ submission: Submission) -> some View {
    switch submission.state {
    case .pending(let lastError):
      if let lastError {
        Label("Not sent yet", systemImage: "wifi.slash").foregroundStyle(.orange)
        Text(lastError).font(.caption2).foregroundStyle(.secondary)
      } else {
        Label(model.isWorking ? "Sending…" : "Saved on Watch", systemImage: "tray.and.arrow.up")
      }
    case .unknown(let lastError, _):
      Label("Delivery unknown", systemImage: "questionmark.circle").foregroundStyle(.yellow)
      Text("Checking the environment for a receipt. \(lastError)")
        .font(.caption2).foregroundStyle(.secondary)
    case .receipt(let receipt):
      receiptStatus(receipt)
    case .notAdmitted(.expired):
      Label("Not admitted", systemImage: "clock.badge.xmark").foregroundStyle(.red)
      Text("It expired before the environment received it.").font(.caption2)
    case .notAdmitted(.refused(let code, let message)):
      Label("Not admitted", systemImage: "xmark.octagon").foregroundStyle(.red)
      Text("\(message) (\(code))").font(.caption2)
    case .unresolvable(let reason):
      Label("Outcome unknown", systemImage: "questionmark.diamond").foregroundStyle(.yellow)
      Text("\(reason) Check the thread in S2Code.").font(.caption2)
    }
  }

  @ViewBuilder
  private func receiptStatus(_ receipt: WatchCommandReceipt) -> some View {
    switch receipt.status {
    case .accepted:
      Label(committedLabel(receipt.action), systemImage: "checkmark.circle.fill")
        .foregroundStyle(.green)
      Text("Committed, not finished. Watch the thread for progress.").font(.caption2)
    case .failed:
      Label("Committed, not applied", systemImage: "exclamationmark.circle").foregroundStyle(.orange)
      Text(receipt.error?.message ?? "").font(.caption2)
    case .rejected:
      Label("Rejected", systemImage: "xmark.circle").foregroundStyle(.red)
      Text(rejectionText(receipt.error)).font(.caption2)
    }
    if let observed = receipt.observed {
      HStack {
        Text("Thread now").font(.caption2).foregroundStyle(.secondary)
        ActivityBadge(activity: observed.activity)
      }
    }
  }

  private func committedLabel(_ action: WatchAction) -> String {
    switch action {
    case .send: "Run requested"
    case .queue: "Queued on server"
    case .steer: "Steer committed"
    }
  }

  private func rejectionText(_ error: WatchCommandError?) -> String {
    guard let error else { return "" }
    return switch error.code {
    case .threadBusy: "The thread started working. Try Queue or Steer."
    case .threadIdle: "The run already finished. Try Send."
    case .staleTarget: "A different run is active now."
    case .expired: "It arrived too late."
    case .steeringUnsupported, .steeringWouldRestart: "This provider cannot steer without restarting."
    case .commandConflict: "This command ID was already used for something else."
    default: "\(error.message) (\(error.code))"
    }
  }

  private func retryLabel(_ submission: Submission) -> String {
    if case .unknown = submission.state { return "Check again" }
    return "Retry same instruction"
  }

  private func editAsNew(_ submission: Submission) async {
    guard let client = app.client, client.environmentId == submission.envelope.environmentId else { return }
    do {
      let thread = try await client.thread(id: submission.envelope.threadId)
      guard app.client?.environmentId == submission.envelope.environmentId else { return }
      var draft = WatchDraft(thread: thread, text: submission.envelope.text)
      draft.action = nil
      try await app.store?.saveDraft(draft)
      guard app.client?.environmentId == submission.envelope.environmentId else { return }
      if !app.path.isEmpty { app.path.removeLast() }
      app.path.append(.compose(thread))
    } catch {
      editError = error.localizedDescription
    }
  }
}
