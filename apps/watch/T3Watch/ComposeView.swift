import SwiftUI
import T3WatchKit

@MainActor @Observable
final class ComposeModel {
  var draft: WatchDraft
  private(set) var notice: String?
  private(set) var error: String?
  private(set) var isSubmitting = false
  private(set) var isClosed = false

  init(thread: WatchThreadSummary) {
    draft = WatchDraft(thread: thread)
    preselectDefaultAction()
  }

  /// Restores a saved draft for the same thread, then checks it against the current snapshot.
  func restore(from store: SubmissionStore?, current: WatchThreadSummary) async {
    guard let saved = await store?.draft(threadId: current.threadId) else { return }
    draft = saved
    apply(try? saved.revalidate(against: current))
  }

  func save(to store: SubmissionStore?) async {
    guard !isClosed else { return }
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
    notice = "The thread changed while you were composing. Review delivery before sending."
    preselectDefaultAction()
  }

  private func preselectDefaultAction() {
    if draft.action == nil { draft.action = draft.availableActions.first }
  }

  private func describe(_ error: any Error) -> String {
    switch error {
    case WatchDraftError.text(.empty): "Record an instruction first."
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
  @Environment(\.scenePhase) private var scenePhase
  @State private var model: ComposeModel
  @State private var recorder = VoiceRecorder()
  @State private var isTranscribing = false
  @State private var transcriptionError: String?
  @State private var transcriptionTask: Task<Void, Never>?
  private let thread: WatchThreadSummary

  init(thread: WatchThreadSummary) {
    self.thread = thread
    _model = State(initialValue: ComposeModel(thread: thread))
  }

  var body: some View {
    let actions = model.draft.availableActions.filter {
      app.capabilities?.actions.contains($0) ?? true
    }
    VStack(spacing: 10) {
      if recorder.isRecording {
        Button {
          recorder.stop()
          startTranscription()
        } label: {
          VStack(spacing: 5) {
            Image(systemName: "stop.fill").font(.system(size: 30))
            Text("Stop recording").font(.headline)
          }.frame(maxWidth: .infinity).padding(.vertical, 10)
        }
        .buttonStyle(.borderedProminent).tint(.red)
        Text(Duration.seconds(recorder.elapsed).formatted(.time(pattern: .minuteSecond)))
          .monospacedDigit()
        ProgressView(value: recorder.level).accessibilityLabel("Microphone level")
      } else if isTranscribing {
        ProgressView("Transcribing…").padding(.vertical, 20)
        Text("First use prepares the server’s speech model and may take a few minutes.")
          .font(.caption2).foregroundStyle(.secondary)
      } else if model.draft.text.isEmpty, recorder.fileURL != nil {
        Button("Transcribe recording", systemImage: "waveform") {
          startTranscription()
        }.buttonStyle(.borderedProminent)
        Text("Recording saved").font(.caption2).foregroundStyle(.secondary)
      } else if model.draft.text.isEmpty {
        Button {
          Task {
            guard let store = app.store else { return }
            do {
              try await store.saveDraft(model.draft)
              await recorder.start(draftId: model.draft.id)
            } catch {
              transcriptionError = "Could not save this recording. Try again."
            }
          }
        } label: {
          VStack(spacing: 5) {
            Image(systemName: "mic.fill").font(.system(size: 36))
            Text(recorder.isStarting ? "Starting…" : "Record").font(.headline)
          }.frame(maxWidth: .infinity).padding(.vertical, 10)
        }
        .buttonStyle(.borderedProminent)
        .disabled(recorder.isStarting || actions.isEmpty || app.store == nil)
      } else {
        Button {
          Task { await submit() }
        } label: {
          if model.isSubmitting {
            ProgressView()
          } else {
            Label(
              model.draft.action.map { "\($0.label) now" } ?? "Choose delivery",
              systemImage: "paperplane.fill")
          }
        }
        .buttonStyle(.borderedProminent)
        .disabled(
          model.isSubmitting || model.draft.action == nil || !actions.contains(model.draft.action!))
        Text(model.draft.text).frame(maxWidth: .infinity, alignment: .leading)
      }

      if let error = transcriptionError ?? recorder.error ?? model.error {
        Text(error).font(.caption2).foregroundStyle(.red)
      }
      if let notice = model.notice {
        Text(notice).font(.caption2).foregroundStyle(.orange)
      }
      if let action = model.draft.action {
        Text("Delivery: \(action.label)").font(.caption2).foregroundStyle(.secondary)
      }
      if actions.count > 1 {
        ForEach(actions, id: \.self) { action in
          Button {
            model.draft.action = action
          } label: {
            Label(
              action.label,
              systemImage: model.draft.action == action ? "checkmark.circle.fill" : "circle")
          }
          .disabled(recorder.isRecording || isTranscribing || model.isSubmitting)
        }
      }
      if model.draft.showsDisruptionWarning {
        Text("Steering may interrupt running tools.").font(.caption2).foregroundStyle(.secondary)
      }
      if !model.draft.text.isEmpty || recorder.fileURL != nil {
        Button("Discard", role: .destructive) {
          recorder.discard()
          model = ComposeModel(thread: thread)
          transcriptionError = nil
          Task { try? await app.store?.discardDraft(threadId: thread.threadId) }
        }.disabled(isTranscribing || model.isSubmitting)
      }
    }
    .task {
      await model.restore(from: app.store, current: thread)
      recorder.restore(draftId: model.draft.id)
      let available = model.draft.availableActions.filter {
        app.capabilities?.actions.contains($0) ?? true
      }
      if !available.contains(where: { $0 == model.draft.action }) {
        model.draft.action = available.first
      }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase != .active { recorder.stop() }
    }
    .onDisappear {
      transcriptionTask?.cancel()
      recorder.stop()
      Task { [model, store = app.store] in await model.save(to: store) }
    }
  }

  private func startTranscription() {
    guard transcriptionTask == nil else { return }
    transcriptionTask = Task {
      await transcribe()
      transcriptionTask = nil
    }
  }

  private func transcribe() async {
    guard !isTranscribing, let url = recorder.fileURL, let client = app.client else { return }
    isTranscribing = true
    transcriptionError = nil
    defer { isTranscribing = false }
    do {
      let text = try await client.transcribe(
        audio: Data(contentsOf: url), threadId: thread.threadId)
      try Task.checkCancellation()
      model.draft.text = text
      guard let store = app.store else { return }
      try await store.saveDraft(model.draft)
      recorder.discard()
    } catch {
      guard !Task.isCancelled else { return }
      transcriptionError = error.localizedDescription
      app.handle(error)
    }
  }

  private func submit() async {
    guard let client = app.client, let store = app.store else { return }
    guard let commandId = await model.finalize(client: client, store: store) else { return }
    if model.isClosed { model = ComposeModel(thread: thread) }
    app.path.append(.receipt(commandId: commandId))
  }
}
