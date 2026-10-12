import SwiftUI
import T3WatchKit

@MainActor @Observable
final class ComposeModel {
  var draft: WatchDraft
  private(set) var notice: String?
  private(set) var error: String?
  private(set) var isSubmitting = false
  private var isClosed = false

  init(thread: WatchThreadSummary) {
    draft = WatchDraft(thread: thread)
    preselectSingleAction()
  }

  /// Restores a saved draft for the same thread, then checks it against the current snapshot.
  func restore(from store: SubmissionStore?, current: WatchThreadSummary) async {
    guard let saved = await store?.draft(threadId: current.threadId) else { return }
    draft = saved
    apply(try? saved.revalidate(against: current))
  }

  func save(to store: SubmissionStore?) async {
    guard !isClosed, !draft.text.isEmpty else { return }
    try? await store?.saveDraft(draft)
  }

  func discard(from store: SubmissionStore?) async {
    isClosed = true
    try? await store?.discardDraft(threadId: draft.target.threadId)
  }

  /// Re-fetches the thread, refuses to send if the run or provider moved, then persists the
  /// finalized envelope. Delivery happens on the receipt screen.
  func finalize(client: WatchClient, store: SubmissionStore) async -> String? {
    isSubmitting = true
    defer { isSubmitting = false }
    error = nil
    do {
      let fresh = try await client.thread(id: draft.target.threadId)
      let check = try draft.revalidate(against: fresh)
      if case .targetChanged = check {
        apply(check)
        return nil
      }
      if let earlier = await store.unresolved(
        environmentId: draft.target.environmentId, threadId: draft.target.threadId)
      {
        error = "An earlier instruction is still unresolved."
        return earlier.id
      }
      let envelope = try draft.makeEnvelope()
      try await store.insert(Submission(envelope: envelope, labels: draft.target.labels))
      await discard(from: store)
      return envelope.commandId
    } catch {
      self.error = describe(error)
      return nil
    }
  }

  private func apply(_ check: WatchDraft.Revalidation?) {
    guard case .targetChanged(let rebased) = check else { return }
    draft = rebased
    notice = "The thread changed while you were composing. Choose the action again."
    preselectSingleAction()
  }

  private func preselectSingleAction() {
    if draft.action == nil, draft.availableActions == [.send] {
      draft.action = .send
    }
  }

  private func describe(_ error: any Error) -> String {
    switch error {
    case WatchDraftError.text(.empty): "Dictate or type an instruction first."
    case WatchDraftError.text(.tooManyScalars(let count)): "Too long (\(count) of 8000 characters)."
    case WatchDraftError.text(.tooManyBytes): "Too long to send."
    case WatchDraftError.bodyTooLarge: "Too long to send."
    case WatchDraftError.noActionChosen: "Choose how to deliver it."
    case WatchDraftError.actionUnavailable(let action): "\(action.label) is not available now."
    default: error.localizedDescription
    }
  }
}

struct ComposeView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  @State private var model: ComposeModel
  private let thread: WatchThreadSummary

  init(thread: WatchThreadSummary) {
    self.thread = thread
    _model = State(initialValue: ComposeModel(thread: thread))
  }

  var body: some View {
    @Bindable var model = model
    let actions = model.draft.availableActions.filter {
      app.capabilities?.actions.contains($0) ?? true
    }
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        TargetHeader(labels: model.draft.target.labels)

        // The system input sheet offers dictation; dismissing it never submits.
        TextField("Instruction", text: $model.draft.text, axis: .vertical)
          .lineLimit(1...12)
        if model.draft.text.unicodeScalars.count > 7_000 {
          Text("\(model.draft.text.unicodeScalars.count) / 8000")
            .font(.caption2).foregroundStyle(.secondary)
        }

        if let notice = model.notice {
          Text(notice).font(.caption2).foregroundStyle(.orange)
        }

        if actions.isEmpty {
          Text("No delivery action is available right now.").font(.caption2)
        }
        ForEach(actions, id: \.self) { action in
          Button {
            model.draft.action = action
          } label: {
            HStack {
              Image(systemName: model.draft.action == action ? "largecircle.fill.circle" : "circle")
              VStack(alignment: .leading) {
                Text(action.label)
                Text(action.explanation).font(.caption2).foregroundStyle(.secondary)
              }
            }
          }
        }

        if model.draft.showsDisruptionWarning {
          Label("Steering may interrupt running tools.", systemImage: "exclamationmark.triangle.fill")
            .font(.caption2).foregroundStyle(.yellow)
        }

        if let error = model.error {
          Text(error).font(.caption2).foregroundStyle(.red)
        }

        Button {
          Task { await submit() }
        } label: {
          if model.isSubmitting {
            ProgressView()
          } else {
            Text(model.draft.action.map { "\($0.label) now" } ?? "Choose an action")
          }
        }
        .buttonStyle(.borderedProminent)
        .disabled(model.isSubmitting || model.draft.action == nil || model.draft.text.isEmpty)

        HStack {
          Button("Clear") { model.draft.text = "" }
          Button("Cancel", role: .cancel) {
            Task {
              await model.discard(from: app.store)
              dismiss()
            }
          }
        }
        .font(.caption)
      }
    }
    .navigationTitle("Compose")
    .task { await model.restore(from: app.store, current: thread) }
    .onDisappear { Task { [model, store = app.store] in await model.save(to: store) } }
  }

  private func submit() async {
    guard let client = app.client, let store = app.store else { return }
    guard let commandId = await model.finalize(client: client, store: store) else { return }
    if !app.path.isEmpty { app.path.removeLast() }
    app.path.append(.receipt(commandId: commandId))
  }
}
