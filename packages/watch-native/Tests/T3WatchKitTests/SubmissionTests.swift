import Foundation
import Testing

@testable import T3WatchKit

@Suite struct SubmissionStateMachineTests {
  let t0 = Date(timeIntervalSince1970: 1_791_761_140)
  let labels = WatchThreadLabels(environment: "shuvbot", project: "p", thread: "t")

  func submission(lifetime: TimeInterval = 90) -> Submission {
    let envelope = WatchCommandEnvelope(
      environmentId: Fixtures.environmentId, threadId: Fixtures.threadId, action: .steer,
      targetRunId: Fixtures.runId, expectedProviderInstanceId: "codex", text: "redirect",
      notAfter: t0.addingTimeInterval(lifetime))
    return Submission(envelope: envelope, labels: labels, now: t0)
  }

  var timeout: WatchClientError { .transport(code: URLError.timedOut.rawValue, description: "timed out") }

  @Test func startsPendingAndPostsEnvelope() {
    let s = submission()
    #expect(s.nextStep == .post(s.envelope))
    #expect(!s.isResolved)
  }

  @Test func acceptedReceiptResolves() throws {
    let s = submission()
    let receipt = try Fixtures.receipt(Fixtures.acceptedReceipt, commandId: s.id)
    let next = s.applying(.posted(receipt), now: t0)
    #expect(next.state == .receipt(receipt))
    #expect(next.isResolved && next.attempts == 1 && next.nextStep == .done)
  }

  @Test func rejectedReceiptResolves() throws {
    let s = submission()
    let receipt = try Fixtures.receipt(Fixtures.rejectedReceipt, commandId: s.id)
    #expect(s.applying(.posted(receipt), now: t0).state == .receipt(receipt))
  }

  @Test func timeoutIsUnknownThenLooksUpReceipt() {
    let next = submission().applying(.postFailed(timeout), now: t0)
    guard case .unknown(_, false) = next.state else {
      Issue.record("expected unknown, got \(next.state)")
      return
    }
    #expect(next.nextStep == .lookup(commandId: next.id))
    #expect(!next.isResolved)
  }

  @Test func unknownThenReceiptFound() throws {
    let s = submission().applying(.postFailed(timeout), now: t0)
    let receipt = try Fixtures.receipt(Fixtures.acceptedReceipt, commandId: s.id)
    #expect(s.applying(.receiptFound(receipt), now: t0.addingTimeInterval(5)).state == .receipt(receipt))
  }

  @Test func unknownThenMissingBeforeExpiryResubmitsSameEnvelope() {
    let original = submission()
    let s = original.applying(.postFailed(timeout), now: t0)
      .applying(.receiptMissing, now: t0.addingTimeInterval(10))
    #expect(s.state == .pending(lastError: nil))
    #expect(s.nextStep == .post(original.envelope))
    #expect(s.id == original.id)
  }

  @Test func unknownThenMissingAfterExpiryIsNotAdmitted() {
    let s = submission().applying(.postFailed(timeout), now: t0)
    let late = t0.addingTimeInterval(90 + Submission.expiryGrace)
    #expect(s.applying(.receiptMissing, now: late).state == .notAdmitted(.expired))
  }

  @Test func missingWithinGraceWindowWaits() {
    let s = submission().applying(.postFailed(timeout), now: t0)
    let justExpired = t0.addingTimeInterval(95)
    let next = s.applying(.receiptMissing, now: justExpired)
    #expect(next.state == s.state)
    #expect(next.retryAfter(now: justExpired) == s.envelope.notAfter.addingTimeInterval(Submission.expiryGrace))
  }

  @Test func conflictLooksUpOriginalReceipt() throws {
    let s = submission()
    var conflict = try Fixtures.receipt(Fixtures.rejectedReceipt, commandId: s.id)
    conflict.error = WatchCommandError(code: .commandConflict, message: "conflict")
    let afterConflict = s.applying(.posted(conflict), now: t0)
    #expect(afterConflict.state == .unknown(lastError: "command_conflict", conflict: true))
    #expect(afterConflict.nextStep == .lookup(commandId: s.id))

    let original = try Fixtures.receipt(Fixtures.acceptedReceipt, commandId: s.id)
    #expect(afterConflict.applying(.receiptFound(original), now: t0).state == .receipt(original))
    // A conflict never leads to a resend, even before expiry.
    guard case .unresolvable = afterConflict.applying(.receiptMissing, now: t0).state else {
      Issue.record("expected unresolvable")
      return
    }
  }

