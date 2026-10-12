import Foundation
import Synchronization
import Testing

@testable import T3WatchKit

extension Fixtures {
  static let origin = URL(string: "http://127.0.0.1:13773")!
  static let pairingExpiresAt = WatchTimestamp.parse("2026-10-12T07:10:00.000Z")!
  static let pairingStart = """
    {"deviceCode":"dc-opaque-1","userCode":"ABCD-EFGH","expiresAt":"2026-10-12T07:10:00.000Z","interval":5,"environment":{"id":"\(environmentId)","label":"shuvbot"}}
    """
  static let pairingPending = "{\"status\":\"pending\"}"
  static let pairingSlowDown = "{\"status\":\"slow_down\",\"interval\":10}"
  static let pairingApproved =
    "{\"status\":\"approved\",\"credential\":\"watch.one-time\",\"expiresAt\":\"2026-10-12T07:15:00.000Z\"}"
  static let pairingNotFound = """
    {"_tag":"WatchRequestError","code":"pairing_not_found","message":"Unknown device code."}
    """
  static let pairingRateLimited = """
    {"_tag":"WatchRequestError","code":"pairing_rate_limited","message":"Too many pairing attempts."}
    """
}

@Suite struct PairingSessionTests {
  let t0 = Fixtures.pairingExpiresAt.addingTimeInterval(-300)

  func start() throws -> WatchPairingStart {
    try Fixtures.decode(WatchPairingStart.self, Fixtures.pairingStart)
  }

  func waiting() throws -> (PairingSession, PairingSession.Pending) {
    let session = PairingSession().applying(.start(origin: Fixtures.origin), now: t0)
      .applying(.started(try start()), now: t0)
    guard case .waitingForApproval(let pending, _) = session.state else {
      throw PairingTestError.unexpected(session.state)
    }
    return (session, pending)
  }

  func nextPoll(_ session: PairingSession) -> Date? {
    if case .poll(_, _, let at) = session.nextStep { return at }
    return nil
  }

