import Foundation

/// Device-code pairing: the Watch shows a short code, the user approves it on the environment
/// (`t3 pair --watch --approve <code>`), and the Watch polls until it receives a one-time
/// `watch.…` bootstrap credential, which it exchanges like a manually entered one.
public struct PairingSession: Hashable, Sendable {
  /// An outstanding device code. Persisted so a relaunched app resumes polling the same code.
  public struct Pending: Codable, Hashable, Sendable {
    public var origin: URL
    public var deviceCode: String
    public var userCode: String
    public var expiresAt: Date
    public var interval: TimeInterval
    public var environment: WatchPairingEnvironment

    public init(origin: URL, start: WatchPairingStart) {
      self.origin = origin
      deviceCode = start.deviceCode
      userCode = start.userCode
      expiresAt = start.expiresAt
      interval = PairingSession.clampInterval(start.interval)
      environment = start.environment
    }

    /// Expiry on the Watch clock, allowing for skew. The server's `expired` answer still wins.
    public var deadline: Date { expiresAt.addingTimeInterval(PairingSession.expiryGrace) }
  }

  public enum State: Hashable, Sendable {
    case idle
    case starting(origin: URL)
    case waitingForApproval(Pending, nextPollAt: Date)
    /// Holds the one-time credential in memory only, until the exchange takes it.
    case approved(origin: URL, credential: String)
    case exchanging(origin: URL)
    case paired
    case denied
    case expired
    case failed(String)

    public var isTerminal: Bool {
      switch self {
      case .paired, .denied, .expired, .failed: true
      default: false
      }
    }

    public var isActive: Bool {
      switch self {
      case .starting, .waitingForApproval, .approved, .exchanging: true
      default: false
      }
    }
  }

  public enum Event: Hashable, Sendable {
    case start(origin: URL)
    case started(WatchPairingStart)
    case startFailed(WatchClientError)
    case polled(WatchPairingPoll)
    case pollFailed(WatchClientError)
    /// Re-evaluates expiry against the clock.
    case tick
    case exchangeBegan
    case exchanged
    case exchangeFailed(String)
    case cancel
  }

  public enum Step: Hashable, Sendable {
    case start(origin: URL)
    /// Wait until `at`, apply `.tick`, then poll if still waiting.
    case poll(origin: URL, deviceCode: String, at: Date)
    case exchange(origin: URL, credential: String)
    case done
  }

  public static let expiryGrace: TimeInterval = 10

  public var state: State

  public init(state: State = .idle) {
    self.state = state
  }

  /// Polls immediately: time may have passed while the app was not running.
  public init(resuming pending: Pending) {
    state = .waitingForApproval(pending, nextPollAt: .distantPast)
  }

  public var nextStep: Step {
    switch state {
    case .starting(let origin): .start(origin: origin)
    case .waitingForApproval(let pending, let nextPollAt):
      .poll(
        origin: pending.origin, deviceCode: pending.deviceCode,
        at: min(nextPollAt, pending.deadline))
    case .approved(let origin, let credential): .exchange(origin: origin, credential: credential)
    case .idle, .exchanging, .paired, .denied, .expired, .failed: .done
    }
  }

  public func applying(_ event: Event, now: Date) -> PairingSession {
    var next = self
    switch (state, event) {
    case (_, .cancel):
      next.state = .idle
    case (.idle, .start(let origin)), (.paired, .start(let origin)), (.denied, .start(let origin)),
      (.expired, .start(let origin)), (.failed, .start(let origin)):
      next.state = .starting(origin: origin)
    case (.starting(let origin), .started(let start)):
      let pending = Pending(origin: origin, start: start)
      next.state = .waitingForApproval(pending, nextPollAt: now.addingTimeInterval(pending.interval))
    case (.starting, .startFailed(let error)):
      next.state = .failed(Self.message(for: error))
    case (.waitingForApproval(let pending, _), .tick):
      if now >= pending.deadline { next.state = .expired }
    case (.waitingForApproval(var pending, _), .polled(let poll)):
      switch poll {
      case .approved(let credential, _):
        next.state = .approved(origin: pending.origin, credential: credential)
      case .denied:
        next.state = .denied
      case .expired:
        next.state = .expired
      case .pending where now >= pending.deadline, .slowDown where now >= pending.deadline:
        next.state = .expired
      case .pending:
        next.state = .waitingForApproval(pending, nextPollAt: now.addingTimeInterval(pending.interval))
      case .slowDown(let interval):
        pending.interval = Self.clampInterval(interval)
        next.state = .waitingForApproval(pending, nextPollAt: now.addingTimeInterval(pending.interval))
      }
    case (.waitingForApproval(let pending, _), .pollFailed(let error)):
      if !Self.isTransient(error) {
        next.state = .failed(Self.message(for: error))
      } else if now >= pending.deadline {
        next.state = .expired
      } else {
        next.state = .waitingForApproval(pending, nextPollAt: now.addingTimeInterval(pending.interval))
      }
    case (.approved(let origin, _), .exchangeBegan):
      next.state = .exchanging(origin: origin)
    case (.exchanging, .exchanged):
      next.state = .paired
    case (.exchanging, .exchangeFailed(let message)):
      next.state = .failed(message)
    default:
      return self
    }
    return next
  }

  static func clampInterval(_ interval: TimeInterval) -> TimeInterval {
    min(max(interval, 1), 60)
  }

