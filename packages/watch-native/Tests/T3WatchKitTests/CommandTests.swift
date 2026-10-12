import Foundation
import Testing

@testable import T3WatchKit

@Suite struct TimestampTests {
  @Test func formatsMillisecondUTC() {
    let date = Date(timeIntervalSince1970: 1_791_761_140.084)
    #expect(WatchTimestamp.format(date) == "2026-10-11T23:25:40.084Z")
  }

  @Test func parseFormatRoundTripIsStable() throws {
    for string in ["2026-10-11T23:25:40.084Z", "2026-10-11T23:17:23.510Z", "1999-12-31T23:59:59.999Z"] {
      let date = try #require(WatchTimestamp.parse(string))
      #expect(WatchTimestamp.format(date) == string)
    }
  }

  @Test func parsesWithoutFraction() throws {
    let date = try #require(WatchTimestamp.parse("2026-10-11T23:25:40Z"))
    #expect(WatchTimestamp.format(date) == "2026-10-11T23:25:40.000Z")
  }
}

@Suite struct EnvelopeTests {
  let commandId = UUID(uuidString: "3BA6FAEE-66A3-44A1-84A1-E10C6FD83334")!
  let messageId = UUID(uuidString: "0D2C8A3E-1F6B-4F0E-9C4D-2B7A5E9F1C3D")!

  func envelope(action: WatchAction, notAfter: Date = Date(timeIntervalSince1970: 1_791_761_140.0844))
    -> WatchCommandEnvelope
  {
    WatchCommandEnvelope(
      commandId: commandId, messageId: messageId, environmentId: Fixtures.environmentId,
      threadId: Fixtures.threadId, action: action, targetRunId: Fixtures.runId,
      expectedProviderInstanceId: "codex", text: "Fix the tests first.", notAfter: notAfter)
  }

  @Test func encodesSteerEnvelope() throws {
    let json = try #require(
      JSONSerialization.jsonObject(with: envelope(action: .steer).encodedBody()) as? [String: Any])
    #expect(json["protocolVersion"] as? Int == 1)
    #expect(json["commandId"] as? String == "3ba6faee-66a3-44a1-84a1-e10c6fd83334")
    #expect(json["messageId"] as? String == "0d2c8a3e-1f6b-4f0e-9c4d-2b7a5e9f1c3d")
    #expect(json["action"] as? String == "steer")
    #expect(json["targetRunId"] as? String == Fixtures.runId)
    #expect(json["threadId"] as? String == Fixtures.threadId)
    #expect(json["expectedProviderInstanceId"] as? String == "codex")
    #expect(json["notAfter"] as? String == "2026-10-11T23:25:40.084Z")
    #expect(json.count == 10)
  }

  @Test(arguments: [WatchAction.send, .queue])
  func omitsTargetRunForSendAndQueue(action: WatchAction) throws {
    let json = try #require(
      JSONSerialization.jsonObject(with: envelope(action: action).encodedBody()) as? [String: Any])
    #expect(json["targetRunId"] == nil)
    #expect(json.keys.contains("targetRunId") == false)
  }

  @Test func persistedEnvelopeReplaysByteIdentically() throws {
    let original = envelope(action: .steer)
    let body = try original.encodedBody()
    let restored = try JSONDecoder.watch.decode(WatchCommandEnvelope.self, from: body)
    #expect(restored == original)
    #expect(try restored.encodedBody() == body)
    #expect(String(decoding: body, as: UTF8.self).contains("run:thread:thread%3Aproject"))
  }
}

@Suite struct TextLimitTests {
  @Test func acceptsLimits() throws {
    try WatchText.validate(String(repeating: "a", count: 8_000))
    try WatchText.validate(String(repeating: "\u{E9}", count: 8_000))
  }

  @Test func rejectsEmpty() {
    #expect(throws: WatchTextError.empty) { try WatchText.validate("  \n ") }
  }

  @Test func countsScalarsNotCharacters() {
    // One flag grapheme is two scalars.
    let flags = String(repeating: "🇺🇸", count: 4_001)
    #expect(throws: WatchTextError.tooManyScalars(count: 8_002)) { try WatchText.validate(flags) }
  }

  /// 8000 scalars × 4 UTF-8 bytes = 32 000 < 32 KiB, so the scalar limit always binds first.
  @Test func maximalUTF8WithinScalarLimitFitsByteLimit() throws {
    try WatchText.validate(String(repeating: "😀", count: 8_000))
    #expect(throws: WatchTextError.tooManyScalars(count: 8_001)) {
      try WatchText.validate(String(repeating: "😀", count: 8_001))
    }
  }
}

@Suite struct AdmissionTests {
  @Test func idleThreadOffersSendOnly() throws {
    let thread = try Fixtures.summary(Fixtures.thread(activity: "idle", activeRunId: nil))
    #expect(WatchAdmissionRules.availableActions(for: thread) == [.send])
  }