  @Test func decodesEveryPollStatus() throws {
    #expect(try Fixtures.decode(WatchPairingPoll.self, Fixtures.pairingPending) == .pending)
    #expect(try Fixtures.decode(WatchPairingPoll.self, Fixtures.pairingSlowDown) == .slowDown(interval: 10))
    #expect(
      try Fixtures.decode(WatchPairingPoll.self, Fixtures.pairingApproved)
        == .approved(credential: "watch.one-time", expiresAt: WatchTimestamp.parse("2026-10-12T07:15:00.000Z")))
    #expect(try Fixtures.decode(WatchPairingPoll.self, "{\"status\":\"denied\"}") == .denied)
    #expect(try Fixtures.decode(WatchPairingPoll.self, "{\"status\":\"expired\"}") == .expired)
    #expect(throws: DecodingError.self) {
      try Fixtures.decode(WatchPairingPoll.self, "{\"status\":\"teleported\"}")
    }
  }

  @Test func idleStartsAndStepsToStart() {
    let session = PairingSession().applying(.start(origin: Fixtures.origin), now: t0)
    #expect(session.state == .starting(origin: Fixtures.origin))
    #expect(session.nextStep == .start(origin: Fixtures.origin))
    #expect(PairingSession().nextStep == .done)
  }

  @Test func startedWaitsOneIntervalBeforeFirstPoll() throws {
    let (session, pending) = try waiting()
    #expect(pending.userCode == "ABCD-EFGH" && pending.deviceCode == "dc-opaque-1")
    #expect(pending.environment == WatchPairingEnvironment(id: Fixtures.environmentId, label: "shuvbot"))
    #expect(pending.expiresAt == Fixtures.pairingExpiresAt && pending.interval == 5)
    #expect(session.nextStep == .poll(origin: Fixtures.origin, deviceCode: "dc-opaque-1", at: t0.addingTimeInterval(5)))
  }

  @Test func startFailureFails() {
    let session = PairingSession().applying(.start(origin: Fixtures.origin), now: t0)
      .applying(.startFailed(.request(code: .pairingRateLimited, message: "Too many")), now: t0)
    #expect(session.state == .failed("Too many (pairing_rate_limited)"))
    #expect(session.nextStep == .done)
  }

  @Test func pendingKeepsCadence() throws {
    let (session, _) = try waiting()
    let t1 = t0.addingTimeInterval(5)
    #expect(nextPoll(session.applying(.polled(.pending), now: t1)) == t1.addingTimeInterval(5))
  }

  @Test func slowDownBumpsCadenceForLaterPolls() throws {
    let (session, _) = try waiting()
    let t1 = t0.addingTimeInterval(5)
    let slowed = session.applying(.polled(.slowDown(interval: 10)), now: t1)
    #expect(nextPoll(slowed) == t1.addingTimeInterval(10))
    let t2 = t1.addingTimeInterval(10)
    #expect(nextPoll(slowed.applying(.polled(.pending), now: t2)) == t2.addingTimeInterval(10))
    let clamped = session.applying(.polled(.slowDown(interval: 0)), now: t1)
    #expect(nextPoll(clamped) == t1.addingTimeInterval(1))
  }

  @Test func approvedExchangesThenPairs() throws {
    let (session, _) = try waiting()
    let approved = session.applying(.polled(.approved(credential: "watch.one-time", expiresAt: nil)), now: t0)
    #expect(approved.state == .approved(origin: Fixtures.origin, credential: "watch.one-time"))
    #expect(approved.nextStep == .exchange(origin: Fixtures.origin, credential: "watch.one-time"))
    let exchanging = approved.applying(.exchangeBegan, now: t0)
    #expect(exchanging.state == .exchanging(origin: Fixtures.origin) && exchanging.nextStep == .done)
    #expect(exchanging.applying(.exchanged, now: t0).state == .paired)
    #expect(exchanging.applying(.exchangeFailed("Keychain"), now: t0).state == .failed("Keychain"))
  }

  @Test func deniedAndServerExpiryEnd() throws {
    let (session, _) = try waiting()
    #expect(session.applying(.polled(.denied), now: t0).state == .denied)
    #expect(session.applying(.polled(.expired), now: t0).state == .expired)
  }

  @Test func expiresOnClientClockAfterGrace() throws {
    let (session, pending) = try waiting()
    #expect(nextPoll(PairingSession(state: .waitingForApproval(pending, nextPollAt: .distantFuture))) == pending.deadline)
    let insideGrace = pending.expiresAt.addingTimeInterval(PairingSession.expiryGrace - 1)
    #expect(session.applying(.tick, now: insideGrace) == session)
    #expect(session.applying(.tick, now: pending.deadline).state == .expired)
    #expect(session.applying(.polled(.pending), now: pending.deadline).state == .expired)
    let offline = WatchClientError.transport(code: URLError.notConnectedToInternet.rawValue, description: "offline")
    #expect(session.applying(.pollFailed(offline), now: pending.deadline).state == .expired)
    // The server stays authoritative: a late approval still pairs.
    guard case .approved = session.applying(.polled(.approved(credential: "watch.x", expiresAt: nil)), now: pending.deadline).state else {
      Issue.record("expected approved")
      return
    }
  }

  @Test func transientPollFailureKeepsPolling() throws {
    let (session, _) = try waiting()
    let t1 = t0.addingTimeInterval(5)
    let offline = WatchClientError.transport(code: URLError.networkConnectionLost.rawValue, description: "lost")
    #expect(nextPoll(session.applying(.pollFailed(offline), now: t1)) == t1.addingTimeInterval(5))
    #expect(nextPoll(session.applying(.pollFailed(.http(status: 502, bodyPrefix: "")), now: t1)) == t1.addingTimeInterval(5))
  }

  @Test func consumedCodeFailsWithStartOverMessage() throws {
    let (session, _) = try waiting()
    let failed = session.applying(.pollFailed(.request(code: .pairingNotFound, message: "Unknown device code.")), now: t0)
    #expect(failed.state == .failed("This pairing code is no longer valid. Pair again."))
    #expect(failed.state.isTerminal)
  }

  @Test func cancelReturnsToIdleFromAnyState() throws {
    let (session, _) = try waiting()
    #expect(session.applying(.cancel, now: t0).state == .idle)
    #expect(PairingSession(state: .exchanging(origin: Fixtures.origin)).applying(.cancel, now: t0).state == .idle)
  }

  @Test func terminalStatesCanStartOverButIgnoreStrayEvents() {
    for terminal: PairingSession.State in [.paired, .denied, .expired, .failed("x")] {
      let session = PairingSession(state: terminal)
      #expect(session.applying(.polled(.pending), now: t0) == session)
      #expect(session.applying(.start(origin: Fixtures.origin), now: t0).state == .starting(origin: Fixtures.origin))
    }
  }

  @Test func resumePollsImmediately() throws {
    let (_, pending) = try waiting()
    let resumed = PairingSession(resuming: pending)
    #expect(resumed.nextStep == .poll(origin: Fixtures.origin, deviceCode: "dc-opaque-1", at: .distantPast))
  }
}