  @Test func undeliveredStaysPendingForSameEnvelope() {
    let offline = WatchClientError.transport(
      code: URLError.notConnectedToInternet.rawValue, description: "offline")
    let s = submission().applying(.postFailed(offline), now: t0)
    guard case .pending(let lastError?) = s.state else {
      Issue.record("expected pending with error")
      return
    }
    #expect(lastError == "offline")
    #expect(s.nextStep == .post(s.envelope))
  }

  @Test func requestErrorIsDefinitelyNotAdmitted() {
    let s = submission().applying(
      .postFailed(.request(code: .environmentMismatch, message: "mismatch")), now: t0)
    #expect(s.state == .notAdmitted(.refused(code: "environment_mismatch", message: "mismatch")))
  }

  @Test func serverErrorIsUnknown() {
    let s = submission().applying(.postFailed(.http(status: 502, bodyPrefix: "")), now: t0)
    guard case .unknown = s.state else {
      Issue.record("expected unknown")
      return
    }
  }

  @Test func lookupFailureStaysUnknown() {
    let s = submission().applying(.postFailed(timeout), now: t0)
      .applying(.lookupFailed(timeout), now: t0)
    guard case .unknown = s.state else {
      Issue.record("expected unknown")
      return
    }
  }

  @Test func ignoresEventsAfterResolution() throws {
    let s = submission()
    let receipt = try Fixtures.receipt(Fixtures.acceptedReceipt, commandId: s.id)
    let resolved = s.applying(.posted(receipt), now: t0)
    #expect(resolved.applying(.postFailed(timeout), now: t0) == resolved)
  }
}

@Suite struct SubmissionStoreTests {
  func tempDirectory() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  }

  func makeSubmission(threadId: String = Fixtures.threadId) -> Submission {
    let envelope = WatchCommandEnvelope(
      environmentId: Fixtures.environmentId, threadId: threadId, action: .queue,
      targetRunId: nil, expectedProviderInstanceId: nil, text: "later", notAfter: Date().addingTimeInterval(600))
    return Submission(envelope: envelope, labels: .init(environment: "e", project: nil, thread: "t"))
  }

  @Test func persistsAcrossInstances() async throws {
    let dir = tempDirectory()
    let s = makeSubmission()
    try await SubmissionStore(directory: dir).insert(s)
    let reopened = try SubmissionStore(directory: dir)
    #expect(await reopened.submission(id: s.id) == s)
  }

  @Test func blocksNewCommandWhileThreadHasUnresolvedOne() async throws {
    let store = try SubmissionStore(directory: tempDirectory())
    let first = makeSubmission()
    try await store.insert(first)
    await #expect(throws: SubmissionStoreError.unresolvedSubmission(commandId: first.id)) {
      try await store.insert(makeSubmission())
    }
    try await store.insert(makeSubmission(threadId: "thread:other"))

    var resolved = first
    resolved.state = .notAdmitted(.expired)
    try await store.update(resolved)
    try await store.insert(makeSubmission())
  }

  @Test func draftsSurviveRestart() async throws {
    let dir = tempDirectory()
    var draft = WatchDraft(thread: try Fixtures.summary(), text: "keep me")
    draft.action = .queue
    try await SubmissionStore(directory: dir).saveDraft(draft)
    let reopened = try SubmissionStore(directory: dir)
    #expect(await reopened.draft(threadId: Fixtures.threadId) == draft)
  }

  @Test func pruneKeepsUnresolved() async throws {
    let store = try SubmissionStore(directory: tempDirectory())
    let pending = makeSubmission()
    var done = makeSubmission(threadId: "thread:b")
    done.state = .notAdmitted(.expired)
    try await store.insert(pending)
    try await store.insert(done)
    try await store.prune(olderThan: 0, now: Date().addingTimeInterval(10))
    #expect(await store.submissions.map(\.id) == [pending.id])
  }
}
