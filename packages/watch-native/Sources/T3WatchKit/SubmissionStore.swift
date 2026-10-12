import Foundation

/// The app's file stores (submissions, snapshot cache, in-progress pairing) share one directory.
public enum WatchStorage {
  public static func directory() throws -> URL {
    let base = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    return base.appendingPathComponent("T3Watch", isDirectory: true)
  }
}

public enum SubmissionStoreError: Error, Hashable, Sendable {
  /// An earlier command for this thread is still unresolved; resolve it before sending a new one.
  case unresolvedSubmission(commandId: String)
  case unknownSubmission(commandId: String)
}

/// File-backed JSON store for drafts and submissions. Every mutation is written atomically before
/// it returns, so a submission exists on disk before its first network attempt.
public actor SubmissionStore {
  private struct Snapshot: Codable {
    var submissions: [Submission] = []
    var drafts: [WatchDraft] = []
  }

  public nonisolated let fileURL: URL
  private var snapshot: Snapshot

  public init(directory: URL, fileName: String = "watch-submissions.json") throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    fileURL = directory.appendingPathComponent(fileName)
    if let data = try? Data(contentsOf: fileURL) {
      snapshot = try JSONDecoder.watch.decode(Snapshot.self, from: data)
    } else {
      snapshot = Snapshot()
    }
  }

  public static func applicationSupport() throws -> SubmissionStore {
    try SubmissionStore(directory: WatchStorage.directory())
  }

  public var submissions: [Submission] { snapshot.submissions }

  public func submission(id: String) -> Submission? {
    snapshot.submissions.first { $0.id == id }
  }

  public func unresolved(environmentId: String, threadId: String) -> Submission? {
    snapshot.submissions.first {
      !$0.isResolved && $0.envelope.environmentId == environmentId
        && $0.envelope.threadId == threadId
    }
  }

  public func insert(_ submission: Submission) throws {
    if let existing = unresolved(
      environmentId: submission.envelope.environmentId, threadId: submission.envelope.threadId)
    {
      throw SubmissionStoreError.unresolvedSubmission(commandId: existing.id)
    }
    snapshot.submissions.append(submission)
    try persist()
  }

  public func update(_ submission: Submission) throws {
    guard let index = snapshot.submissions.firstIndex(where: { $0.id == submission.id }) else {
      throw SubmissionStoreError.unknownSubmission(commandId: submission.id)
    }
    snapshot.submissions[index] = submission
    try persist()
  }

  /// Drops resolved submissions older than `age`; unresolved ones are always kept.
  public func prune(olderThan age: TimeInterval, now: Date = Date()) throws {
    let cutoff = now.addingTimeInterval(-age)
    snapshot.submissions.removeAll { $0.isResolved && $0.updatedAt < cutoff }
    try persist()
  }

  public func draft(threadId: String) -> WatchDraft? {
    snapshot.drafts.first { $0.target.threadId == threadId }
  }

  public func saveDraft(_ draft: WatchDraft) throws {
    snapshot.drafts.removeAll { $0.target.threadId == draft.target.threadId }
    snapshot.drafts.append(draft)
    try persist()
  }

  public func discardDraft(threadId: String) throws {
    snapshot.drafts.removeAll { $0.target.threadId == threadId }
    try persist()
  }

  private func persist() throws {
    try JSONEncoder.watch.encode(snapshot).write(to: fileURL, options: [.atomic])
  }
}

/// Drives submissions through the client. Network results only ever feed the pure state machine.
public actor SubmissionCoordinator {
  public nonisolated let store: SubmissionStore
  private let client: WatchClient
  private let clock: @Sendable () -> Date

  public init(
    store: SubmissionStore, client: WatchClient, clock: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.store = store
    self.client = client
    self.clock = clock
  }

  /// Persists the envelope, then attempts delivery.
  @discardableResult
  public func submit(_ envelope: WatchCommandEnvelope, labels: WatchThreadLabels) async throws
    -> Submission
  {
    let submission = Submission(envelope: envelope, labels: labels, now: clock())
    try await store.insert(submission)
    return try await drive(id: submission.id)
  }

  /// Advances one submission until it resolves or needs to wait. Bounded so a flapping network
  /// cannot loop forever; callers re-drive on refresh or launch. Concurrent calls for the same
  /// command join the in-flight drive so a stale result can never overwrite a newer state.
  @discardableResult
  public func drive(id: String, maxSteps: Int = 4) async throws -> Submission {
    if let running = inFlight[id] { return try await running.value }
    let task = Task { try await self.advance(id: id, maxSteps: maxSteps) }
    inFlight[id] = task
    defer { inFlight[id] = nil }
    return try await task.value
  }

  private var inFlight: [String: Task<Submission, any Error>] = [:]

  private func advance(id: String, maxSteps: Int) async throws -> Submission {
    guard var submission = await store.submission(id: id) else {
      throw SubmissionStoreError.unknownSubmission(commandId: id)
    }
    for _ in 0..<maxSteps {
      let event: Submission.Event
      switch submission.nextStep {
      case .done:
        return submission
      case .post(let envelope):
        do throws(WatchClientError) {
          event = .posted(try await client.submit(envelope))
        } catch {
          event = .postFailed(error)
        }
      case .lookup(let commandId):
        do throws(WatchClientError) {
          event = .receiptFound(try await client.receipt(commandId: commandId))
        } catch {
          // The receipt route reports a missing receipt with the thread-not-found code.
          event = isReceiptMissing(error) ? .receiptMissing : .lookupFailed(error)
        }
      }
      let next = submission.applying(event, now: clock())
      try await store.update(next)
      let madeProgress = next.state != submission.state
      submission = next
      if !madeProgress { return submission }
      if case .pending(let lastError?) = submission.state, !lastError.isEmpty { return submission }
    }
    return submission
  }

  private func isReceiptMissing(_ error: WatchClientError) -> Bool {
    if case .request(let code, _) = error { return code == .receiptNotFound }
    return false
  }

  /// Re-drives every unresolved submission, e.g. on launch or resume.
  public func reconcileAll() async {
    for submission in await store.submissions where !submission.isResolved {
      _ = try? await drive(id: submission.id)
    }
  }
}