enum PairingTestError: Error {
  case unexpected(PairingSession.State)
}

@Suite struct PairingStoreTests {
  @Test func persistsAcrossInstancesAndClears() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let pending = PairingSession.Pending(
      origin: Fixtures.origin, start: try Fixtures.decode(WatchPairingStart.self, Fixtures.pairingStart))
    try await PairingStore(directory: dir).save(pending)
    let reopened = try PairingStore(directory: dir)
    #expect(await reopened.pending == pending)
    try await reopened.clear()
    #expect(try await PairingStore(directory: dir).pending == nil)
  }
}

final class Recorder<Value: Sendable>: Sendable {
  private let values = Mutex<[Value]>([])
  func append(_ value: Value) { values.withLock { $0.append(value) } }
  var all: [Value] { values.withLock { $0 } }
}

extension ClientTests {
  func jsonObject(_ data: Data?) throws -> NSDictionary {
    let body = try #require(data)
    return try #require(try JSONSerialization.jsonObject(with: body) as? NSDictionary)
  }

  @Test func startPairingPostsUnauthenticatedJSON() async throws {
    StubURLProtocol.install { _ in .json(200, Fixtures.pairingStart) }
    let start = try await WatchClient.startPairing(
      origin: URL(string: "http://127.0.0.1:13773/")!, session: StubURLProtocol.session())
    #expect(start.userCode == "ABCD-EFGH" && start.interval == 5)
    let request = try #require(StubURLProtocol.requests.first)
    #expect(request.method == "POST" && request.url == "http://127.0.0.1:13773/api/watch/v1/pairing/start")
    #expect(request.headers["Authorization"] == nil)
    #expect(request.headers["Content-Type"] == "application/json")
    #expect(try jsonObject(request.body) == ["protocolVersion": 1, "clientLabel": "T3 Watch"])
  }

  @Test func pollPairingPostsDeviceCode() async throws {
    StubURLProtocol.install { _ in .json(200, Fixtures.pairingSlowDown) }
    let poll = try await WatchClient.pollPairing(
      origin: Fixtures.origin, deviceCode: "dc-opaque-1", session: StubURLProtocol.session())
    #expect(poll == .slowDown(interval: 10))
    let request = try #require(StubURLProtocol.requests.first)
    #expect(request.url == "http://127.0.0.1:13773/api/watch/v1/pairing/token")
    #expect(request.headers["Authorization"] == nil)
    #expect(try jsonObject(request.body) == ["protocolVersion": 1, "deviceCode": "dc-opaque-1"])
  }