  /// Network trouble and server restarts keep polling the same code until it expires.
  static func isTransient(_ error: WatchClientError) -> Bool {
    switch error {
    case .transport: true
    case .http(let status, _): status >= 500 || status == 408 || status == 429
    default: false
    }
  }

  public static func message(for error: WatchClientError) -> String {
    if case .request(let code, _) = error, code == .pairingNotFound {
      return "This pairing code is no longer valid. Pair again."
    }
    return error.localizedDescription
  }
}

/// File-backed in-progress pairing, in the same directory as `SubmissionStore`.
public actor PairingStore {
  public nonisolated let fileURL: URL
  public private(set) var pending: PairingSession.Pending?

  public init(directory: URL, fileName: String = "watch-pairing.json") throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    fileURL = directory.appendingPathComponent(fileName)
    pending = (try? Data(contentsOf: fileURL)).flatMap {
      try? JSONDecoder.watch.decode(PairingSession.Pending.self, from: $0)
    }
  }

  public static func applicationSupport() throws -> PairingStore {
    try PairingStore(directory: WatchStorage.directory())
  }

  public func save(_ pending: PairingSession.Pending) throws {
    try JSONEncoder.watch.encode(pending).write(to: fileURL, options: [.atomic])
    self.pending = pending
  }

  public func clear() throws {
    pending = nil
    if FileManager.default.fileExists(atPath: fileURL.path) {
      try FileManager.default.removeItem(at: fileURL)
    }
  }
}

/// Drives a `PairingSession` over the network. Results only ever feed the pure state machine.
public struct PairingRunner: Sendable {
  public var store: PairingStore?
  public var urlSession: URLSession
  public var transport: (any WatchHTTPTransport)?
  public var clientLabel: String
  public var clock: @Sendable () -> Date
  public var sleep: @Sendable (TimeInterval) async throws -> Void

  public init(
    store: PairingStore?,
    urlSession: URLSession = .shared,
    transport: (any WatchHTTPTransport)? = nil,
    clientLabel: String = "S2Code Watch",
    clock: @escaping @Sendable () -> Date = { Date() },
    sleep: @escaping @Sendable (TimeInterval) async throws -> Void = {
      try await Task.sleep(for: .seconds($0))
    }
  ) {
    self.store = store
    self.urlSession = urlSession
    self.transport = transport
    self.clientLabel = clientLabel
    self.clock = clock
    self.sleep = sleep
  }

  /// Runs until the session pairs or ends. Cancelling the task resets it to idle and forgets the
  /// code. `exchange` turns the approved credential into a stored session; `update` sees every
  /// state change.
  public func run(
    _ initial: PairingSession,
    exchange: @Sendable (URL, String) async throws -> Void,
    update: @Sendable (PairingSession.State) async -> Void
  ) async -> PairingSession {
    var session = initial
    var saved = await store?.pending
    await persist(session, saved: &saved)
    await update(session.state)
    while true {
      if Task.isCancelled { return await cancel(session, saved: &saved, update: update) }
      let event: PairingSession.Event
      switch session.nextStep {
      case .done:
        return session
      case .start(let origin):
        do throws(WatchClientError) {
          event = .started(
            try await WatchClient.startPairing(
              origin: origin, clientLabel: clientLabel, session: urlSession, transport: transport))
        } catch {
          event = .startFailed(error)
        }
      case .poll(let origin, let deviceCode, let at):
        let delay = at.timeIntervalSince(clock())
        if delay > 0 {
          do { try await sleep(delay) } catch {
            return await cancel(session, saved: &saved, update: update)
          }
        }
        if Task.isCancelled { return await cancel(session, saved: &saved, update: update) }
        let ticked = session.applying(.tick, now: clock())
        if ticked != session {
          session = ticked
          await persist(session, saved: &saved)
          await update(session.state)
          continue
        }
        do throws(WatchClientError) {
          event = .polled(
            try await WatchClient.pollPairing(
              origin: origin, deviceCode: deviceCode, session: urlSession, transport: transport))
        } catch {
          event = .pollFailed(error)
        }
      case .exchange(let origin, let credential):
        session = session.applying(.exchangeBegan, now: clock())
        await update(session.state)
        do {
          try await exchange(origin, credential)
          event = .exchanged
        } catch let error as WatchClientError {
          event = .exchangeFailed(PairingSession.message(for: error))
        } catch {
          event = .exchangeFailed(error.localizedDescription)
        }
      }
      session = session.applying(event, now: clock())
      await persist(session, saved: &saved)
      await update(session.state)
    }
  }

  private func cancel(
    _ session: PairingSession, saved: inout PairingSession.Pending?,
    update: @Sendable (PairingSession.State) async -> Void
  ) async -> PairingSession {
    let cancelled = session.applying(.cancel, now: clock())
    await persist(cancelled, saved: &saved)
    await update(cancelled.state)
    return cancelled
  }

  /// Keeps the outstanding code on disk through approval and exchange, so a relaunch mid-exchange
  /// learns from the server that the code was consumed instead of silently starting over.
  private func persist(_ session: PairingSession, saved: inout PairingSession.Pending?) async {
    guard let store else { return }
    switch session.state {
    case .waitingForApproval(let pending, _):
      if pending != saved {
        try? await store.save(pending)
        saved = pending
      }
    case .idle, .paired, .denied, .expired, .failed:
      if saved != nil {
        try? await store.clear()
        saved = nil
      }
    case .starting, .approved, .exchanging:
      break
    }
  }
}
