import Foundation
import Testing

@testable import T3WatchKit

@Suite struct ModelDecodingTests {
  @Test func decodesCapabilities() throws {
    let caps = try Fixtures.decode(WatchCapabilities.self, Fixtures.capabilities)
    #expect(caps.protocolVersion == 1)
    #expect(caps.actions == [.send, .queue, .steer])
    #expect(caps.limits.maxBodyBytes == 49_152)
    #expect(caps.features.nativeSteerOnly && !caps.features.steerFollowUp)
  }

  @Test func capabilitiesDropUnknownActions() throws {
    let json = Fixtures.capabilities.replacingOccurrences(
      of: "\"steer\"]", with: "\"steer\",\"interrupt\"]")
    #expect(try Fixtures.decode(WatchCapabilities.self, json).actions == [.send, .queue, .steer])
  }

  @Test func decodesThreadSummary() throws {
    let thread = try Fixtures.summary()
    #expect(thread.threadId == Fixtures.threadId)
    #expect(thread.activity == .running)
    #expect(thread.activeRunId == Fixtures.runId)
    #expect(thread.pendingAttention.runtimeRequest?.kind == "command")
    #expect(thread.pendingAttention.needsAttention)
    #expect(thread.labels.project == "shuv2code-nightly")
    #expect(WatchTimestamp.format(thread.updatedAt) == "2026-10-11T23:17:23.510Z")
  }

  @Test(arguments: ["unknown", "hibernating", ""])
  func unrecognizedActivityIsUnknownNotIdle(raw: String) throws {
    #expect(try Fixtures.summary(Fixtures.thread(activity: raw)).activity == .unknown)
  }

  @Test func decodesRolledBackActivity() throws {
    #expect(try Fixtures.summary(Fixtures.thread(activity: "rolled_back")).activity == .rolledBack)
  }

  @Test func decodesNullableFields() throws {
    let json = Fixtures.thread(activeRunId: nil)
      .replacingOccurrences(of: "\"projectId\":\"4e8c6d07-20d8-4c59-b4fe-19b9feac7ee1\"", with: "\"projectId\":null")
      .replacingOccurrences(of: "\"project\":\"shuv2code-nightly\"", with: "\"project\":null")
      .replacingOccurrences(
        of: "{\"id\":\"runtime-request:provider:codex:1\",\"kind\":\"command\",\"createdAt\":\"2026-10-11T23:23:31.376Z\"}",
        with: "null")
      .replacingOccurrences(of: "\"latestAssistantExcerpt\":\"I'll list the repository root…\"", with: "\"latestAssistantExcerpt\":null")
    let thread = try Fixtures.summary(json)
    #expect(thread.projectId == nil && thread.labels.project == nil)
    #expect(thread.activeRunId == nil && thread.latestAssistantExcerpt == nil)
    #expect(thread.pendingAttention.runtimeRequest == nil)
  }

  @Test func decodesPage() throws {
    let json = "{\"items\":[\(Fixtures.thread())],\"nextCursor\":\"abc\",\"snapshotRevision\":9}"
    let page = try Fixtures.decode(WatchThreadPage.self, json)
    #expect(page.items.count == 1 && page.nextCursor == "abc")
  }

  @Test func decodesAcceptedReceipt() throws {
    let receipt = try Fixtures.decode(WatchCommandReceipt.self, Fixtures.acceptedReceipt)
    #expect(receipt.status == .accepted)
    #expect(receipt.resultSequence == 278_523 && receipt.error == nil)
    #expect(receipt.acceptedAt.map(WatchTimestamp.format) == "2026-10-11T23:25:40.084Z")
  }

  @Test func decodesRejectedReceipt() throws {
    let receipt = try Fixtures.decode(WatchCommandReceipt.self, Fixtures.rejectedReceipt)
    #expect(receipt.status == .rejected && receipt.acceptedAt == nil)
    #expect(receipt.error?.code == .threadBusy)
  }

  @Test func decodesFailedReceiptAsCommittedButNotApplied() throws {
    let receipt = try Fixtures.decode(WatchCommandReceipt.self, Fixtures.failedReceipt)
    #expect(receipt.status == .failed)
    #expect(receipt.acceptedAt != nil && receipt.resultSequence != nil)
    #expect(receipt.error?.code == .staleTarget)
    #expect(receipt.observed?.activeRunId == nil)
  }

  @Test func rejectsInconsistentReceipt() {
    let json = Fixtures.acceptedReceipt.replacingOccurrences(of: "\"error\":null", with: "\"error\":{\"code\":\"expired\",\"message\":\"x\"}")
    #expect(throws: DecodingError.self) { try Fixtures.decode(WatchCommandReceipt.self, json) }
  }

  @Test func preservesUnknownErrorCodes() throws {
    let json = Fixtures.rejectedReceipt.replacingOccurrences(of: "thread_busy\"", with: "brand_new\"")
    #expect(try Fixtures.decode(WatchCommandReceipt.self, json).error?.code.rawValue == "brand_new")
  }

  @Test func receiptRoundTripsThroughPersistence() throws {
    let receipt = try Fixtures.decode(WatchCommandReceipt.self, Fixtures.failedReceipt)
    let data = try JSONEncoder.watch.encode(receipt)
    #expect(try JSONDecoder.watch.decode(WatchCommandReceipt.self, from: data) == receipt)
  }
}