  @Test func pairingErrorsDecodeByCode() async throws {
    StubURLProtocol.install { _ in .json(400, Fixtures.pairingRateLimited) }
    await #expect(throws: WatchClientError.request(code: .pairingRateLimited, message: "Too many pairing attempts.")) {
      try await WatchClient.startPairing(origin: Fixtures.origin, session: StubURLProtocol.session())
    }
  }

  func makeRunner(dir: URL, clock: StubClock, sleeps: Recorder<TimeInterval>) throws -> PairingRunner {
    PairingRunner(
      store: try PairingStore(directory: dir), urlSession: StubURLProtocol.session(),
      clock: { clock.now },
      sleep: { seconds in
        sleeps.append(seconds)
        clock.advance(seconds)
      })
  }

  @Test func runnerPairsHonouringSlowDown() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let clock = StubClock(Fixtures.pairingExpiresAt.addingTimeInterval(-300))
    let sleeps = Recorder<TimeInterval>()
    let exchanged = Recorder<String>()
    let states = Recorder<PairingSession.State>()
    let replies = StubCounter()
    StubURLProtocol.install { request in
      if request.url.hasSuffix("/pairing/start") { return .json(200, Fixtures.pairingStart) }
      switch replies.increment() {
      case 1: return .json(200, Fixtures.pairingPending)
      case 2: return .json(200, Fixtures.pairingSlowDown)
      default: return .json(200, Fixtures.pairingApproved)
      }
    }
    let runner = try makeRunner(dir: dir, clock: clock, sleeps: sleeps)
    let result = await runner.run(
      PairingSession().applying(.start(origin: Fixtures.origin), now: clock.now),
      exchange: { origin, credential in
        #expect(origin == Fixtures.origin)
        #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("watch-pairing.json").path))
        exchanged.append(credential)
      },
      update: { states.append($0) })
    #expect(result.state == .paired)
    #expect(sleeps.all == [5, 5, 10])
    #expect(exchanged.all == ["watch.one-time"])
    #expect(states.all.last == .paired)
    #expect(try await PairingStore(directory: dir).pending == nil)
  }

  @Test func runnerResumesPersistedCodeAfterRelaunch() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let pending = PairingSession.Pending(
      origin: Fixtures.origin, start: try Fixtures.decode(WatchPairingStart.self, Fixtures.pairingStart))
    try await PairingStore(directory: dir).save(pending)

    let relaunched = try PairingStore(directory: dir)
    let saved = try #require(await relaunched.pending)
    let clock = StubClock(Fixtures.pairingExpiresAt.addingTimeInterval(-60))
    let sleeps = Recorder<TimeInterval>()
    StubURLProtocol.install { _ in .json(200, Fixtures.pairingApproved) }
    let runner = PairingRunner(
      store: relaunched, urlSession: StubURLProtocol.session(), clock: { clock.now },
      sleep: { sleeps.append($0) })
    let result = await runner.run(PairingSession(resuming: saved), exchange: { _, _ in }, update: { _ in })
    #expect(result.state == .paired)
    #expect(sleeps.all.isEmpty)
    #expect(StubURLProtocol.requests.map(\.url) == ["http://127.0.0.1:13773/api/watch/v1/pairing/token"])
    #expect(await relaunched.pending == nil)
  }

  @Test func runnerFailsWhenApprovalWasAlreadyConsumed() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let clock = StubClock(Fixtures.pairingExpiresAt.addingTimeInterval(-300))
    let polls = StubCounter()
    StubURLProtocol.install { request in
      if request.url.hasSuffix("/pairing/start") { return .json(200, Fixtures.pairingStart) }
      // The `approved` reply was lost in transit; the server already consumed the code.
      return polls.increment() == 1 ? .failure(.networkConnectionLost) : .json(400, Fixtures.pairingNotFound)
    }
    let exchanged = Recorder<String>()
    let runner = try makeRunner(dir: dir, clock: clock, sleeps: Recorder())
    let result = await runner.run(
      PairingSession().applying(.start(origin: Fixtures.origin), now: clock.now),
      exchange: { _, credential in exchanged.append(credential) }, update: { _ in })
    #expect(result.state == .failed("This pairing code is no longer valid. Pair again."))
    #expect(exchanged.all.isEmpty)
    #expect(try await PairingStore(directory: dir).pending == nil)
  }

  @Test func runnerCancelForgetsCode() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let clock = StubClock(Fixtures.pairingExpiresAt.addingTimeInterval(-300))
    StubURLProtocol.install { _ in .json(200, Fixtures.pairingStart) }
    let runner = PairingRunner(
      store: try PairingStore(directory: dir), urlSession: StubURLProtocol.session(),
      clock: { clock.now }, sleep: { _ in throw CancellationError() })
    let result = await runner.run(
      PairingSession().applying(.start(origin: Fixtures.origin), now: clock.now),
      exchange: { _, _ in }, update: { _ in })
    #expect(result.state == .idle)
    #expect(try await PairingStore(directory: dir).pending == nil)
  }
}