  @Test func activeRunDecidesEvenWhenActivityLooksIdle() throws {
    let busy = try Fixtures.summary(Fixtures.thread(activity: "unknown"))
    #expect(WatchAdmissionRules.availableActions(for: busy) == [.steer, .queue])
    let finishing = try Fixtures.summary(Fixtures.thread(activity: "running", activeRunId: nil))
    #expect(WatchAdmissionRules.availableActions(for: finishing) == [.send])
  }

  @Test func steerRequiresNativeSupport() throws {
    let thread = try Fixtures.summary(Fixtures.thread(supportsSteering: false))
    #expect(WatchAdmissionRules.availableActions(for: thread) == [.queue])
  }

  @Test func readOnlyThreadsOfferNothing() throws {
    let thread = try Fixtures.summary(Fixtures.thread(isReadOnly: true))
    #expect(WatchAdmissionRules.availableActions(for: thread).isEmpty)
  }

  @Test func filtersByServerActions() throws {
    let thread = try Fixtures.summary()
    #expect(WatchAdmissionRules.availableActions(for: thread, serverActions: [.send, .queue]) == [.queue])
  }

  @Test func warnsWhenSteeringInterruptsTools() throws {
    let thread = try Fixtures.summary(Fixtures.thread(interruptsTools: true))
    #expect(WatchAdmissionRules.disruptionWarning(for: .steer, thread: thread))
    #expect(!WatchAdmissionRules.disruptionWarning(for: .queue, thread: thread))
    var draft = WatchDraft(thread: thread)
    draft.action = .steer
    #expect(draft.showsDisruptionWarning)
  }
}

@Suite struct DraftTests {
  let now = Date(timeIntervalSince1970: 1_791_761_140)

  @Test func freezesTargetAndBuildsSteerEnvelope() throws {
    var draft = WatchDraft(thread: try Fixtures.summary(), text: "Stop editing UI.", now: now)
    draft.action = .steer
    let envelope = try draft.makeEnvelope(now: now)
    #expect(envelope.targetRunId == Fixtures.runId)
    #expect(envelope.expectedProviderInstanceId == "codex")
    #expect(envelope.notAfter == now.addingTimeInterval(90))
    #expect(envelope.commandId == envelope.commandId.lowercased())
  }

  @Test func sendAndQueueGetLongerLifetime() throws {
    var draft = WatchDraft(thread: try Fixtures.summary(), text: "Then run lint.", now: now)
    draft.action = .queue
    let envelope = try draft.makeEnvelope(now: now, queueLifetime: 600)
    #expect(envelope.notAfter == now.addingTimeInterval(600))
    #expect(envelope.targetRunId == nil)
  }

  @Test func requiresChosenAvailableAction() throws {
    var draft = WatchDraft(thread: try Fixtures.summary(), text: "hi", now: now)
    #expect(throws: WatchDraftError.noActionChosen) { try draft.makeEnvelope(now: now) }
    draft.action = .send
    #expect(throws: WatchDraftError.actionUnavailable(.send)) { try draft.makeEnvelope(now: now) }
  }

  @Test func unchangedRunKeepsAction() throws {
    var draft = WatchDraft(thread: try Fixtures.summary(), text: "x", now: now)
    draft.action = .steer
    var fresh = try Fixtures.summary()
    fresh.snapshotRevision += 10
    fresh.labels.thread = "Renamed"
    #expect(try draft.revalidate(against: fresh) == .unchanged)
  }

  @Test func runChangeKeepsTextButClearsAction() throws {
    var draft = WatchDraft(thread: try Fixtures.summary(), text: "Redirect please", now: now)
    draft.action = .steer
    let fresh = try Fixtures.summary(Fixtures.thread(activeRunId: Fixtures.runId + "2"))
    guard case .targetChanged(let rebased) = try draft.revalidate(against: fresh) else {
      Issue.record("expected targetChanged")
      return
    }
    #expect(rebased.text == "Redirect please" && rebased.action == nil)
    #expect(rebased.target.activeRunId == Fixtures.runId + "2")
    #expect(rebased.target.labels.thread == "Watch E2E smoke")
    #expect(rebased.id == draft.id)
  }

  @Test func providerChangeRequiresFreshChoice() throws {
    var draft = WatchDraft(thread: try Fixtures.summary(), text: "x", now: now)
    draft.action = .queue
    let fresh = try Fixtures.summary(Fixtures.thread(providerInstanceId: "claude"))
    guard case .targetChanged(let rebased) = try draft.revalidate(against: fresh) else {
      Issue.record("expected targetChanged")
      return
    }
    #expect(rebased.action == nil)
  }

  @Test func neverRetargetsAnotherThread() throws {
    let draft = WatchDraft(thread: try Fixtures.summary(), text: "x", now: now)
    var other = try Fixtures.summary()
    other.threadId = "thread:other"
    #expect(throws: WatchDraftError.differentThread) { try draft.revalidate(against: other) }
  }
}
